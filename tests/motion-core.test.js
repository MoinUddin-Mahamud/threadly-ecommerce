// Stock badge flash and the product grid placeholders, run against a minimal DOM stub.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const core = require('../public/js/motion-core.js');

class El {
  constructor(tag) { this.tag = tag; this.attrs = {}; this.children = []; this.parent = null; this.className = ''; this.textContent = ''; this.innerHTML = ''; }
  setAttribute(n, v) { this.attrs[n] = String(v); }
  getAttribute(n) { return n in this.attrs ? this.attrs[n] : null; }
  hasAttribute(n) { return n in this.attrs; }
  appendChild(c) { c.parent = this; this.children.push(c); this.notify(); return c; }
  remove() { if (this.parent) { const p = this.parent; p.children.splice(p.children.indexOf(this), 1); this.parent = null; } }
  notify() { if (this.watcher) this.watcher(); }
}
const badge = (id, text) => {
  const b = new El('span');
  if (id !== null) b.setAttribute('data-product-id', id);
  b.textContent = text; b.offsetWidth = 0;
  b.classList = { calls: [], remove(c) { this.calls.push('-' + c); }, add(c) { this.calls.push('+' + c); } };
  return b;
};

test('the first value for a product does not flash', () => {
  const flashed = [];
  const check = core.stockWatcher((b) => flashed.push(b));
  assert.equal(check(badge('p1', 'In Stock')), false);
  assert.equal(flashed.length, 0);
});

test('a changed value flashes', () => {
  const flashed = [];
  const check = core.stockWatcher((b) => flashed.push(b));
  check(badge('p1', 'In Stock'));
  const next = badge('p1', 'Only 3 left');
  assert.equal(check(next), true);
  assert.deepEqual(flashed, [next]);
});

test('a redraw with the same value does not flash', () => {
  const flashed = [];
  const check = core.stockWatcher((b) => flashed.push(b));
  check(badge('p1', 'In Stock'));
  assert.equal(check(badge('p1', '  In Stock ')), false);
  assert.equal(check(badge('p1', 'In Stock')), false);
  assert.equal(flashed.length, 0);
});

test('products with the same title in different shops do not collide', () => {
  const flashed = [];
  const check = core.stockWatcher((b) => flashed.push(b));
  check(badge('shopA-tee', 'In Stock'));
  check(badge('shopB-tee', 'Out of Stock'));
  assert.equal(flashed.length, 0, 'different ids never compare with each other');
  assert.equal(check(badge('shopB-tee', 'Out of Stock')), false);
  assert.equal(check(badge('shopA-tee', 'Only 2 left')), true);
  assert.equal(flashed.length, 1);
});

test('a badge without a product id is ignored', () => {
  const check = core.stockWatcher(() => assert.fail('must not flash'));
  assert.equal(check(badge(null, 'In Stock')), false);
  assert.equal(check(badge(null, 'Out of Stock')), false);
});

test('the default flash restarts the animation class', () => {
  const b = badge('p1', 'x');
  core.flash(b);
  assert.deepEqual(b.classList.calls, ['-ui-flash', '+ui-flash']);
});

function skeletonEnv() {
  const timers = [];
  const env = {
    doc: { createElement: (t) => new El(t) },
    Observer: class { constructor(fn) { this.fn = fn; env.observer = this; } observe(grid) { grid.watcher = this.fn; } disconnect() { env.disconnected = true; } },
    setTimeout: (fn, ms) => { timers.push({ fn, ms, live: true }); return timers.length - 1; },
    clearTimeout: (i) => { timers[i].live = false; },
    delay: 10000
  };
  env.fire = () => timers.filter((t) => t.live).forEach((t) => t.fn());
  env.timers = timers;
  return env;
}
const temp = (grid) => grid.children.filter((c) => c.hasAttribute('data-ui-skel'));

test('skeleton cards appear in an empty grid and go when content arrives', () => {
  const grid = new El('div'); const env = skeletonEnv();
  core.skeletonGrid(grid, env);
  assert.equal(temp(grid).length, 6);
  assert.ok(temp(grid).every((c) => c.getAttribute('aria-hidden') === 'true'));
  const card = new El('div'); grid.appendChild(card);
  assert.equal(temp(grid).length, 0);
  assert.deepEqual(grid.children, [card]);
  assert.equal(env.disconnected, true);
  assert.equal(env.timers[0].live, false, 'the timeout is cancelled');
  env.fire();
  assert.deepEqual(grid.children, [card], 'no message after content arrived');
});

test('after the timeout the skeletons become a message', () => {
  const grid = new El('div'); const env = skeletonEnv();
  core.skeletonGrid(grid, env);
  assert.equal(env.timers[0].ms, 10000);
  env.fire();
  assert.equal(temp(grid).length, 0);
  assert.equal(grid.children.length, 1);
  assert.equal(grid.children[0].hasAttribute('data-ui-msg'), true);
  assert.equal(grid.children[0].textContent, 'Could not load products. Please refresh the page.');
});

test('a grid that already has cards is left alone', () => {
  const grid = new El('div'); grid.appendChild(new El('div'));
  const env = skeletonEnv();
  assert.equal(core.skeletonGrid(grid, env), null);
  assert.equal(grid.children.length, 1);
  assert.equal(env.timers.length, 0);
});

test('app.js puts the product id on both kinds of stock badge, and motion.js uses the core', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
  const badges = app.match(/<span class="stock-badge[^>]*>/g);
  assert.equal(badges.length, 2);
  for (const b of badges) assert.match(b, /data-product-id="\$\{safeId\}"/);
  const motion = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'motion.js'), 'utf8');
  assert.match(motion, /UIMotionCore\.stockWatcher/);
  assert.match(motion, /UIMotionCore\.skeletonGrid/);
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.ok(html.indexOf('/js/motion-core.js') > -1 && html.indexOf('/js/motion-core.js') < html.indexOf('/js/motion.js'));
});
