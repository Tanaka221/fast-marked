// fast-marked: a fast, dependency-free Markdown parser producing
// byte-identical output to marked 18.1.3 (default options: gfm, no breaks,
// no pedantic, sync). Written from scratch for the make.fun
// markdown-render-speed-02 bounty. Export: parse(markdown) -> HTML string.

// Document-level "inside a link" flag, mirroring marked's Lexer state:
// an <a ...> tag met during inline parsing sets it, </a> clears it, and
// it persists across paragraphs (so a bare email/www/scheme autolink
// after an unclosed <a> in an earlier paragraph is not formed).
// Explicit <...> autolinks are NOT suppressed by it.
let docInLink = false;
// When true, block parsing collects link reference definitions but
// skips inline rendering (the first pass of parseBlocks discards its
// HTML; only the refs map matters). This makes the first pass cheap.
let collectOnly = false;

export function parse(src) {
  docInLink = false;
  return parseBlocks(src);
}

// ---------------------------------------------------------------------------
// Character helpers and escaping
// ---------------------------------------------------------------------------

const ESC = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

// Entity-aware escape: & < > " ' are escaped, except that an & starting a
// valid entity reference (&name; &#123; &#x1F600;) is kept verbatim.
const ENT_RE = /&(#\d{1,7};|#[Xx][0-9A-Fa-f]{1,6};|[A-Za-z0-9_]+;)|[&<>"']/g;
function esc(s) {
  return s.replace(ENT_RE, (m, ent) => (ent ? '&' + ent : ESC[m]));
}

// Plain escape for code content: every & < > " ' is escaped, entities
// included (&copy; becomes &amp;copy;).
const ESC_PLAIN_RE = /[&<>"']/g;
function escPlain(s) {
  return s.replace(ESC_PLAIN_RE, (c) => ESC[c]);
}

// Encode a link/image destination the way marked does: encodeURI, then
// restore %25 to %, then entity-aware escape. Returns null when encodeURI
// throws (lone surrogate), which makes the link fail.
function encodeHref(dest) {
  let u;
  try {
    u = encodeURI(dest);
  } catch {
    return null;
  }
  return esc(u.replace(/%25/g, '%'));
}

// Parse a numeric character reference at src[i] ('&' + '#'). Returns
// [decodedChar, lengthConsumed] or null. 0, >0x10FFFF and surrogates map
// to U+FFFD. Decimal allows up to 7 digits, hex up to 6.
function numericEntity(src, i) {
  if (src.charCodeAt(i + 1) !== 35) return null; // '#'
  let j = i + 2;
  let hex = false;
  const xc = src.charCodeAt(j);
  if (xc === 88 || xc === 120) {
    hex = true;
    j++;
  }
  let code = 0;
  let digits = 0;
  while (j < src.length) {
    const c = src.charCodeAt(j);
    let d = -1;
    if (c >= 48 && c <= 57) d = c - 48;
    else if (hex && c >= 65 && c <= 70) d = c - 55;
    else if (hex && c >= 97 && c <= 102) d = c - 87;
    else break;
    code = code * (hex ? 16 : 10) + d;
    digits++;
    if (hex ? digits > 6 : digits > 7) return null;
    j++;
  }
  if (digits === 0) return null;
  if (j >= src.length || src.charCodeAt(j) !== 59) return null; // ';'
  if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
    code = 0xfffd;
  }
  return [String.fromCodePoint(code), j + 1 - i];
}

// ASCII punctuation: ! " # $ % & ' ( ) * + , - . / : ; < = > ? @ [ \ ] ^
// _ ` { | } ~
function isAsciiPunct(c) {
  return (
    (c >= 33 && c <= 47) ||
    (c >= 58 && c <= 64) ||
    (c >= 91 && c <= 96) ||
    (c >= 123 && c <= 126)
  );
}

// Unicode punctuation (CommonMark: general categories P and S).
const PUNCT_RE = /[\p{P}\p{S}]/u;
function isPunctCh(ch) {
  return ch !== '' && PUNCT_RE.test(ch);
}

const WS_RE = /\s/;
function isWsCh(ch) {
  return (
    ch === ' ' ||
    ch === '\t' ||
    ch === '\n' ||
    ch === '\r' ||
    ch === '\f' ||
    ch === '\v' ||
    WS_RE.test(ch)
  );
}

function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

// Blank for table-body purposes: only spaces (or empty). A line
// containing a tab is a table body row, not a blank line.
function isTableBlank(line) {
  for (let i = 0; i < line.length; i++) {
    if (line.charCodeAt(i) !== 32) return false;
  }
  return true;
}

// Indent of a line in columns; a tab advances to the next multiple of 4.
function lineIndent(line) {
  let col = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c === 32) col++;
    else if (c === 9) col += 4 - (col % 4);
    else break;
  }
  return col;
}

// Expand leading tabs to spaces, given the column the line starts at.
// A tab advances to the next multiple of 4. Only leading whitespace is
// expanded; tabs after the first non-whitespace character are untouched.
function expandLeadingTabs(line, startCol) {
  let col = startCol || 0;
  let i = 0;
  let out = '';
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (c === 32) {
      out += ' ';
      col++;
      i++;
    } else if (c === 9) {
      const w = 4 - (col % 4);
      out += ' '.repeat(w);
      col += w;
      i++;
    } else break;
  }
  return out + line.slice(i);
}

// Remove up to n columns of leading indent. A tab that straddles the
// cut is removed entirely (marked drops the whole tab, it does not
// turn the part beyond the cut into spaces: '  ```\n\tfoo' yields
// 'foo', not '  foo'). A tab that starts at or beyond the cut is kept
// as a tab (it is part of the content, e.g. indented code
// '    \tfoo' strips to '\tfoo', not '    foo').
function stripColumns(line, n) {
  if (n <= 0) return line;
  let col = 0;
  let i = 0;
  while (i < line.length && col < n) {
    const c = line.charCodeAt(i);
    if (c === 32) {
      col++;
      i++;
    } else if (c === 9) {
      const w = 4 - (col % 4);
      if (col + w <= n) {
        col += w;
        i++;
      } else {
        // Straddling tab: drop it entirely.
        return line.slice(i + 1);
      }
    } else break;
  }
  return line.slice(i);
}

// Same, but for lines that will be re-parsed as block content (list
// item lines): expand leading tabs to spaces first, so a tab's width
// is measured from its original column (cm-005: '- foo\n\n\t\tbar'
// must yield code content '  bar', which needs the second tab to
// count as four spaces, not two).
function stripColumnsExpand(line, n) {
  if (n <= 0) return line;
  const expanded = expandLeadingTabs(line, 0);
  let i = 0;
  while (i < expanded.length && i < n && expanded.charCodeAt(i) === 32) i++;
  return expanded.slice(i);
}

// HTML block tags (CommonMark HTML block type 6).
const BLOCK_TAGS = new Set(
  'address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem meta nav noframes ol optgroup option p param section source summary table tbody td tfoot th thead title tr track ul'.split(
    ' ',
  ),
);

// ---------------------------------------------------------------------------
// Inline parsing: delimiters, code spans, HTML tags, autolinks
// ---------------------------------------------------------------------------

// Left/right flanking of a delimiter run from its neighbouring characters
// ('' at the edges). Returns [canOpen, canClose] base values.
function flanking(before, after) {
  const beforeWs = before === '' || isWsCh(before);
  const afterWs = after === '' || isWsCh(after);
  const beforePunct = before !== '' && isPunctCh(before);
  const afterPunct = after !== '' && isPunctCh(after);
  const left = !afterWs && (!afterPunct || beforeWs || beforePunct);
  const right = !beforeWs && (!beforePunct || afterWs || afterPunct);
  return [left, right];
}

function makeDelim(ch, len, canOpen, canClose) {
  return {
    delim: true,
    ch,
    len,
    canOpen,
    canClose,
    openUsed: 0,
    closeUsed: 0,
    openTags: [],
    closeTags: [],
  };
}

function renderDelim(d) {
  // A run renders as its closer tags, then any unused literal
  // characters, then its opener tags. The characters a closer consumes
  // are the first of its run (next to the content it closes), and the
  // characters an opener consumes are the last of its run (next to the
  // content it opens); the leftover sits between them.
  const left = d.len - d.openUsed - d.closeUsed;
  const lit = left > 0 ? d.ch.repeat(left) : '';
  // A strong closer matched while the openers-bottom was set leaves
  // its unused characters inside the emphasis (see processDelims).
  if (d.leftoverInside && d.closeTags.length > 0) {
    return lit + d.closeTags.join('') + d.openTags.join('');
  }
  return d.closeTags.join('') + lit + d.openTags.join('');
}

// CommonMark emphasis algorithm over the delimiter records (document
// order). Matching consumes run characters and records <em>/<strong> tags.
function processDelims(delims) {
  const stack = [];
  // Openers-bottom, per delimiter character: when a delimiter that can
  // both open and close is used as a closer against an opener that
  // cannot itself close, later closers of the same character cannot
  // form single emphasis (<em>) with the opener that sat below the
  // matched one (or anything below it) — but they may still form
  // strong emphasis (<strong>) with it. This is what makes
  // '**public as *so*other* option html**' form <strong> (the '*' after
  // 'other' stays literal) and '*browser in so **change**in*' stay
  // literal, while '**a *b* c* d**' nests <em>, '*foo**bar**baz*' forms
  // its outer <em>, and '**callback that **most**data**' forms its
  // outer <strong>.
  const bottom = { '*': null, '_': null };
  // The `use` (1 for <em>, 2 for <strong>) of the match that set each
  // bottom: a strong inner match blocks a later single-emphasis match
  // against the opener below it even when the lengths are equal
  // ('*browser in so **change**in*' stays literal), while an em inner
  // match only blocks when the opener is longer than the closer.
  const bottomUse = { '*': 0, '_': 0 };
  for (const d of delims) {
    if (d.ch === '~') continue;
    if (d.canClose) {
      let s = stack.length - 1;
      while (s >= 0 && d.openUsed + d.closeUsed < d.len) {
        const o = stack[s];
        if (o.ch !== d.ch || o.openUsed >= o.len) {
          s--;
          continue;
        }
        const oLeft = o.len - o.openUsed - o.closeUsed;
        const dLeft = d.len - d.openUsed - d.closeUsed;
        const use = oLeft >= 2 && dLeft >= 2 ? 2 : 1;
        // A match that would only be single emphasis and would use up
        // the closer entirely cannot reach an opener at or below the
        // openers-bottom for this character — but only when the opener
        // is longer than the closer, or when the inner match that set
        // the bottom was strong. ('**public as *so*other* option
        // html**': the '*' after 'other' must not take one '*' of the
        // opening '**'. '*browser in so **change**in*': the inner
        // '**change**' is strong, so the outer '*' stays literal.
        // When opener and closer are the same length and the inner
        // match was only <em>, the match consumes both fully and is
        // allowed ('*state many *types*updates* it*' and '*escape
        // file be *match*return* options line*?' both form their outer
        // <em>.) A longer closer run, e.g. the '**' ending '*uses
        // state *callback*markdown**', still matches — one of its
        // characters closes the emphasis and the rest stays literal.
        const b = bottom[d.ch];
        if (b && use === 1 && dLeft === 1 && (bottomUse[d.ch] === 2 || oLeft > dLeft)) {
          const bi = stack.indexOf(b);
          if (bi === -1) {
            bottom[d.ch] = null;
          } else if (s <= bi) {
            s--;
            continue;
          }
        }
        const bothWays = (o.canOpen && o.canClose) || (d.canOpen && d.canClose);
        if (
          bothWays &&
          (o.len + d.len) % 3 === 0 &&
          (o.len % 3 !== 0 || d.len % 3 !== 0)
        ) {
          s--;
          continue;
        }
        const openTag = use === 2 ? '<strong>' : '<em>';
        const closeTag = use === 2 ? '</strong>' : '</em>';
        o.openUsed += use;
        d.closeUsed += use;
        o.openTags.unshift(openTag);
        d.closeTags.push(closeTag);
        // When a strong closer matches while the openers-bottom for
        // this character is set (an inner emphasis was closed by a
        // both-ways delimiter, e.g. '**a *b*c***'), the run's unused
        // characters sit inside the emphasis, before its closing tag
        // ('<strong>a <em>b</em>c*</strong>'), not after it.
        if (use === 2 && bottom[d.ch]) d.leftoverInside = true;
        // A closer that can also open sets the openers-bottom just
        // below the opener it matched (the opener below it, if any) —
        // but only when the matched opener cannot itself close. When
        // the opener can also close ('*foo**bar**baz*'), no bottom is
        // set and the outer emphasis still forms.
        if (d.canOpen && !o.canClose && s > 0) {
          bottom[d.ch] = stack[s - 1];
          bottomUse[d.ch] = use;
        }
        // Openers pushed after this one sit inside the emphasis being
        // formed; they cannot match anything outside it, so drop them.
        stack.length = s + 1;
        if (o.openUsed + o.closeUsed >= o.len) {
          stack.splice(s, 1);
          s--;
        }
        // If the opener still has length left, retry it; otherwise the
        // loop moves to the opener below it.
      }
    }
    if (d.canOpen && d.openUsed + d.closeUsed < d.len) stack.push(d);
  }
}

// Strikethrough: only runs of length 1 or 2 are delimiters; opener and
// closer must have equal length and the whole run is consumed for one
// <del>. Longer runs stay literal text.
function processTildes(delims) {
  const stack = [];
  for (const d of delims) {
    if (d.ch !== '~') continue;
    if (d.canClose) {
      for (let s = stack.length - 1; s >= 0; s--) {
        const o = stack[s];
        if (o.len !== d.len) continue;
        if (o.closeUsed > 0) continue;
        o.openUsed = o.len;
        d.closeUsed = d.len;
        o.openTags.unshift('<del>');
        d.closeTags.push('</del>');
        stack.splice(s, 1);
        break;
      }
    }
    if (d.canOpen && d.closeUsed === 0 && d.openUsed === 0) stack.push(d);
  }
}

// A code span starting at src[i] (a backtick). Returns [html, nextIndex]
// or null when no closing run of the same length exists.
function parseCodeSpan(src, i, plain) {
  const n = src.length;
  let j = i;
  while (j < n && src.charCodeAt(j) === 96) j++;
  const ticks = j - i;
  let k = j;
  while (k < n) {
    const c = src.indexOf('`', k);
    if (c === -1) return null;
    let e = c;
    while (e < n && src.charCodeAt(e) === 96) e++;
    if (e - c === ticks) {
      let content = src.slice(j, c).replace(/\n/g, ' ');
      if (
        content.length >= 2 &&
        content.charCodeAt(0) === 32 &&
        content.charCodeAt(content.length - 1) === 32 &&
        /[^ ]/.test(content)
      ) {
        content = content.slice(1, -1);
      }
      const out = plain ? content : '<code>' + escPlain(content) + '</code>';
      return [out, e];
    }
    k = e;
  }
  return null;
}

// An HTML tag, comment, processing instruction, declaration or CDATA
// section starting at src[i] ('<'). Returns [raw, nextIndex] or null.
function parseHtmlTag(src, i) {
  const n = src.length;
  if (i + 1 >= n) return null;
  const c1 = src.charCodeAt(i + 1);
  if (src.startsWith('<!--', i)) {
    // '<!-->' and '<!--->' are complete (abruptly closed) comments.
    if (src.startsWith('<!-->', i)) return ['<!-->', i + 5];
    if (src.startsWith('<!--->', i)) return ['<!--->', i + 6];
    const e = src.indexOf('-->', i + 4);
    if (e === -1) return null;
    return [src.slice(i, e + 3), e + 3];
  }
  if (c1 === 63) {
    const e = src.indexOf('?>', i + 2);
    if (e === -1) return null;
    return [src.slice(i, e + 2), e + 2];
  }
  if (c1 === 33) {
    if (src.startsWith('<![CDATA[', i)) {
      const e = src.indexOf(']]>', i + 9);
      if (e === -1) return null;
      return [src.slice(i, e + 3), e + 3];
    }
    const c2 = src.charCodeAt(i + 2);
    if (c2 >= 65 && c2 <= 90) {
      const e = src.indexOf('>', i + 3);
      if (e === -1) return null;
      return [src.slice(i, e + 1), e + 1];
    }
    return null;
  }
  let j = i + 1;
  let closing = false;
  if (src.charCodeAt(j) === 47) {
    closing = true;
    j++;
  }
  if (j >= n || !/[A-Za-z]/.test(src[j])) return null;
  j++;
  while (j < n && /[A-Za-z0-9-]/.test(src[j])) j++;
  // After the tag name, only whitespace, '/', or '>' may follow. A
  // character such as ':' directly after the name is not a valid tag
  // (an attribute must be separated from the name by whitespace).
  if (j < n) {
    const after = src.charCodeAt(j);
    if (after !== 32 && after !== 9 && after !== 10 && after !== 13 && after !== 12 && after !== 47 && after !== 62) return null;
  }
  // A closing tag takes no attributes: only whitespace and '>' may follow.
  if (closing) {
    while (j < n) {
      const cc = src.charCodeAt(j);
      if (cc === 32 || cc === 9 || cc === 10 || cc === 13 || cc === 12) j++;
      else break;
    }
    if (j < n && src.charCodeAt(j) === 62) return [src.slice(i, j + 1), j + 1];
    return null;
  }
  // Between attributes, whitespace is required: an attribute value
  // must not run straight into the next attribute name.
  let needWs = false;
  while (j < n) {
    const c = src.charCodeAt(j);
    if (c === 62) return [src.slice(i, j + 1), j + 1];
    if (c === 47 && src.charCodeAt(j + 1) === 62) {
      if (closing) return null;
      return [src.slice(i, j + 2), j + 2];
    }
    if (needWs) {
      if (c === 32 || c === 9 || c === 10 || c === 13 || c === 12) {
        j++;
        needWs = false;
        continue;
      }
      return null;
    }
    if (c === 32 || c === 9 || c === 10 || c === 13 || c === 12) {
      j++;
      continue;
    }
    // Attribute name: [A-Za-z_:][A-Za-z0-9_.:-]*
    const aStart = j;
    if (j < n) {
      const fc = src.charCodeAt(j);
      const isFirst =
        (fc >= 65 && fc <= 90) || (fc >= 97 && fc <= 122) || fc === 95 || fc === 58;
      if (!isFirst) return null;
      j++;
      while (j < n) {
        const cc = src.charCodeAt(j);
        const ok =
          (cc >= 65 && cc <= 90) ||
          (cc >= 97 && cc <= 122) ||
          (cc >= 48 && cc <= 57) ||
          cc === 95 ||
          cc === 46 ||
          cc === 58 ||
          cc === 45;
        if (!ok) break;
        j++;
      }
    }
    if (j === aStart) return null;
    const nameEnd = j;
    let k = j;
    while (k < n) {
      const cc = src.charCodeAt(k);
      if (cc === 32 || cc === 9 || cc === 10 || cc === 13 || cc === 12) k++;
      else break;
    }
    if (src.charCodeAt(k) === 61) {
      k++;
      while (k < n) {
        const cc = src.charCodeAt(k);
        if (cc === 32 || cc === 9 || cc === 10 || cc === 13 || cc === 12) k++;
        else break;
      }
      const q = src.charCodeAt(k);
      if (q === 34 || q === 39) {
        const e = src.indexOf(String.fromCharCode(q), k + 1);
        if (e === -1) return null;
        j = e + 1;
      } else {
        while (k < n) {
          const cc = src.charCodeAt(k);
          if (
            cc === 32 || cc === 9 || cc === 10 || cc === 13 || cc === 12 ||
            cc === 34 || cc === 39 || cc === 61 || cc === 60 || cc === 62 ||
            cc === 96
          ) break;
          k++;
        }
        j = k;
      }
      // A value was parsed: the next attribute needs whitespace first.
      needWs = true;
    } else {
      // No value: stop right after the name so the loop consumes the
      // following whitespace itself (the next attribute still needs it).
      j = nameEnd;
    }
  }
  return null;
}

// An autolink <scheme:...> or <email> at src[i] ('<').
// Returns [html, nextIndex] or null.
function parseAutolink(src, i, plain) {
  const n = src.length;
  const e = src.indexOf('>', i + 1);
  if (e === -1 || e - i > 320) return null;
  const inner = src.slice(i + 1, e);
  if (inner.length === 0 || /[\s<>]/.test(inner)) return null;
  const m = /^([A-Za-z][A-Za-z0-9+.-]{1,31}):([^\s<>]+)$/.exec(inner);
  if (m) {
    const href = encodeHref(inner);
    if (href === null) return null;
    if (plain) return [inner, e + 1];
    return ['<a href="' + href + '">' + esc(inner) + '</a>', e + 1];
  }
  if (
    /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/.test(
      inner,
    )
  ) {
    if (plain) return [inner, e + 1];
    return ['<a href="mailto:' + esc(inner) + '">' + esc(inner) + '</a>', e + 1];
  }
  return null;
}

// Characters allowed inside an extended (www/email) autolink path.
// True when the parenthesised group starting at src[open] ('(') holds
// no whitespace before its matching ')'. Used by autolink URL scans:
// a group such as '(./c.md)' is part of the URL, but one such as
// '(https://b.io (Most))' is not.
function parenGroupClean(src, open) {
  let depth = 0;
  for (let t = open; t < src.length; t++) {
    const c = src.charCodeAt(t);
    if (c === 40) depth++;
    else if (c === 41) {
      depth--;
      if (depth === 0) return true;
    } else if (c === 32 || c === 9 || c === 10 || c === 13) {
      return false;
    }
  }
  return false;
}

// The number of unclosed '(' in src[start..end), scanning left to
// right. A ')' met while the depth is 0 is a literal character in the
// URL path, not a closer, so it does not drive the depth negative.
// Used to decide whether a trailing ')' is balanced (it closes an
// open paren) or an extra one to strip.
function parenDepth(src, start, end) {
  let depth = 0;
  for (let t = start; t < end; t++) {
    const c = src.charCodeAt(t);
    if (c === 40) depth++;
    else if (c === 41 && depth > 0) depth--;
  }
  return depth;
}

function isExtPathCh(c) {
  if (c >= 48 && c <= 57) return true;
  if (c >= 65 && c <= 90) return true;
  if (c >= 97 && c <= 122) return true;
  return (
    c === 45 || c === 95 || c === 46 || c === 47 || c === 63 || c === 35 ||
    c === 38 || c === 61 || c === 37 || c === 43 || c === 59 || c === 44 ||
    c === 58 || c === 33 || c === 40 || c === 41 || c === 39 || c === 42 ||
    c === 126 || c === 124 || c === 36 || c === 92 || c === 91 || c === 93
  );
}

// True when src starting at i is a character reference (&name; &#1; &#x1;).
function isEntityRef(src, i) {
  if (src.charCodeAt(i) !== 38) return false;
  let j = i + 1;
  if (src.charCodeAt(j) === 35) {
    j++;
    if (src.charCodeAt(j) === 88 || src.charCodeAt(j) === 120) j++;
    let digits = 0;
    while (j < src.length) {
      const c = src.charCodeAt(j);
      if ((c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102)) {
        digits++;
        j++;
      } else break;
    }
    if (digits === 0) return false;
    return src.charCodeAt(j) === 59;
  }
  let k = j;
  while (k < src.length) {
    const c = src.charCodeAt(k);
    if (
      (c >= 48 && c <= 57) || (c >= 65 && c <= 90) ||
      (c >= 97 && c <= 122) || c === 95
    ) k++;
    else break;
  }
  if (k === j) return false;
  return src.charCodeAt(k) === 59;
}

// An extended www autolink starting at src[i] (the 'w' of www.). The
// caller checked the preceding character. Returns [html, next] or null.
function parseWwwAutolink(src, i, plain) {
  const n = src.length;
  let j = i + 4;
  while (j < n) {
    const c = src.charCodeAt(j);
    if (
      (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) ||
      c === 45 || c === 95
    ) {
      j++;
    } else if (c === 46) {
      j++;
    } else break;
  }
  let end = j;
  if (end < n) {
    let k = end;
    while (k < n && isExtPathCh(src.charCodeAt(k))) {
      // A character reference ends the URL (it is text, not part of it).
      if (src.charCodeAt(k) === 38 && isEntityRef(src, k)) break;
      // A '(' starts a parenthesised group that is only part of the
      // URL when it holds no whitespace: '(./c.md)' is included, but
      // '(https://b.io (Most))' is not (the URL ends before the '(').
      if (src.charCodeAt(k) === 40 && !parenGroupClean(src, k)) break;
      k++;
    }
    end = k;
  }
  while (end > i + 4) {
    const c = src.charCodeAt(end - 1);
    // Trailing '*', '_' and '~' are emphasis/strikethrough delimiters,
    // not part of the URL ('*empty www.mark.com/large*' and
    // '~~but when we www.ember.com~~').
    if (c === 46 || c === 44 || c === 59 || c === 58 || c === 33 || c === 63 || c === 42 || c === 95 || c === 126) {
      end--;
    } else if (c === 41) {
      // Strip a trailing ')' only when no '(' is open before it.
      if (parenDepth(src, i, end - 1) === 0) end--;
      else break;
    } else break;
  }
  if (end <= i + 4) return null;
  const url = src.slice(i, end);
  if (plain) return [url, end];
  return ['<a href="' + encodeHref('http://' + url) + '">' + esc(url) + '</a>', end];
}

// An extended scheme autolink at the ':' in src at index i (the colon
// after the scheme). Returns [html, endIndex, schemeStart] or null.
// The scheme was already emitted as plain text, so the caller rewinds it.
function parseSchemeAutolink(src, i, plain) {
  const n = src.length;
  // Scan back for the scheme: letters, digits, '+', '.', '-'.
  let s = i - 1;
  while (s >= 0) {
    const c = src.charCodeAt(s);
    const ok =
      (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) ||
      c === 43 || c === 46 || c === 45;
    if (!ok) break;
    s--;
  }
  s++;
  const schemeLen = i - s;
  if (schemeLen < 2 || schemeLen > 32) return null;
  const first = src.charCodeAt(s);
  if (!((first >= 65 && first <= 90) || (first >= 97 && first <= 122))) return null;
  if (s > 0) {
    // A scheme autolink only needs the preceding character not to be a
    // word character; punctuation such as '<' is fine.
    const p = src.charCodeAt(s - 1);
    const isWord = (p >= 48 && p <= 57) || (p >= 65 && p <= 90) || (p >= 97 && p <= 122) || p === 95;
    if (isWord) return null;
  }
  // Scan forward for the URL body.
  let j = i + 1;
  while (j < n) {
    const c = src.charCodeAt(j);
    if (isExtPathCh(c) || c === 64) {
      // A character reference ends the URL (it is text, not part of it).
      if (c === 38 && isEntityRef(src, j)) break;
      // A '(' starts a parenthesised group that is only part of the
      // URL when it holds no whitespace.
      if (c === 40 && !parenGroupClean(src, j)) break;
      j++;
    } else break;
  }
  let end = j;
  // Strip trailing punctuation and unbalanced closing parens. A
  // trailing '*' or '_' is an emphasis delimiter, not part of the URL.
  while (end > i + 1) {
    const c = src.charCodeAt(end - 1);
    if (c === 46 || c === 44 || c === 59 || c === 58 || c === 33 || c === 63 || c === 42 || c === 95 || c === 126) {
      end--;
    } else if (c === 41) {
      // Strip a trailing ')' only when no '(' is open before it.
      if (parenDepth(src, s, end - 1) === 0) end--;
      else break;
    } else break;
  }
  if (end <= i + 1) return null;
  const scheme = src.slice(s, i).toLowerCase();
  // The URL body must look like a URL: a domain (which has a dot), an
  // email address (which has '@'), or a path (which starts with '/').
  // Bare punctuation such as '**' is emphasis, not a URL. A body
  // starting with '.' is not a URL either ('config:.\' is plain text
  // and the '\' is a hard break, not an autolink).
  const body = src.slice(i + 1, end);
  if (!body.includes('.') && !body.includes('@') && !body.startsWith('/')) return null;
  if (body.charCodeAt(0) === 46) return null;
  // 'mailto:' takes an email address only: a '/' after the domain is
  // not part of the link, and the domain follows the email rules (it
  // may not end with '-', and a word character right after it voids
  // the link).
  if (scheme === 'mailto') {
    const slash = src.indexOf('/', i + 1);
    if (slash !== -1 && slash < end) end = slash;
    while (end > i + 1 && (src.charCodeAt(end - 1) === 46 || src.charCodeAt(end - 1) === 44 || src.charCodeAt(end - 1) === 59 || src.charCodeAt(end - 1) === 58 || src.charCodeAt(end - 1) === 33 || src.charCodeAt(end - 1) === 63)) end--;
    const at = src.indexOf('@', i + 1);
    if (at !== -1 && at < end) {
      if (src.charCodeAt(end - 1) === 45) return null;
      // The domain may only hold letters, digits, '-' and '.': a '_'
      // (or any other path character) voids the link.
      for (let t = at + 1; t < end; t++) {
        const dc = src.charCodeAt(t);
        const okD = (dc >= 48 && dc <= 57) || (dc >= 65 && dc <= 90) || (dc >= 97 && dc <= 122) || dc === 45 || dc === 46;
        if (!okD) return null;
      }
      if (end < n) {
        const after = src.charCodeAt(end);
        const isWord = (after >= 48 && after <= 57) || (after >= 65 && after <= 90) || (after >= 97 && after <= 122) || after === 95;
        if (isWord) return null;
      }
    }
  } else if (!src.startsWith('//', i + 1)) {
    // A non-hierarchical scheme (no '//') takes at most one path
    // segment after the domain: 'xmpp:foo@bar.baz/txt/bin' links only
    // 'xmpp:foo@bar.baz/txt'.
    const firstSlash = src.indexOf('/', i + 1);
    if (firstSlash !== -1 && firstSlash < end) {
      const secondSlash = src.indexOf('/', firstSlash + 1);
      if (secondSlash !== -1 && secondSlash < end) end = secondSlash;
    }
  }
  if (end <= i + 1) return null;
  const url = src.slice(s, end);
  const href = encodeHref(url);
  if (href === null) return null;
  if (plain) return [url, end, s];
  return ['<a href="' + href + '">' + esc(url) + '</a>', end, s];
}

// An extended email autolink at the '@' in src at index i.
// Returns [html, next] or null. The local part is scanned backwards.
function parseEmailAutolink(src, i, plain, inUnderscore) {
  const n = src.length;
  let s = i - 1;
  while (s >= 0) {
    const c = src.charCodeAt(s);
    const ok =
      (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) ||
      c === 46 || c === 33 || c === 35 || c === 36 || c === 37 || c === 38 ||
      c === 39 || c === 42 || c === 43 || c === 47 || c === 61 || c === 63 ||
      c === 94 || c === 95 || c === 96 || c === 123 || c === 124 || c === 125 ||
      c === 126 || c === 45;
    if (!ok) break;
    s--;
  }
  s++;
  if (s >= i) return null;
  if (s > 0) {
    const p = src.charCodeAt(s - 1);
    const okPrev =
      p === 32 || p === 9 || p === 10 || p === 13 || p === 42 || p === 95 ||
      p === 126 || p === 40;
    if (!okPrev) return null;
  }
  let j = i + 1;
  let dots = 0;
  let labelStart = j;
  while (j < n) {
    const c = src.charCodeAt(j);
    if (
      (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) ||
      c === 45
    ) {
      j++;
    } else if (c === 46) {
      // A dot at the start of a label ends the domain (e.g. the
      // '...' after 'be@nova.example.com...'); only fail when no
      // label has been seen yet ('@.foo' is not an email).
      if (j === labelStart) {
        if (dots === 0) return null;
        break;
      }
      dots++;
      j++;
      labelStart = j;
    } else break;
  }
  if (dots === 0) return null;
  // Strip trailing dots: 'a.b.' links 'a.b' and leaves '.' as text.
  let end = j;
  while (end > i + 1 && src.charCodeAt(end - 1) === 46) end--;
  if (end <= i + 1) return null;
  // Recompute the last label after stripping, and require it to end
  // with a letter (a domain may not end with '-').
  const lastDot = src.lastIndexOf('.', end - 1);
  const lastLabel = src.slice(lastDot + 1, end);
  if (lastLabel.length === 0) return null;
  if (!/[A-Za-z]/.test(lastLabel)) return null;
  if (src.charCodeAt(end - 1) === 45) return null;
  // A word character right after the domain means this is not an
  // email at all ('a.b-c_d@a.b_' is plain text). Exception: a '_'
  // right after the domain is the closer of an open '_' emphasis
  // ('_foo@bar.com_' links 'foo@bar.com'), so it does not void the
  // email when the caller reports an unmatched '_' opener before it.
  if (end < n) {
    const after = src.charCodeAt(end);
    const isWord = (after >= 48 && after <= 57) || (after >= 65 && after <= 90) || (after >= 97 && after <= 122) || after === 95;
    if (isWord && !(after === 95 && inUnderscore)) return null;
  }
  // The domain must contain a dot (count them in the kept part).
  let keptDots = 0;
  for (let t = i + 1; t < end; t++) if (src.charCodeAt(t) === 46) keptDots++;
  if (keptDots === 0) return null;
  const email = src.slice(s, end);
  // Return [html, endIndex, startIndex] so the caller can rewind the
  // local part, which was already emitted as plain text / delimiters.
  if (plain) return [email, end, s];
  return ['<a href="mailto:' + esc(email) + '">' + esc(email) + '</a>', end, s];
}

// ---------------------------------------------------------------------------
// Inline parsing: links and images, and the main inline scanner
// ---------------------------------------------------------------------------

// Index of the ']' matching the '[' at src[i], counting nested brackets
// and skipping code spans and backslash escapes. Returns -1.
function findClosingBracket(src, i) {
  const n = src.length;
  let depth = 0;
  let j = i;
  while (j < n) {
    const c = src.charCodeAt(j);
    if (c === 92) {
      j += 2;
      continue;
    }
    if (c === 96) {
      let k = j;
      while (k < n && src.charCodeAt(k) === 96) k++;
      const ticks = k - j;
      let e = k;
      let found = false;
      while (e < n) {
        const b = src.indexOf('`', e);
        if (b === -1) break;
        let f = b;
        while (f < n && src.charCodeAt(f) === 96) f++;
        if (f - b === ticks) {
          j = f;
          found = true;
          break;
        }
        e = f;
      }
      // No matching closer: the backticks are literal text, not a code
      // span, so they hide nothing — keep scanning for ']'.
      if (!found) j = k;
      continue;
    }
    // A ']' inside an HTML tag or an autolink does not close the link
    // text.
    if (c === 60) {
      const t = parseHtmlTag(src, j);
      if (t) {
        j = t[1];
        continue;
      }
      const a = parseAutolink(src, j, true);
      if (a) {
        j = a[1];
        continue;
      }
    }
    if (c === 91) depth++;
    else if (c === 93) {
      depth--;
      if (depth === 0) return j;
    }
    j++;
  }
  return -1;
}

// Resolve backslash escapes: \ + ASCII punctuation -> the punctuation;
// anything else keeps the backslash.
function unescape(s) {
  let out = '';
  let i = 0;
  while (i < s.length) {
    const c = s.charCodeAt(i);
    if (c === 92 && i + 1 < s.length && isAsciiPunct(s.charCodeAt(i + 1))) {
      out += s[i + 1];
      i += 2;
    } else {
      out += s[i];
      i++;
    }
  }
  return out;
}

// Normalize a link label: collapse whitespace to single spaces, trim,
// lowercase with Unicode case folding. Backslash escapes are NOT
// resolved: a label containing an escape only matches a definition
// whose label has the same escape.
function normalizeLabel(label) {
  return label
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .replace(/ß/g, 'ss');
}

// True when s contains an unescaped '['. Link labels may not contain
// one; link text may.
function hasUnescapedOpenBracket(s) {
  for (let k = 0; k < s.length; k++) {
    if (s.charCodeAt(k) === 92) {
      k++;
      continue;
    }
    if (s.charCodeAt(k) === 91) return true;
  }
  return false;
}

function skipWs(src, i) {
  const n = src.length;
  while (i < n) {
    const c = src.charCodeAt(i);
    if (c === 32 || c === 9 || c === 10 || c === 13 || c === 12) i++;
    else break;
  }
  return i;
}

// A link destination starting at src[i]. Returns {dest, next} or null.
function parseDest(src, i) {
  const n = src.length;
  if (i >= n) return null;
  if (src.charCodeAt(i) === 60) {
    let j = i + 1;
    let out = '';
    while (j < n) {
      const c = src.charCodeAt(j);
      if (c === 62) return { dest: out, next: j + 1 };
      if (c === 10 || c === 60) return null;
      if (c === 92 && j + 1 < n && isAsciiPunct(src.charCodeAt(j + 1))) {
        out += src[j + 1];
        j += 2;
      } else {
        out += src[j];
        j++;
      }
    }
    return null;
  }
  let j = i;
  let out = '';
  let depth = 0;
  while (j < n) {
    const c = src.charCodeAt(j);
    if (c === 32 || c === 9 || c === 10 || c === 13 || c === 12) break;
    if (c === 40) {
      depth++;
      out += '(';
      j++;
      continue;
    }
    if (c === 41) {
      if (depth === 0) break;
      depth--;
      out += ')';
      j++;
      continue;
    }
    if (c < 32) return null;
    if (c === 92 && j + 1 < n && isAsciiPunct(src.charCodeAt(j + 1))) {
      out += src[j + 1];
      j += 2;
      continue;
    }
    out += src[j];
    j++;
  }
  if (j === i) return null;
  return { dest: out, next: j };
}

// A link title starting at src[i] ('"', '\'' or '(').
// Returns {title, next} or null.
function parseTitle(src, i) {
  const n = src.length;
  const q = src.charCodeAt(i);
  let close;
  if (q === 34) close = 34;
  else if (q === 39) close = 39;
  else if (q === 40) close = 41;
  else return null;
  let j = i + 1;
  let out = '';
  while (j < n) {
    const c = src.charCodeAt(j);
    if (c === close) return { title: out, next: j + 1 };
    if (c === 92 && j + 1 < n && isAsciiPunct(src.charCodeAt(j + 1))) {
      out += src[j + 1];
      j += 2;
      continue;
    }
    if (q === 40 && c === 40) return null;
    out += src[j];
    j++;
  }
  return null;
}

// A link or image starting at src[i] ('['). refs is the reference map.
// state is {hasLink}, set when a link is made. Returns [htmlOrText, next]
// or null.
function parseLink(src, i, refs, isImage, plain, state) {
  const n = src.length;
  const close = findClosingBracket(src, i);
  if (close === -1) return null;
  const text = src.slice(i + 1, close);
  let href = null;
  let title = null;
  let next = close + 1;
  let parsedInline = false;
  if (next < n && src.charCodeAt(next) === 40) {
    let j = skipWs(src, next + 1);
    if (j < n && src.charCodeAt(j) === 41) {
      href = '';
      next = j + 1;
      parsedInline = true;
    } else {
      const d = parseDest(src, j);
      if (d) {
        href = d.dest;
        j = skipWs(src, d.next);
        let ok = true;
        if (
          j < n &&
          (src.charCodeAt(j) === 34 || src.charCodeAt(j) === 39 || src.charCodeAt(j) === 40)
        ) {
          const t = parseTitle(src, j);
          if (!t) ok = false;
          else {
            title = t.title;
            j = skipWs(src, t.next);
          }
        }
        if (ok && j < n && src.charCodeAt(j) === 41) {
          next = j + 1;
          parsedInline = true;
        } else {
          href = null;
          title = null;
        }
      }
    }
  }
  if (!parsedInline) {
    next = close + 1;
    if (next < n && src.charCodeAt(next) === 91) {
      const close2 = findClosingBracket(src, next);
      if (close2 === -1) return null;
      const labelRaw = src.slice(next + 1, close2);
      if (labelRaw !== '' && hasUnescapedOpenBracket(labelRaw)) return null;
      const label = labelRaw === '' ? normalizeLabel(text) : normalizeLabel(labelRaw);
      if (labelRaw === '' && hasUnescapedOpenBracket(text)) return null;
      const ref = refs.get(label);
      if (!ref) return null;
      href = ref.href;
      title = ref.title;
      next = close2 + 1;
    } else {
      if (hasUnescapedOpenBracket(text)) return null;
      const ref = refs.get(normalizeLabel(text));
      if (!ref) return null;
      href = ref.href;
      title = ref.title;
    }
  }
  const url = encodeHref(href);
  if (url === null) return null;
  if (isImage) {
    const alt = inline(text, refs, true, { hasLink: false });
    // Inside another image's alt text, an image contributes only its
    // plain alt text, not a nested <img> tag.
    if (plain) return [alt, next];
    let out = '<img src="' + url + '" alt="' + esc(alt) + '"';
    if (title !== null && title !== undefined) out += ' title="' + esc(title) + '"';
    out += '>';
    return [out, next];
  }
  const innerState = { hasLink: false, inLink: true };
  const content = inline(text, refs, false, innerState);
  if (innerState.hasLink) return null;
  state.hasLink = true;
  if (plain) return [content, next];
  let out = '<a href="' + url + '"';
  if (title !== null && title !== undefined) out += ' title="' + esc(title) + '"';
  out += '>' + content + '</a>';
  return [out, next];
}

// Parse inline content. Returns HTML (plain=false) or plain text
// (plain=true, for image alt text). refs is the link reference map.
// state is {hasLink} (set when a link is created); may be null.
function inline(src, refs, plain, state) {
  const parts = [];
  const delims = [];
  let buf = '';
  const flush = () => {
    if (buf) {
      parts.push(plain ? buf : esc(buf));
      buf = '';
    }
  };
  // Remove `need` source characters' worth of already-emitted output
  // from the tail of buf/parts (used when an email or scheme autolink
  // is found whose head was already emitted as plain text/delimiters).
  const rewind = (need) => {
    if (buf.length > 0 && need > 0) {
      const take = Math.min(buf.length, need);
      buf = buf.slice(0, buf.length - take);
      need -= take;
    }
    const escSrcLen = (s) => {
      let extra = 0;
      const mm = s.match(/&(amp|lt|gt|quot|#39);/g);
      if (mm) {
        for (const e of mm) extra += e.length - 1;
      }
      return s.length - extra;
    };
    while (need > 0 && parts.length > 0) {
      const p = parts[parts.length - 1];
      if (typeof p === 'string') {
        const sl = plain ? p.length : escSrcLen(p);
        if (sl <= need) {
          parts.pop();
          need -= sl;
        } else {
          let cut = p.length;
          let left = need;
          while (left > 0 && cut > 0) {
            if (p[cut - 1] === ';') {
              const semi = p.lastIndexOf('&', cut - 1);
              if (semi !== -1 && /^&(amp|lt|gt|quot|#39);$/.test(p.slice(semi, cut))) {
                cut = semi;
                left -= 1;
                continue;
              }
            }
            cut -= 1;
            left -= 1;
          }
          parts[parts.length - 1] = p.slice(0, cut);
          need = 0;
        }
      } else if (p && p.delim) {
        if (p.len <= need) {
          parts.pop();
          const di = delims.indexOf(p);
          if (di !== -1) delims.splice(di, 1);
          need -= p.len;
        } else {
          p.len -= need;
          need = 0;
        }
      } else {
        break;
      }
    }
  };
  const n = src.length;
  const SPECIAL_RE = /[\\`&<[!*_~\n@w:]/g;
  let last = 0;
  let m;
  while ((m = SPECIAL_RE.exec(src)) !== null) {
    const i = m.index;
    if (i > last) buf += src.slice(last, i);
    const c = src.charCodeAt(i);
    if (c === 92) {
      const nx = src[i + 1];
      if (nx === '\n') {
        flush();
        parts.push(plain ? '\n' : '<br>');
        last = i + 2;
        // Leading whitespace after a hard break is stripped.
        while (last < n && (src.charCodeAt(last) === 32 || src.charCodeAt(last) === 9)) last++;
      } else if (nx !== undefined && isAsciiPunct(nx.charCodeAt(0))) {
        // A backslash-escaped & is a literal &, not an entity start:
        // emit it already escaped so esc() cannot re-read it as one.
        if (nx === '&') {
          flush();
          parts.push('&amp;');
        } else {
          buf += nx;
        }
        last = i + 2;
      } else {
        buf += '\\';
        last = i + 1;
      }
    } else if (c === 96) {
      const r = parseCodeSpan(src, i, plain);
      if (r) {
        flush();
        parts.push(r[0]);
        last = r[1];
      } else {
        // No matching closer for this whole backtick run: the entire
        // run is literal text, not the start of a shorter code span.
        let j = i;
        while (j < n && src.charCodeAt(j) === 96) j++;
        buf += src.slice(i, j);
        last = j;
      }
    } else if (c === 38) {
      const num = numericEntity(src, i);
      if (num) {
        if (num[0] === '&') {
          flush();
          parts.push('&amp;');
        } else {
          buf += num[0];
        }
        last = i + num[1];
      } else {
        let j = i + 1;
        while (j < n) {
          const cc = src.charCodeAt(j);
          if (
            (cc >= 48 && cc <= 57) || (cc >= 65 && cc <= 90) ||
            (cc >= 97 && cc <= 122) || cc === 95
          ) j++;
          else break;
        }
        if (j > i + 1 && j < n && src.charCodeAt(j) === 59) {
          buf += src.slice(i, j + 1);
          last = j + 1;
        } else {
          buf += '&';
          last = i + 1;
        }
      }
    } else if (c === 60) {
      // Inside link text, an autolink is suppressed (the URL stays
      // plain text); only an explicit link rejects the outer link.
      // Explicit <...> autolinks DO form inside link text (marked
      // nests them); only bare www/scheme/email autolinks are
      // suppressed inside link text.
      const a = parseAutolink(src, i, plain);
      if (a) {
        flush();
        parts.push(a[0]);
        last = a[1];
      } else {
        const t = parseHtmlTag(src, i);
        if (t) {
          flush();
          if (!plain) parts.push(t[0]);
          // Track <a> / </a> for the document-level inLink flag.
          if (/^<a[\s/>]/i.test(t[0])) docInLink = true;
          else if (/^<\/a\s*>/i.test(t[0])) docInLink = false;
          last = t[1];
        } else {
          buf += '<';
          last = i + 1;
        }
      }
    } else if (c === 91) {
      const r = parseLink(src, i, refs, false, plain, state || { hasLink: false });
      if (r) {
        flush();
        parts.push(r[0]);
        last = r[1];
      } else {
        buf += '[';
        last = i + 1;
      }
    } else if (c === 33) {
      if (src.charCodeAt(i + 1) === 91) {
        const r = parseLink(src, i + 1, refs, true, plain, state || { hasLink: false });
        if (r) {
          flush();
          parts.push(r[0]);
          last = r[1];
        } else {
          buf += '!';
          last = i + 1;
        }
      } else {
        buf += '!';
        last = i + 1;
      }
    } else if (c === 42 || c === 95 || c === 126) {
      const ch = src[i];
      let j = i;
      while (j < n && src.charCodeAt(j) === c) j++;
      const len = j - i;
      if (ch === '~' && len > 2) {
        buf += src.slice(i, j);
        last = j;
      } else {
        const before = i > 0 ? src[i - 1] : '';
        const after = j < n ? src[j] : '';
        const [left, right] = flanking(before, after);
        let canOpen;
        let canClose;
        if (ch === '_') {
          canOpen = left && (!right || isPunctCh(before));
          canClose = right && (!left || isPunctCh(after));
        } else {
          canOpen = left;
          canClose = right;
        }
        flush();
        const d = makeDelim(ch, len, canOpen, canClose);
        parts.push(d);
        delims.push(d);
        last = j;
      }
    } else if (c === 10) {
      let sp = 0;
      let k = buf.length - 1;
      while (k >= 0 && buf.charCodeAt(k) === 32) {
        sp++;
        k--;
      }
      if (sp >= 2) {
        buf = buf.slice(0, buf.length - sp);
        flush();
        parts.push(plain ? '\n' : '<br>');
        last = i + 1;
        // Leading whitespace after a hard break is stripped.
        while (last < n && (src.charCodeAt(last) === 32 || src.charCodeAt(last) === 9)) last++;
      } else {
        buf += '\n';
        last = i + 1;
      }
    } else if (c === 64) {
      // An unmatched '_' opener before this point means the email
      // may sit inside '_' emphasis; a '_' right after its domain
      // is then the emphasis closer, not part of the email.
      let inUnderscore = false;
      for (let d = delims.length - 1; d >= 0; d--) {
        if (delims[d].ch === '_' && delims[d].canOpen) { inUnderscore = true; break; }
      }
      const r = (state && state.inLink) || docInLink ? null : parseEmailAutolink(src, i, plain, inUnderscore);
      if (r) {
        // Rewind the local part (source r[2]..i), already emitted.
        rewind(i - r[2]);
        flush();
        parts.push(r[0]);
        last = r[1];
      } else {
        buf += '@';
        last = i + 1;
      }
    } else if (c === 58) {
      const r = (state && state.inLink) || docInLink ? null : parseSchemeAutolink(src, i, plain);
      if (r) {
        // Rewind the scheme (source r[2]..i), already emitted.
        rewind(i - r[2]);
        flush();
        parts.push(r[0]);
        last = r[1];
      } else {
        buf += ':';
        last = i + 1;
      }
    } else if (c === 119) {
      if (
        !(state && state.inLink) &&
        !docInLink &&
        src.startsWith('www.', i) &&
        (i === 0 ||
          isWsCh(src[i - 1]) ||
          src[i - 1] === '*' ||
          src[i - 1] === '_' ||
          src[i - 1] === '~' ||
          src[i - 1] === '(')
      ) {
        const r = parseWwwAutolink(src, i, plain);
        if (r) {
          flush();
          parts.push(r[0]);
          last = r[1];
        } else {
          buf += 'w';
          last = i + 1;
        }
      } else {
        buf += 'w';
        last = i + 1;
      }
    } else {
      buf += src[i];
      last = i + 1;
    }
    SPECIAL_RE.lastIndex = last;
  }
  if (last < n) buf += src.slice(last);
  flush();
  if (delims.length > 0) {
    processDelims(delims);
    processTildes(delims);
    if (plain) {
      // Plain text (image alt): emphasis markers are stripped, leaving
      // only the unused literal delimiter characters.
      return parts
        .map((p) => {
          if (typeof p === 'string') return p;
          const left = p.len - p.openUsed - p.closeUsed;
          return left > 0 ? p.ch.repeat(left) : '';
        })
        .join('');
    }
    return parts.map((p) => (typeof p === 'string' ? p : renderDelim(p))).join('');
  }
  return parts.join('');
}

// ---------------------------------------------------------------------------
// Block parsing: helpers
// ---------------------------------------------------------------------------

function isThematicBreak(line) {
  let i = 0;
  while (i < line.length && line.charCodeAt(i) === 32) i++;
  if (i > 3) return false;
  const c = line.charCodeAt(i);
  if (c !== 45 && c !== 42 && c !== 95) return false;
  let count = 0;
  while (i < line.length) {
    const ch = line.charCodeAt(i);
    if (ch === c) count++;
    else if (ch !== 32 && ch !== 9) return false;
    i++;
  }
  return count >= 3;
}

function isSetextUnderline(line) {
  let i = 0;
  while (i < line.length && line.charCodeAt(i) === 32) i++;
  if (i > 3) return 0;
  const c = line.charCodeAt(i);
  if (c !== 61 && c !== 45) return 0;
  let count = 0;
  while (i < line.length && line.charCodeAt(i) === c) {
    count++;
    i++;
  }
  // Only trailing spaces/tabs may follow; no spaces inside the run.
  while (i < line.length) {
    const ch = line.charCodeAt(i);
    if (ch !== 32 && ch !== 9) return 0;
    i++;
  }
  return count >= 1 ? (c === 61 ? 1 : 2) : 0;
}

// A fenced-code start line. Returns {ch, len, info, indent} or null.
function fenceStart(line) {
  let i = 0;
  while (i < line.length && line.charCodeAt(i) === 32) i++;
  if (i > 3) return null;
  const c = line.charCodeAt(i);
  if (c !== 96 && c !== 126) return null;
  let j = i;
  while (j < line.length && line.charCodeAt(j) === c) j++;
  const len = j - i;
  if (len < 3) return null;
  const info = line.slice(j).trim();
  if (c === 96 && info.includes('`')) return null;
  return { ch: String.fromCharCode(c), len, info, indent: i };
}

// A fenced-code closing line for the given fence. Nothing but spaces may
// follow the closing run, which must be at least as long as the opener.
function isFenceEnd(line, fence) {
  let i = 0;
  while (i < line.length && line.charCodeAt(i) === 32) i++;
  if (i > 3) return false;
  if (line.charCodeAt(i) !== fence.ch.charCodeAt(0)) return false;
  let j = i;
  while (j < line.length && line.charCodeAt(j) === fence.ch.charCodeAt(0)) j++;
  if (j - i < fence.len) return false;
  while (j < line.length) {
    const c = line.charCodeAt(j);
    if (c !== 32 && c !== 9) return false;
    j++;
  }
  return true;
}

// ATX heading: returns {level, content} or null. The content still needs
// inline parsing; the closing sequence is stripped here.
function atxHeading(line) {
  let i = 0;
  while (i < line.length && line.charCodeAt(i) === 32) i++;
  if (i > 3) return null;
  let j = i;
  while (j < line.length && line.charCodeAt(j) === 35) j++;
  const level = j - i;
  if (level === 0 || level > 6) return null;
  if (j === line.length) return { level, content: '' };
  const c = line.charCodeAt(j);
  if (c !== 32 && c !== 9) return null;
  let content = line.slice(j).replace(/[ \t]+$/, '');
  const m = /^(.*)[ \t]+#+$/.exec(content);
  if (m) content = m[1];
  return { level, content: content.trim() };
}

// HTML block type (1-7) for a line, or 0 when it does not start one.
function htmlBlockType(line) {
  let i = 0;
  while (i < line.length && line.charCodeAt(i) === 32) i++;
  if (i > 3) return 0;
  if (line.charCodeAt(i) !== 60) return 0;
  const rest = line.slice(i + 1);
  const lower = rest.toLowerCase();
  const boundary = (len) => rest.length === len || /[\s>]/.test(rest[len]);
  if (lower.startsWith('script') && boundary(6)) return 1;
  if (lower.startsWith('pre') && boundary(3)) return 1;
  if (lower.startsWith('style') && boundary(5)) return 1;
  if (lower.startsWith('textarea') && boundary(8)) return 1;
  if (rest.startsWith('!--')) return 2;
  if (rest.startsWith('?')) return 3;
  if (rest.startsWith('!') && rest.length > 1 && rest[1] >= 'A' && rest[1] <= 'Z') return 4;
  if (rest.startsWith('![CDATA[')) return 5;
  const m = /^\/?([A-Za-z][A-Za-z0-9-]*)/.exec(rest);
  if (!m) return 0;
  // Type 6 (block tags) starts with the tag name alone; the tag itself
  // may span several lines, so no complete tag is required here.
  if (BLOCK_TAGS.has(m[1].toLowerCase())) return 6;
  // Type 7 (any other complete tag) only when the tag is alone on the
  // line; a tag followed by more content is a paragraph with inline HTML.
  const tag = parseHtmlTag(line, i);
  if (!tag) return 0;
  const after = line.slice(tag[1]);
  if (/^[ \t]*$/.test(after)) return 7;
  return 0;
}

// GFM table: split a row into cells on unescaped pipes, ignoring pipes
// inside code spans. Outer pipes are optional.
function tableRowCells(line) {
  const cells = [];
  let cur = '';
  let i = 0;
  const n = line.length;
  // Skip a leading pipe.
  let s = 0;
  while (s < n && (line.charCodeAt(s) === 32 || line.charCodeAt(s) === 9)) s++;
  if (line.charCodeAt(s) === 124) i = s + 1;
  else i = 0;
  // Split on unescaped '|' only. Backslash escapes are kept verbatim
  // in the cell text. Code spans are NOT tracked during the split, so
  // an unmatched run of backticks (e.g. '``used`') cannot swallow a
  // cell separator by pairing with a backtick in the next cell.
  // After splitting, '\|' inside a code span is resolved to '|' per
  // cell (see resolveTableCellPipes).
  while (i < n) {
    const c = line.charCodeAt(i);
    if (c === 92 && i + 1 < n && isAsciiPunct(line.charCodeAt(i + 1))) {
      cur += line[i] + line[i + 1];
      i += 2;
      continue;
    }
    if (c === 124) {
      cells.push(cur.trim());
      cur = '';
      i++;
      continue;
    }
    cur += line[i];
    i++;
  }
  // A trailing pipe adds no extra cell; otherwise the last cell counts.
  let e = n - 1;
  while (e >= 0 && (line.charCodeAt(e) === 32 || line.charCodeAt(e) === 9)) e--;
  if (line.charCodeAt(e) !== 124) cells.push(cur.trim());
  else if (cur.trim() !== '') cells.push(cur.trim());
  return cells.map(resolveTableCellPipes);
}

// Inside a table cell, an escaped pipe '\|' within a matched code span
// is a table escape and becomes a plain '|' (so '`a \| b`' renders
// '<code>a | b</code>'). Outside code spans the escape is left for
// inline parsing. Unmatched backticks are left alone.
function resolveTableCellPipes(cell) {
  let out = '';
  let i = 0;
  const n = cell.length;
  while (i < n) {
    const c = cell.charCodeAt(i);
    if (c === 96) {
      let j = i;
      while (j < n && cell.charCodeAt(j) === 96) j++;
      const ticks = j - i;
      let k = j;
      let closed = false;
      while (k < n) {
        const b = cell.indexOf('`', k);
        if (b === -1) break;
        let e = b;
        while (e < n && cell.charCodeAt(e) === 96) e++;
        if (e - b === ticks) {
          out += cell.slice(i, e).replace(/\\\|/g, '|');
          i = e;
          closed = true;
          break;
        }
        k = e;
      }
      if (!closed) {
        out += cell.slice(i, j);
        i = j;
      }
      continue;
    }
    out += cell[i];
    i++;
  }
  return out;
}

// A table delimiter row. Returns the alignment per cell ('left'/'right'/
// 'center'/null) or null when the line is not a delimiter row.
function tableDelimiterCells(line) {
  // Split naively on '|' WITHOUT resolving backslash escapes: an
  // escaped dash ('\---') is literal text, not a delimiter cell.
  const raw = line.split('|').map((c) => c.trim());
  // Drop empty edge cells from optional outer pipes.
  while (raw.length > 0 && raw[0] === '') raw.shift();
  while (raw.length > 0 && raw[raw.length - 1] === '') raw.pop();
  if (raw.length === 0) return null;
  const aligns = [];
  for (const cell of raw) {
    const m = /^:?-+:?$/.exec(cell);
    if (!m) return null;
    const left = cell.charCodeAt(0) === 58;
    const right = cell.charCodeAt(cell.length - 1) === 58;
    aligns.push(left && right ? 'center' : right ? 'right' : left ? 'left' : null);
  }
  return aligns;
}

// Parse one link reference definition at the start of paraLines.
// Returns the number of lines consumed or 0. Adds to refs. The label,
// destination and title may each span lines, so the whole paragraph
// text is parsed as one virtual string.
function parseRefDef(paraLines, refs) {
  const virt = paraLines.join('\n');
  let i = 0;
  while (i < virt.length && virt.charCodeAt(i) === 32) i++;
  if (i > 3) return 0;
  if (virt.charCodeAt(i) !== 91) return 0;
  const close = findClosingBracket(virt, i);
  if (close === -1) return 0;
  const labelRaw = virt.slice(i + 1, close);
  if (hasUnescapedOpenBracket(labelRaw)) return 0;
  const label = normalizeLabel(labelRaw);
  if (label === '') return 0;
  let j = close + 1;
  while (j < virt.length && (virt.charCodeAt(j) === 32 || virt.charCodeAt(j) === 9)) j++;
  if (virt.charCodeAt(j) !== 58) return 0;
  j++;
  let p = j;
  while (p < virt.length) {
    const c = virt.charCodeAt(p);
    if (c === 32 || c === 9 || c === 10) p++;
    else break;
  }
  if (p >= virt.length) return 0;
  // Destination.
  let dest;
  let angleDest = false;
  if (virt.charCodeAt(p) === 60) {
    angleDest = true;
    let k = p + 1;
    let out = '';
    let ok = false;
    while (k < virt.length) {
      const c = virt.charCodeAt(k);
      if (c === 62) {
        ok = true;
        break;
      }
      if (c === 10 || c === 60) return 0;
      if (c === 92 && k + 1 < virt.length && isAsciiPunct(virt.charCodeAt(k + 1))) {
        out += virt[k + 1];
        k += 2;
      } else {
        out += virt[k];
        k++;
      }
    }
    if (!ok) return 0;
    dest = out;
    p = k + 1;
  } else {
    let k = p;
    let out = '';
    while (k < virt.length) {
      const c = virt.charCodeAt(k);
      if (c === 32 || c === 9 || c === 10) break;
      if (c < 32) return 0;
      if (c === 92 && k + 1 < virt.length && isAsciiPunct(virt.charCodeAt(k + 1))) {
        out += virt[k + 1];
        k += 2;
      } else {
        out += virt[k];
        k++;
      }
    }
    if (k === p) return 0;
    dest = out;
    p = k;
  }
  // Optional title: same line as the destination, or the next line alone.
  let title = null;
  let endPos = p;
  let q = p;
  while (q < virt.length && (virt.charCodeAt(q) === 32 || virt.charCodeAt(q) === 9)) q++;
  if (q < virt.length && virt.charCodeAt(q) !== 10) {
    // An angle-bracket destination needs whitespace before a title on
    // the same line: '<bar>(baz)' is not a valid definition.
    if (angleDest && q === p) return 0;
    const t = parseTitle(virt, q);
    if (!t) return 0;
    title = t.title;
    let e = t.next;
    while (e < virt.length && (virt.charCodeAt(e) === 32 || virt.charCodeAt(e) === 9)) e++;
    if (e < virt.length && virt.charCodeAt(e) !== 10) return 0;
    endPos = e;
  } else if (q < virt.length && virt.charCodeAt(q) === 10) {
    let r = q + 1;
    while (r < virt.length && (virt.charCodeAt(r) === 32 || virt.charCodeAt(r) === 9)) r++;
    if (r < virt.length && virt.charCodeAt(r) !== 10) {
      const t = parseTitle(virt, r);
      if (t) {
        let e = t.next;
        while (e < virt.length && (virt.charCodeAt(e) === 32 || virt.charCodeAt(e) === 9)) e++;
        if (e >= virt.length || virt.charCodeAt(e) === 10) {
          title = t.title;
          endPos = e;
        }
      }
    }
    if (title === null) endPos = q;
  }
  let consumed = 1;
  for (let t = 0; t < endPos; t++) {
    if (virt.charCodeAt(t) === 10) consumed++;
  }
  if (!refs.has(label)) refs.set(label, { href: dest, title });
  return consumed;
}

// ---------------------------------------------------------------------------
// Block parsing: main loop, simple blocks, paragraphs, tables
// ---------------------------------------------------------------------------

function isBlockquoteStart(line) {
  let i = 0;
  while (i < line.length && line.charCodeAt(i) === 32) i++;
  if (i > 3) return false;
  return line.charCodeAt(i) === 62;
}

// A list item marker at the start of a line. Returns null when the line
// does not start a list item.
function listMarker(line) {
  let i = 0;
  while (i < line.length && line.charCodeAt(i) === 32) i++;
  if (i > 3) return null;
  const indent = i;
  const c = line.charCodeAt(i);
  if (c === 45 || c === 43 || c === 42) {
    if (i + 1 === line.length) {
      return { type: 'bullet', bullet: String.fromCharCode(c), indent, markerLen: 1, contentStart: i + 1, empty: true };
    }
    const nx = line.charCodeAt(i + 1);
    if (nx === 32 || nx === 9) {
      return { type: 'bullet', bullet: String.fromCharCode(c), indent, markerLen: 1, contentStart: i + 1, empty: false };
    }
    return null;
  }
  if (c >= 48 && c <= 57) {
    let j = i;
    while (j < line.length && line.charCodeAt(j) >= 48 && line.charCodeAt(j) <= 57) j++;
    const numStr = line.slice(i, j);
    if (numStr.length > 9) return null;
    const d = line.charCodeAt(j);
    if (d !== 46 && d !== 41) return null;
    if (j + 1 === line.length) {
      return { type: 'ordered', delim: String.fromCharCode(d), start: parseInt(numStr, 10), indent, markerLen: j + 1 - i, contentStart: j + 1, empty: true };
    }
    const nx = line.charCodeAt(j + 1);
    if (nx === 32 || nx === 9) {
      return { type: 'ordered', delim: String.fromCharCode(d), start: parseInt(numStr, 10), indent, markerLen: j + 1 - i, contentStart: j + 1, empty: false };
    }
    return null;
  }
  return null;
}

// Whether a list marker may interrupt a paragraph: a non-empty bullet
// item, or a non-empty ordered item starting at 1.
function listCanInterrupt(lm, inList) {
  if (lm.empty) return false;
  if (lm.type === 'bullet') return true;
  // An ordered list may interrupt a paragraph only when it starts with
  // 1 — unless it is a sublist inside a list item, where any start
  // number may interrupt the item's paragraph.
  if (inList) return true;
  return lm.start === 1;
}

function renderTable(headerLine, aligns, bodyLines, refs) {
  if (collectOnly) return '';
  const headerCells = tableRowCells(headerLine);
  let out = '<table>\n<thead>\n<tr>\n';
  for (let k = 0; k < headerCells.length; k++) {
    const a = aligns[k];
    out += '<th' + (a ? ' align="' + a + '"' : '') + '>' + inline(headerCells[k], refs, false, null) + '</th>\n';
  }
  out += '</tr>\n</thead>\n';
  if (bodyLines.length === 0) {
    out += '</table>\n';
    return out;
  }
  out += '<tbody>';
  for (const rowLine of bodyLines) {
    const cells = tableRowCells(rowLine);
    out += '<tr>\n';
    for (let k = 0; k < headerCells.length; k++) {
      const a = aligns[k];
      const cell = k < cells.length ? cells[k] : '';
      out += '<td' + (a ? ' align="' + a + '"' : '') + '>' + inline(cell, refs, false, null) + '</td>\n';
    }
    out += '</tr>\n';
  }
  out += '</tbody></table>\n';
  return out;
}

// A paragraph (and the setext heading or GFM table it may turn into).
// Returns [html, nextIndex].
function parseParagraph(lines, start, end, refs, tight, inList) {
  const paraLines = [];
  let i = start;
  let setextLevel = 0;
  let setextLine = -1;
  let table = null;
  while (i < end) {
    const line = lines[i];
    if (isBlank(line)) break;
    if (paraLines.length > 0) {
      const se = isSetextUnderline(line);
      if (se) {
        setextLevel = se;
        setextLine = i;
        i++;
        break;
      }
    }
    if (atxHeading(line)) break;
    if (isThematicBreak(line)) break;
    if (fenceStart(line)) break;
    // HTML blocks of types 1-6 can interrupt a paragraph; type 7 cannot.
    const ht = htmlBlockType(line);
    if (ht >= 1 && ht <= 6) break;
    if (isBlockquoteStart(line)) break;
    const lm = listMarker(line);
    if (lm && listCanInterrupt(lm, inList)) break;
    paraLines.push(line);
    i++;
    if (i < end) {
      const delim = tableDelimiterCells(lines[i]);
      if (delim && !isSetextUnderline(lines[i]) && lineIndent(lines[i]) <= 3) {
        const headerCells = tableRowCells(line);
        if (headerCells.length === delim.length) {
          table = { header: line, aligns: delim, delimLine: i };
          break;
        }
      }
    }
  }
  if (table) {
    const contentLines = paraLines.slice(0, paraLines.length - 1);
    let out = '';
    const rest = consumeRefDefs(contentLines, refs);
    if (rest.length > 0) {
      out += renderPara(rest, refs, tight);
    }
    const bodyLines = [];
    let j = table.delimLine + 1;
    // For table bodies, marked only treats a line of only spaces (or
    // empty) as blank; a line containing a tab is a body row (its table
    // regex excludes ` *\n`, spaces only). So a tab-only line yields
    // an empty row, and a setext-looking line ('=========') after it
    // is a row too, not a heading.
    while (j < end && !isTableBlank(lines[j])) {
      // A line starting a new block (blockquote, heading, fence, list,
      // thematic break, HTML block) ends the table body.
      const bl = lines[j];
      if (
        isBlockquoteStart(bl) ||
        atxHeading(bl) ||
        fenceStart(bl) ||
        isThematicBreak(bl) ||
        htmlBlockType(bl) ||
        listMarker(bl)
      ) break;
      bodyLines.push(lines[j]);
      j++;
    }
    out += renderTable(table.header, table.aligns, bodyLines, refs);
    return [out, j];
  }
  const rest = consumeRefDefs(paraLines, refs);
  if (rest.length === 0) {
    // The paragraph was only link reference definitions. A setext
    // underline found after them was not a heading marker: give it
    // back so it is re-read as an ordinary paragraph line.
    if (setextLevel > 0 && setextLine >= 0) return ['', setextLine];
    return ['', i];
  }
  if (setextLevel) {
    if (collectOnly) return ['', i];
    const text = rest.map((l) => l.replace(/^[ \t]+/, '')).join('\n').trim();
    return ['<h' + setextLevel + '>' + inline(text, refs, false, null) + '</h' + setextLevel + '>\n', i];
  }
  return [renderPara(rest, refs, tight), i];
}

function consumeRefDefs(paraLines, refs) {
  let consumed = 0;
  while (consumed < paraLines.length) {
    const n = parseRefDef(paraLines.slice(consumed), refs);
    if (n === 0) break;
    consumed += n;
  }
  return paraLines.slice(consumed);
}

function renderPara(lines, refs, tight) {
  // Paragraph lines keep their leading whitespace verbatim (marked
  // preserves it, even on the first line and on continuation lines).
  if (collectOnly) return '';
  const text = lines.join('\n');
  const inner = inline(text, refs, false, null);
  if (tight) return inner;
  return '<p>' + inner + '</p>\n';
}

// Parse a run of blocks in lines[start..end). Returns {html, loose},
// where loose is true when two top-level blocks in the run are separated
// by a blank line.
function parseRange(lines, start, end, refs, tight, inList) {
  let out = '';
  let loose = false;
  let seenBlock = false;
  let blankSinceBlock = false;
  let i = start;
  while (i < end) {
    const line = lines[i];
    if (isBlank(line)) {
      if (seenBlock) blankSinceBlock = true;
      i++;
      continue;
    }
    if (seenBlock && blankSinceBlock) loose = true;
    seenBlock = true;
    blankSinceBlock = false;
    const indent = lineIndent(line);
    const atx = atxHeading(line);
    if (atx) {
      if (collectOnly) { i++; continue; }
      out += '<h' + atx.level + '>' + inline(atx.content, refs, false, null) + '</h' + atx.level + '>\n';
      i++;
      continue;
    }
    if (isThematicBreak(line)) {
      out += '<hr>\n';
      i++;
      continue;
    }
    const fence = fenceStart(line);
    if (fence) {
      const content = [];
      i++;
      while (i < end) {
        if (isFenceEnd(lines[i], fence)) {
          i++;
          break;
        }
        content.push(stripColumns(lines[i], fence.ch === '~' ? 0 : fence.indent));
        i++;
      }
      let code = content.length === 0 ? '' : content.join('\n') + '\n';
      // The raw content ends with one newline too many when the source
      // ends with a newline (the split leaves a trailing empty line):
      // strip exactly one trailing newline, then ensure one remains
      // when anything is left ('```\n\n\n```' yields '\n', while
      // '```\n\n```' yields '').
      if (code.endsWith('\n')) code = code.slice(0, -1);
      if (code !== '' && !code.endsWith('\n')) code += '\n';
      const lang = fence.info === '' ? '' : unescape(fence.info.split(/\s+/)[0]);
      out += '<pre><code' + (lang ? ' class="language-' + esc(lang) + '"' : '') + '>' + escPlain(code) + '</code></pre>\n';
      continue;
    }
    if (indent >= 4) {
      const content = [];
      while (i < end) {
        if (isBlank(lines[i])) {
          let k = i + 1;
          while (k < end && isBlank(lines[k])) k++;
          if (k < end && lineIndent(lines[k]) >= 4) {
            // A blank line inside indented code keeps its spaces beyond
            // the 4-column code indent.
            for (let b = i; b < k; b++) content.push(stripColumns(lines[b], 4));
            i = k;
            continue;
          }
          break;
        }
        if (lineIndent(lines[i]) >= 4) {
          content.push(stripColumns(lines[i], 4));
          i++;
        } else break;
      }
      while (content.length > 0 && content[content.length - 1].trim() === '') content.pop();
      let code = content.join('\n');
      if (code !== '') code += '\n';
      out += '<pre><code>' + escPlain(code) + '</code></pre>\n';
      continue;
    }
    const htype = htmlBlockType(line);
    if (htype > 0) {
      const htmlLines = [line];
      i++;
      if (htype === 1) {
        let s = 0;
        while (s < line.length && line.charCodeAt(s) === 32) s++;
        const afterLt = line.slice(s + 1).toLowerCase();
        let endTag = '';
        if (afterLt.startsWith('script')) endTag = '</script>';
        else if (afterLt.startsWith('pre')) endTag = '</pre>';
        else if (afterLt.startsWith('style')) endTag = '</style>';
        else if (afterLt.startsWith('textarea')) endTag = '</textarea>';
        if (!line.toLowerCase().includes(endTag)) {
          while (i < end) {
            htmlLines.push(lines[i]);
            if (lines[i].toLowerCase().includes(endTag)) {
              i++;
              break;
            }
            i++;
          }
        }
      } else if (htype === 2) {
        if (!line.includes('-->')) {
          while (i < end) {
            htmlLines.push(lines[i]);
            if (lines[i].includes('-->')) {
              i++;
              break;
            }
            i++;
          }
        }
      } else if (htype === 3) {
        if (!line.includes('?>')) {
          while (i < end) {
            htmlLines.push(lines[i]);
            if (lines[i].includes('?>')) {
              i++;
              break;
            }
            i++;
          }
        }
      } else if (htype === 4) {
        if (!line.includes('>')) {
          while (i < end) {
            htmlLines.push(lines[i]);
            if (lines[i].includes('>')) {
              i++;
              break;
            }
            i++;
          }
        }
      } else if (htype === 5) {
        if (!line.includes(']]>')) {
          while (i < end) {
            htmlLines.push(lines[i]);
            if (lines[i].includes(']]>')) {
              i++;
              break;
            }
            i++;
          }
        }
      } else {
        while (i < end && !isBlank(lines[i])) {
          htmlLines.push(lines[i]);
          i++;
        }
      }
      let htmlText = htmlLines.join('\n');
      // The split leaves a trailing empty line when the source ends
      // with a newline; it would add a spurious trailing newline here.
      if (htmlText.endsWith('\n')) htmlText = htmlText.slice(0, -1);
      out += htmlText;
      // An HTML block keeps one trailing newline when it is the last
      // block of its container and the container text ends with a
      // newline, or when the line after it is not blank (a block of
      // types 1-5 ends at its terminator, and the newline ending its
      // last line is kept when more content follows on the next line).
      let restBlank = true;
      for (let j = i; j < end; j++) {
        if (!isBlank(lines[j])) {
          restBlank = false;
          break;
        }
      }
      // A line of only spaces after the block is not a true blank line
      // for this purpose: '</pre>\n   \n1. ...' keeps '</pre>\n', while
      // '</pre>\n\n1. ...' (a truly empty line) does not.
      const nextNonBlank = i < end && lines[i] !== '';
      if ((restBlank && end > 0 && lines[end - 1] === '') || nextNonBlank) out += '\n';
      continue;
    }
    if (isBlockquoteStart(line)) {
      const r = parseBlockquote(lines, i, end, refs, tight, inList);
      out += r[0];
      i = r[1];
      continue;
    }
    const lm = listMarker(line);
    if (lm) {
      const r = parseList(lines, i, end, refs);
      out += r[0];
      i = r[1];
      continue;
    }
    const r = parseParagraph(lines, i, end, refs, tight, inList);
    out += r[0];
    i = r[1];
  }
  return { html: out, loose };
}

// ---------------------------------------------------------------------------
// Block parsing: blockquotes, lists, and the entry point
// ---------------------------------------------------------------------------

function blockquoteInPara(content) {
  if (isBlank(content)) return false;
  if (atxHeading(content)) return false;
  if (fenceStart(content)) return false;
  if (isThematicBreak(content)) return false;
  if (isSetextUnderline(content)) return false;
  if (htmlBlockType(content)) return false;
  if (lineIndent(content) >= 4) return false;
  return true;
}

function parseBlockquote(lines, start, end, refs, tight, inList) {
  const inner = [];
  let i = start;
  let inPara = false;
  let inFence = null;
  while (i < end) {
    const line = lines[i];
    let s = 0;
    while (s < line.length && line.charCodeAt(s) === 32) s++;
    if (s <= 3 && line.charCodeAt(s) === 62) {
      // Strip '>' and one column of following whitespace. The rest may
      // start with a tab, which is expanded from its true column so the
      // columns that follow keep their positions.
      const rest = expandLeadingTabs(line.slice(s + 1), s + 1);
      const content = rest.charCodeAt(0) === 32 ? rest.slice(1) : rest;
      // A line whose content is only spaces is still a paragraph
      // continuation (it is not a blank separator): fold it onto the
      // previous inner line so the paragraph keeps its trailing space.
      if (content !== '' && content.trim() === '' && inPara && inner.length > 0) {
        inner[inner.length - 1] += '\n' + content;
      } else {
        inner.push(content);
      }
      // Track fenced code blocks: a lazy line inside a fence does not
      // continue the quote, it ends it (the fence closes implicitly).
      const fs = fenceStart(content);
      if (inFence) {
        if (isFenceEnd(content, inFence)) inFence = null;
      } else if (fs) {
        inFence = fs;
      }
      inPara = blockquoteInPara(content);
      i++;
      continue;
    }
    if (inFence) break;
    if (!isBlank(line) && inPara) {
      // A lazy line cannot be a block start: a thematic break, an ATX
      // heading, a fence, an HTML block, or a list marker ends the
      // quote instead of continuing the paragraph. A setext underline
      // alone ('===') is not a block, so it stays a paragraph line —
      // indented by four spaces so it is not read as a setext heading.
      const lmLazy = listMarker(line);
      if (
        isThematicBreak(line) ||
        atxHeading(line) ||
        fenceStart(line) ||
        (htmlBlockType(line) >= 1 && htmlBlockType(line) <= 6) ||
        (lmLazy && listCanInterrupt(lmLazy, inList))
      ) break;
      if (isSetextUnderline(line)) {
        inner.push('    ' + line);
      } else if (lineIndent(line) >= 4) {
        // A lazy line indented four or more columns loses its indent
        // entirely (it is a paragraph continuation, not code). If the
        // stripped line looks like a block start, fold it onto the
        // previous paragraph line instead of re-reading it as a block.
        const stripped = line.replace(/^[ \t]+/, '');
        if (
          inner.length > 0 &&
          (listMarker(stripped) || atxHeading(stripped) || fenceStart(stripped) || isThematicBreak(stripped))
        ) {
          inner[inner.length - 1] += '\n' + stripped;
        } else {
          inner.push(stripped);
        }
      } else {
        inner.push(line);
      }
      i++;
      continue;
    }
    break;
  }
  const html = parseRange(inner, 0, inner.length, refs, false, inList).html;
  return ['<blockquote>\n' + html + '</blockquote>\n', i];
}

function sameListType(lm, first) {
  if (first.type === 'bullet') return lm.type === 'bullet' && lm.bullet === first.bullet;
  return lm.type === 'ordered' && lm.delim === first.delim;
}

// Content indent and first-line text for a list item marker line.
function itemContentInfo(line, marker) {
  const col = marker.indent + marker.markerLen;
  const after = line.slice(marker.contentStart);
  const exp = expandLeadingTabs(after, col);
  let w = 0;
  while (w < exp.length && exp.charCodeAt(w) === 32) w++;
  if (w >= exp.length) {
    return { contentIndent: col + 1, text: '', empty: true };
  }
  if (w >= 5) {
    return { contentIndent: col + 1, text: exp.slice(1), empty: false };
  }
  return { contentIndent: col + w, text: exp.slice(w), empty: false };
}

// A task-list marker at the start of an item's content.
function taskMarker(text) {
  if (text.length < 3) return null;
  if (text.charCodeAt(0) !== 91) return null;
  const c = text.charCodeAt(1);
  let checked;
  if (c === 32) checked = false;
  else if (c === 120 || c === 88) checked = true;
  else return null;
  if (text.charCodeAt(2) !== 93) return null;
  if (text.length > 3) {
    const nx = text.charCodeAt(3);
    if (nx !== 32 && nx !== 9) return null;
  }
  const rest = text.length > 3 ? text.slice(3).replace(/^[ \t]+/, '') : '';
  return { checked, rest };
}

// Whether the item's content ends with a paragraph line (lazy lines OK).
// A blank line ends the paragraph, so a lazy line after one cannot
// continue it.
function itemInPara(cur) {
  if (cur.lines.length === 0) return false;
  const last = cur.lines[cur.lines.length - 1];
  if (last === '') return false;
  if (atxHeading(last)) return false;
  if (fenceStart(last)) return false;
  if (isThematicBreak(last)) return false;
  if (isSetextUnderline(last)) return false;
  if (htmlBlockType(last)) return false;
  if (lineIndent(last) >= 4) return false;
  return true;
}

// Whether the item is a single paragraph (inline <li> format applies).
function itemIsSinglePara(it) {
  if (it.lines.length === 0) return false;
  let inPara = false;
  for (let k = 0; k < it.lines.length; k++) {
    const l = it.lines[k];
    if (l === '') return false;
    if (atxHeading(l) || fenceStart(l) || isThematicBreak(l) || htmlBlockType(l) || isBlockquoteStart(l) || listMarker(l)) return false;
    if (isSetextUnderline(l)) return false;
    if (k > 0) {
      const delim = tableDelimiterCells(l);
      if (delim) {
        const headerCells = tableRowCells(it.lines[k - 1]);
        if (headerCells.length === delim.length) return false;
      }
    }
    if (lineIndent(l) >= 4 && !inPara) return false;
    inPara = true;
  }
  return true;
}

function parseList(lines, start, end, refs) {
  const first = listMarker(lines[start]);
  const isOrdered = first.type === 'ordered';
  const items = [];
  let i = start;
  let cur = null;
  while (i < end) {
    const line = lines[i];
    // A thematic break line ends the list, even when it looks like a
    // list marker ('* * *'). It must be at the list's level, though:
    // a thematic break indented to the item's content indent is item
    // content, not a list break.
    if (cur && isThematicBreak(line) && lineIndent(line) < cur.contentIndent) break;
    const lm = listMarker(line);
    // A marker starts a new item of this list when it has the same type,
    // its indent is within 3 columns of the list's first marker, and it
    // is not indented enough to be content of the current item (a marker
    // at or beyond the current item's content indent starts a sublist
    // inside that item instead).
    if (
      lm && sameListType(lm, first) &&
      (!cur || (lm.indent <= first.indent + 3 && lm.indent < cur.contentIndent))
    ) {
      if (cur) items.push(cur);
      const info = itemContentInfo(line, lm);
      cur = { lines: [], contentIndent: info.contentIndent, task: null, startNum: lm.start };
      if (!info.empty) {
        const t = taskMarker(info.text);
        if (t) {
          cur.task = t.checked;
          cur.lines.push(t.rest);
        } else {
          cur.lines.push(info.text);
        }
      }
      i++;
      continue;
    }
    if (!cur) break;
    if (isBlank(line)) {
      // A blank line is only absorbed into the item when the next
      // non-blank line still belongs to it. Otherwise the blank is a
      // separator for the enclosing block, and the enclosing parse must
      // see it (it decides looseness), so stop here without consuming it.
      let j = i + 1;
      while (j < end && isBlank(lines[j])) j++;
      if (j >= end) {
        cur.lines.push('');
        i++;
        continue;
      }
      const nx = lines[j];
      const nlm = listMarker(nx);
      // An item with no content yet cannot claim indented lines after
      // a blank line: the list is over and the line is a new block.
      // After a blank line a paragraph is over, so the next line can
      // only belong as indented content or as a new item — never as a
      // lazy continuation (that would hide the blank from the parent,
      // which needs it to decide looseness).
      const hasContent = cur.lines.some((l) => l.trim() !== '');
      const belongs =
        (nlm && nlm.indent <= first.indent + 3 && nlm.indent < cur.contentIndent && sameListType(nlm, first)) ||
        (hasContent && lineIndent(nx) >= cur.contentIndent);
      if (!belongs) break;
      cur.lines.push('');
      i++;
      continue;
    }
    if (lineIndent(line) >= cur.contentIndent) {
      cur.lines.push(stripColumnsExpand(line, cur.contentIndent));
      i++;
      continue;
    }
    if (itemInPara(cur)) {
      // A line starting a new block cannot be a lazy continuation.
      if (
        listMarker(line) ||
        atxHeading(line) ||
        fenceStart(line) ||
        isThematicBreak(line) ||
        htmlBlockType(line) ||
        isBlockquoteStart(line)
      ) {
        break;
      }
      const stripped = stripColumnsExpand(line, cur.contentIndent);
      // A lazy line that looks like a block start once stripped (for
      // example a list marker that was too indented to be one) must not
      // be re-read as a block: fold it onto the previous paragraph line.
      if (
        cur.lines.length > 0 &&
        (listMarker(stripped) || atxHeading(stripped) || fenceStart(stripped) || isThematicBreak(stripped))
      ) {
        cur.lines[cur.lines.length - 1] += '\n' + stripped;
      } else if (lineIndent(line) >= 4) {
        // A lazy line indented four or more columns loses its indent
        // entirely (it is a paragraph continuation, not code).
        cur.lines.push(stripped);
      } else {
        // A lazy continuation line keeps its leading whitespace as
        // written (it is a paragraph line, not indented item content).
        cur.lines.push(line);
      }
      i++;
      continue;
    }
    break;
  }
  if (cur) items.push(cur);
  // Drop trailing blank lines from the last item.
  if (items.length > 0) {
    const lastItem = items[items.length - 1];
    while (lastItem.lines.length > 0 && lastItem.lines[lastItem.lines.length - 1] === '') {
      lastItem.lines.pop();
    }
  }
  // Loose when two items are separated by a blank line, or when an
  // item's own top-level blocks are separated by a blank line. The
  // item's own looseness is learned by a probe parse (tight=false);
  // blank lines inside a nested list do not leak upward, because the
  // nested parse consumes them.
  let loose = false;
  for (let idx = 0; idx < items.length - 1; idx++) {
    const it = items[idx];
    if (it.lines.length > 0 && it.lines[it.lines.length - 1] === '') loose = true;
  }
  const probed = [];
  for (const it of items) {
    const r = parseRange(it.lines, 0, it.lines.length, refs, false, true);
    probed.push(r);
    if (r.loose) loose = true;
  }
  const tight = !loose;
  let out = '';
  if (isOrdered) {
    const startNum = items.length > 0 ? items[0].startNum : 1;
    out += startNum !== 1 ? '<ol start="' + startNum + '">\n' : '<ol>\n';
  } else {
    out += '<ul>\n';
  }
  for (let idx = 0; idx < items.length; idx++) {
    const it = items[idx];
    let itemHtml;
    if (tight) {
      itemHtml = parseRange(it.lines, 0, it.lines.length, refs, true, true).html;
    } else {
      itemHtml = probed[idx].html;
    }
    if (it.task !== null && it.task !== undefined) {
      const box = it.task ? '<input checked="" disabled="" type="checkbox">' : '<input disabled="" type="checkbox">';
      if (itemHtml.startsWith('<p>')) {
        itemHtml = '<p>' + box + ' ' + itemHtml.slice(3);
      } else {
        itemHtml = box + ' ' + itemHtml;
      }
    }
    if (itemHtml === '') {
      out += '<li></li>\n';
    } else if (tight && itemIsSinglePara(it)) {
      if (itemHtml.endsWith('\n')) itemHtml = itemHtml.slice(0, -1);
      out += '<li>' + itemHtml + '</li>\n';
    } else {
      out += '<li>' + itemHtml + '</li>\n';
    }
  }
  out += isOrdered ? '</ol>\n' : '</ul>\n';
  return [out, i];
}

function parseBlocks(src) {
  const normalized = src.replace(/\r\n?/g, '\n');
  const lines = normalized.split('\n');
  const refs = new Map();
  // Link reference definitions may appear after their first use, and they
  // apply document-wide, so collect them in a first pass, then render.
  // The first pass skips inline rendering (collectOnly) since its HTML
  // is discarded; only the refs map is kept.
  collectOnly = true;
  parseRange(lines, 0, lines.length, refs, false);
  collectOnly = false;
  // The first pass renders inline content too, which leaves docInLink
  // set from any unclosed '<a' it met; the render pass must start
  // clean, or autolinks in early paragraphs get wrongly suppressed.
  docInLink = false;
  return parseRange(lines, 0, lines.length, refs, false).html;
}
