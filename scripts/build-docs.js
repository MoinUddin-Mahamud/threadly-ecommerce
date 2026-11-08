// Builds docs/index.html (the whole guide as one page) from README.md.
//   npm run docs
// Plain Node, no packages. The README is the master copy: edit it, then run this again.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

const STYLE = `:root { --bg:#fff; --fg:#1d2433; --muted:#5b6475; --line:#dde1ea; --soft:#f4f6fa; --accent:#1f4aa8; --code:#eef1f7; color-scheme: light dark; }
@media (prefers-color-scheme: dark) { :root { --bg:#12161f; --fg:#e6e9f0; --muted:#98a1b3; --line:#2a3142; --soft:#1a2030; --accent:#8fb3ff; --code:#1d2436; } }
* { box-sizing: border-box; }
html { scroll-behavior: smooth; }
body { margin:0; background:var(--bg); color:var(--fg); font:16px/1.65 system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif; }
.layout { display:flex; align-items:flex-start; max-width:1280px; margin:0 auto; }
nav.toc { position:sticky; top:0; flex:0 0 300px; max-height:100vh; overflow:auto; padding:24px 16px 40px 24px; border-right:1px solid var(--line); font-size:14px; }
nav.toc strong { display:block; margin-bottom:10px; font-size:13px; letter-spacing:.06em; text-transform:uppercase; color:var(--muted); }
nav.toc ul { list-style:none; margin:0; padding:0; }
nav.toc ul ul { margin:2px 0 6px 12px; }
nav.toc a { display:block; padding:3px 0; color:var(--fg); text-decoration:none; }
nav.toc a:hover { color:var(--accent); }
main { flex:1; min-width:0; padding:32px 32px 80px; max-width:900px; }
h1 { font-size:2rem; line-height:1.25; margin:0 0 .5em; }
h2 { margin:2.2em 0 .6em; padding-top:.4em; border-top:1px solid var(--line); font-size:1.5rem; }
h3 { margin:1.8em 0 .5em; font-size:1.2rem; }
h4 { margin:1.4em 0 .4em; }
a { color:var(--accent); }
code { background:var(--code); padding:.12em .35em; border-radius:4px; font:.9em ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; overflow-wrap:anywhere; }
pre { background:var(--code); padding:14px 16px; border-radius:8px; overflow:auto; line-height:1.45; }
pre code { background:none; padding:0; overflow-wrap:normal; }
blockquote { margin:1em 0; padding:.2em 1em; border-left:4px solid var(--line); background:var(--soft); color:var(--muted); }
.table-wrap { overflow-x:auto; margin:1em 0; }
table { border-collapse:collapse; width:100%; font-size:.95em; }
th, td { border:1px solid var(--line); padding:6px 10px; text-align:left; vertical-align:top; }
th { background:var(--soft); }
td:first-child code { white-space:nowrap; overflow-wrap:normal; }
hr { border:0; border-top:1px solid var(--line); margin:2em 0; }
hr + h2 { border-top:0; margin-top:1em; }
details.toc-mobile { display:none; margin:0 0 24px; padding:10px 14px; border:1px solid var(--line); border-radius:8px; background:var(--soft); }
details.toc-mobile ul { list-style:none; padding-left:12px; margin:.4em 0; }
@media (max-width: 900px) { nav.toc { display:none; } details.toc-mobile { display:block; } main { padding:20px 16px 60px; } }
@media print { nav.toc, details.toc-mobile { display:none; } main { max-width:none; padding:0; } }
`;

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// ---- inline text: `code`, [links](url), **bold**, *italic* and bare web addresses ----
function inline(text) {
  const held = [];
  const hold = (html) => { held.push(html); return `\u0000${held.length - 1}\u0000`; };
  let s = text.replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, (m, ticks, code) => hold(`<code>${esc(code.replace(/^ (.*) $/s, '$1'))}</code>`));
  s = esc(s);
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label, url) => {
    const external = /^https?:\/\//i.test(url);
    return hold(`<a href="${url}"${external ? ' rel="noopener noreferrer"' : ''}>${emphasis(label)}</a>`);
  });
  s = emphasis(s);
  s = s.replace(/(^|[\s>(])(https?:\/\/[^\s<]+)/g, (m, lead, raw) => {
    let url = raw;
    let tail = '';
    for (;;) {
      const t = url.match(/(?:[.,;:!?*]|&quot;|&#39;)$/);
      if (t) { tail = t[0] + tail; url = url.slice(0, -t[0].length); continue; }
      if (url.endsWith(')') && (url.match(/\(/g) || []).length < (url.match(/\)/g) || []).length) { tail = ')' + tail; url = url.slice(0, -1); continue; }
      break;
    }
    return `${lead}${hold(`<a href="${url}" rel="noopener noreferrer">${url}</a>`)}${tail}`;
  });
  for (let n = 0; n < 5 && /\u0000\d+\u0000/.test(s); n++) s = s.replace(/\u0000(\d+)\u0000/g, (m, i) => held[Number(i)]);
  return s;
}
function emphasis(s) {
  return s
    .replace(/\*\*(?=\S)([\s\S]+?)(?<=\S)\*\*/g, '<strong>$1</strong>')
    .replace(/(?<![*\w])\*(?=[^\s*])([\s\S]+?)(?<=[^\s*])\*(?![*\w])/g, '<em>$1</em>');
}

const plain = (s) => s.replace(/`/g, '').replace(/\*\*/g, '').replace(/\*/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
const slugOf = (s) => plain(s).toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').trim().replace(/\s/g, '-');

const FENCE = /^(\s*)(`{3,})\s*([\w+-]*)\s*$/;
const BULLET = /^(\s*)([-*+])\s+(.*)$/;
const ORDERED = /^(\s*)(\d{1,9})([.)])\s+(.*)$/;
const isRule = (l) => /^ {0,3}([-*_])( ?\1){2,}\s*$/.test(l);
const isTableStart = (lines, i) => /^\s*\|/.test(lines[i]) && i + 1 < lines.length && /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(lines[i + 1]);
const startsBlock = (l) => FENCE.test(l) || /^ {0,3}#{1,6}\s/.test(l) || isRule(l) || /^ {0,3}>/.test(l) || BULLET.test(l) || ORDERED.test(l);

// ---- block level: returns [{ type, html, text?, blankBefore }] ----
function parseBlocks(lines, ids) {
  const blocks = [];
  let i = 0;
  let blank = false;
  const push = (b) => { b.blankBefore = blank && blocks.length > 0; blank = false; blocks.push(b); };
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { blank = true; i++; continue; }

    let m = line.match(FENCE);
    if (m) {
      const indent = m[1].length;
      const code = [];
      i++;
      while (i < lines.length && !new RegExp(`^\\s*${m[2]}\`*\\s*$`).test(lines[i])) { code.push(lines[i].slice(Math.min(indent, lines[i].length - lines[i].trimStart().length))); i++; }
      i++;
      push({ type: 'code', html: `<pre><code${m[3] ? ` class="language-${m[3]}"` : ''}>${esc(code.join('\n'))}${code.length ? '\n' : ''}</code></pre>\n` });
      continue;
    }
    m = line.match(/^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (m) {
      const level = m[1].length;
      let id = slugOf(m[2]);
      let n = 0;
      const base = id;
      while (ids.has(id)) id = `${base}-${++n}`;
      ids.add(id);
      push({ type: 'heading', level, id, title: plain(m[2]), html: `<h${level} id="${id}">${inline(m[2])}</h${level}>\n` });
      i++;
      continue;
    }
    if (isRule(line)) { push({ type: 'hr', html: '<hr>\n' }); i++; continue; }
    if (/^ {0,3}>/.test(line)) {
      const inner = [];
      while (i < lines.length && /^ {0,3}>/.test(lines[i])) { inner.push(lines[i].replace(/^ {0,3}> ?/, '')); i++; }
      push({ type: 'quote', html: `<blockquote>\n${parseBlocks(inner, new Set()).map((b) => b.html).join('')}</blockquote>\n` });
      continue;
    }
    if (isTableStart(lines, i)) {
      const cells = (row) => row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
      const head = cells(lines[i]);
      i += 2;
      const rows = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) { rows.push(cells(lines[i])); i++; }
      const tr = (cs, tag) => `<tr>\n${cs.map((c) => `<${tag}>${inline(c)}</${tag}>\n`).join('')}</tr>\n`;
      push({ type: 'table', html: `<div class="table-wrap"><table><thead>${tr(head, 'th')}</thead><tbody>${rows.map((r) => tr(r, 'td')).join('')}</tbody></table></div>\n` });
      continue;
    }
    if (BULLET.test(line) || ORDERED.test(line)) {
      const res = parseList(lines, i, ids);
      push({ type: 'list', html: res.html });
      i = res.next;
      continue;
    }
    const para = [];
    while (i < lines.length && lines[i].trim() && !(para.length && startsBlock(lines[i])) && !(para.length && isTableStart(lines, i))) { para.push(lines[i].trim()); i++; }
    push({ type: 'p', text: para.join('\n'), html: `<p>${inline(para.join('\n'))}</p>\n` });
  }
  return blocks;
}

function parseList(lines, start, ids) {
  const first = lines[start];
  const ordered = ORDERED.test(first) && !BULLET.test(first);
  const mFirst = first.match(ordered ? ORDERED : BULLET);
  const base = mFirst[1].length;
  const startNumber = ordered ? Number(mFirst[2]) : 1;
  const items = [];
  let i = start;
  let loose = false;
  while (i < lines.length) {
    const line = lines[i];
    const m = line.match(ordered ? ORDERED : BULLET);
    if (!m || m[1].length !== base || (!ordered && BULLET.test(line) === false)) break;
    const marker = ordered ? `${m[2]}${m[3]}` : m[2];
    const rest = ordered ? m[4] : m[3];
    const contentIndent = base + marker.length + 1;
    const body = [rest];
    i++;
    let sawBlank = false;
    let inFence = FENCE.test(rest);
    while (i < lines.length) {
      const l = lines[i];
      if (!l.trim()) { sawBlank = true; body.push(''); i++; continue; }
      const indent = l.length - l.trimStart().length;
      if (indent >= contentIndent || (indent > base && sawBlank) || inFence) {
        if (FENCE.test(l)) inFence = !inFence;
        body.push(l.slice(Math.min(contentIndent, indent)));
        sawBlank = false;
        i++;
        continue;
      }
      if (!sawBlank && indent > base) { body.push(l.trim()); i++; continue; }
      if (!sawBlank && !startsBlock(l)) { body.push(l.trim()); i++; continue; }   // wrapped line of the same item
      break;
    }
    while (body.length && !body[body.length - 1].trim()) body.pop();
    const nextIsItem = i < lines.length && (ordered ? ORDERED : BULLET).test(lines[i]) && ((ordered ? ORDERED : BULLET).exec(lines[i])[1].length === base);
    if (sawBlank && nextIsItem) loose = true;
    items.push(parseBlocks(body, ids));
  }
  for (const blocks of items) if (blocks.some((b, n) => n > 0 && b.blankBefore)) loose = true;
  const li = items.map((blocks) => {
    const inner = blocks.map((b) => (b.type === 'p' && !loose ? inline(b.text) : b.html)).join('');
    return `<li>${inner}</li>\n`;
  }).join('');
  const tag = ordered ? 'ol' : 'ul';
  return { html: `<${tag}${ordered && startNumber !== 1 ? ` start="${startNumber}"` : ''}>\n${li}</${tag}>\n`, next: i };
}

// ---- the page ----
function build(readme) {
  const ids = new Set();
  const blocks = parseBlocks(readme.replace(/\r\n/g, '\n').split('\n'), ids);
  const heads = blocks.filter((b) => b.type === 'heading');
  const title = (heads.find((h) => h.level === 1) || { title: 'Documentation' }).title;
  const sections = [];
  for (const h of heads) {
    if (h.level === 2) sections.push({ h, kids: [] });
    else if (h.level === 3 && sections.length) sections[sections.length - 1].kids.push(h);
  }
  const link = (h) => `<a href="#${h.id}">${esc(h.title)}</a>`;
  const toc = sections.map((s) => `<li>${link(s.h)}${s.kids.length ? `<ul>${s.kids.map((k) => `<li>${link(k)}</li>`).join('')}</ul>` : ''}</li>`);
  const tocHtml = `<ul>${toc.join('')}</ul>`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} - Documentation</title>
<style>
${STYLE}</style>
</head>
<body>
<div class="layout">
<nav class="toc" aria-label="Contents"><strong>Contents</strong>${tocHtml}</nav>
<main>
<details class="toc-mobile"><summary>Contents</summary>${tocHtml}</details>
${blocks.map((b) => b.html).join('')}
<hr>
<p><small>This page is generated from <code>README.md</code>; the README is the master copy.</small></p>
</main>
</div>
</body>
</html>
`;
}

if (require.main === module) {
  const html = build(fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8'));
  fs.writeFileSync(path.join(ROOT, 'docs', 'index.html'), html);
  console.log(`Wrote docs/index.html (${html.length} bytes) from README.md`);
}

module.exports = { build, inline, slugOf };
