// Plain-text rules for titles and shop names, the CSV formula guard and gateway order descriptions.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { plainName, itemSummary } = require('../services/plainText');
const { safeText } = require('../services/csvImport');

test('plainName removes angle brackets and control characters and tidies spaces', () => {
  assert.equal(plainName('  Wool <b>Coat</b>\n\tSlim\u0000 '), 'Wool b Coat /b Slim');
  assert.equal(plainName('<script>alert(1)</script>'), 'script alert(1) /script');
  assert.equal(plainName('Plain title'), 'Plain title');
  for (const v of ['<img src=x onerror=1>', 'a<b>c\u0007d']) assert.ok(!/[<>\x00-\x1f]/.test(plainName(v)), v);
  assert.equal(plainName(42), 42, 'non-text values are left for the validators');
});

test('itemSummary leaves out the size part for items without a size', () => {
  const text = itemSummary([{ title: 'Wool Coat', size: 'M', quantity: 2 }, { title: 'Belt', size: null, quantity: 1 }, { title: 'Scarf', quantity: 3 }]);
  assert.equal(text, 'Wool Coat (M) x2, Belt x1, Scarf x3');
  assert.ok(!/null|undefined/.test(text));
  assert.equal(itemSummary(undefined), '');
});

test('CSV text loses leading formula characters but keeps ordinary dashes and plus signs', () => {
  for (const [input, expected] of [
    ['=SUM(A1)', 'SUM(A1)'], ['@home', 'home'], ['  =x', 'x'], ['Fine text', 'Fine text'], ['a=b', 'a=b'],
    ['=cmd|x', 'cmd|x'], ['+(1+1)', '(1+1)'], ['--x(', 'x('], ["-2+3+cmd|' /C calc'!A0", "2+3+cmd|' /C calc'!A0"],
    ['-5 off', '-5 off'], ['-20% Sale Tee', '-20% Sale Tee'], ['+cmd', '+cmd']
  ]) {
    assert.equal(safeText(input), expected, input);
  }
});
