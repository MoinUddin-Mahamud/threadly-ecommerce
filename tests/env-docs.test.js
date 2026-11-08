// Every environment variable the code reads must be in .env.example and in the README.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

// Variables set by the platform or the test runner, not by the shop owner.
const IGNORE = new Set(['NODE_ENV_TEST']);

function filesIn(dir) {
  return fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? filesIn(path.join(dir, e.name)) : e.name.endsWith('.js') ? [path.join(dir, e.name)] : []);
}

function usedVariables() {
  const found = new Set();
  const files = ['server.js', ...['routes', 'services', 'config', 'models', 'middleware', 'scripts', 'seed'].flatMap(filesIn)];
  for (const f of files) {
    for (const m of read(f).matchAll(/\b(?:process\.env|env)\.([A-Z][A-Z0-9_]{2,})\b/g)) found.add(m[1]);
  }
  return [...found].filter((v) => !IGNORE.has(v)).sort();
}

test('every environment variable used in the code is in .env.example', () => {
  const example = read('.env.example');
  const missing = usedVariables().filter((v) => !new RegExp(`^#?\\s*${v}=`, 'm').test(example));
  assert.deepEqual(missing, []);
});

test('every environment variable used in the code is in the README', () => {
  const readme = read('README.md');
  const missing = usedVariables().filter((v) => !readme.includes('`' + v + '`'));
  assert.deepEqual(missing, []);
});
