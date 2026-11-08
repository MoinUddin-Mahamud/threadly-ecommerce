// Tests for docs/index.html, the one-page copy of the README.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const page = fs.readFileSync(path.join(ROOT, 'docs', 'index.html'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

test('the docs page is self-contained: no scripts and no outside stylesheets, pictures or frames', () => {
  assert.doesNotMatch(page, /<script/i);
  assert.doesNotMatch(page, /<(link|img|iframe|embed|object)\b/i);
  assert.doesNotMatch(page, /@import|url\(\s*['"]?https?:/i);
});

test('every link inside the docs page goes to a heading that exists', () => {
  const ids = new Set([...page.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
  const links = [...page.matchAll(/href="#([^"]*)"/g)].map((m) => m[1]);
  assert.ok(links.length > 30, 'the table of contents has entries');
  for (const l of links) assert.ok(ids.has(l), `#${l} exists`);
  assert.equal(ids.size, [...page.matchAll(/\bid="([^"]+)"/g)].length, 'ids are unique');
});

test('the docs page covers the same sections as the README', () => {
  assert.doesNotMatch(page, /\bVersion \d/, 'no version label in the one-page guide');
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  const unescape = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  for (const m of readme.matchAll(/^## (.+)$/gm)) {
    const title = m[1].replace(/`/g, '').replace(/\*\*/g, '').replace(/\*/g, '');
    assert.ok(unescape(page).includes(title.slice(0, 20)), `the page has the section "${title}"`);
  }
});

test('the README links to existing headings only', () => {
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  const slugs = new Set([...readme.matchAll(/^#{1,6} (.+)$/gm)].map((m) => m[1].toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').trim().replace(/\s/g, '-')));
  for (const m of readme.matchAll(/\]\(#([^)]+)\)/g)) assert.ok(slugs.has(m[1]), `#${m[1]} points to a heading`);
});
