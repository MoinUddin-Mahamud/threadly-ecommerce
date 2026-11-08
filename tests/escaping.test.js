// Static scan: dynamic text must be escaped (or set as text) before it reaches HTML in the browser
// scripts.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const JS_DIR = path.join(__dirname, '..', 'public', 'js');
// Properties that hold text a seller, customer or admin typed.
const TEXT_PROP = /(?:^|\.)(message|title|name|email|phone|address|note|description|city|code|instructions|ownerEmail|customerName|customerEmail)$/;

function riskyInterpolations(file) {
  const hits = [];
  fs.readFileSync(path.join(JS_DIR, file), 'utf8').split('\n').forEach((line, i) => {
    // Lines that only ever feed plain-text sinks are fine.
    if (/\.(text|val)\(|textContent|showNotification\(|confirm\(|showAlert\(|\.data\(|setMsg\(|fail\(|setCouponMessage\(|removeCoupon\(/.test(line)) return;
    for (const m of line.matchAll(/\$\{([^}]*)\}/g)) {
      const expr = m[1].trim();
      if (/^(esc|escapeHtml)\(/.test(expr)) continue;
      if (TEXT_PROP.test(expr)) hits.push(`${file}:${i + 1}: \${${expr}}`);
    }
  });
  return hits;
}

test('browser scripts never put a raw text property into an HTML template', () => {
  const hits = fs.readdirSync(JS_DIR).filter((f) => f.endsWith('.js')).flatMap(riskyInterpolations);
  assert.deepEqual(hits, []);
});

test('the scan itself catches a raw value (it is not a test that always passes)', () => {
  const tmp = path.join(JS_DIR, '__scan-probe.js');
  fs.writeFileSync(tmp, 'el.innerHTML = `<td>${p.title}</td><td>${escapeHtml(p.name)}</td>`;\n');
  try { assert.deepEqual(riskyInterpolations('__scan-probe.js'), ['__scan-probe.js:1: ${p.title}']); }
  finally { fs.unlinkSync(tmp); }
});

test('alert messages and field errors are set as text, never parsed as HTML', () => {
  const admin = fs.readFileSync(path.join(JS_DIR, 'admin.js'), 'utf8');
  const fn = admin.slice(admin.indexOf('function showAlert'), admin.indexOf('function showAlert') + 900);
  assert.match(fn, /\.text\(String\(message\)\)/, 'showAlert sets the message as text');
  assert.ok(!/\$\{message\}/.test(fn), 'the message is not interpolated into the alert markup');
  for (const f of ['admin-extras.js', 'admin-roles.js', 'admin-coupons.js']) {
    const src = fs.readFileSync(path.join(JS_DIR, f), 'utf8');
    assert.ok(!/innerHTML\s*=[^;\n]*\b(msg|message|err\.message|responseJSON)/.test(src), `${f} never writes an error message through innerHTML`);
  }
});
