const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

test('production refuses to start without SESSION_SECRET', () => {
  const result = spawnSync(process.execPath, ['-e', "require('./server')"], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, NODE_ENV: 'production', SESSION_SECRET: '' },
    encoding: 'utf8',
    timeout: 20000
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /SESSION_SECRET/);
});

function trustProxyFor(extraEnv) {
  const result = spawnSync(process.execPath, ['-e', "const { app } = require('./server'); console.log(JSON.stringify(app.get('trust proxy'))); process.exit(0);"], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, NODE_ENV: 'production', SESSION_SECRET: '3f9c1b7a5e2d48f0a6b1c9d7e4f20835b6a1c3d9e7f8a2b4c6d0e1f3a5b7c9d1', TRUST_PROXY: '', ...extraEnv },
    encoding: 'utf8',
    timeout: 20000
  });
  return result.stdout.trim().split('\n').pop();
}

test('production trusts no proxy unless TRUST_PROXY is set', () => {
  assert.equal(trustProxyFor({}), 'false');
  assert.equal(trustProxyFor({ TRUST_PROXY: '1' }), '1');
});

test('connect-src names the websocket origin taken from BASE_URL', () => {
  const script = "const request = require('supertest'); const { app } = require('./server'); request(app).get('/').then((r) => { console.log(r.headers['content-security-policy']); process.exit(0); });";
  const run = (baseUrl) => spawnSync(process.execPath, ['-e', script], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, NODE_ENV: 'test', BASE_URL: baseUrl },
    encoding: 'utf8',
    timeout: 20000
  }).stdout.split(';').map((d) => d.trim()).find((d) => d.startsWith('connect-src'));
  assert.equal(run('https://shop.example.com'), "connect-src 'self' wss://shop.example.com");
  assert.equal(run('http://localhost:3000'), "connect-src 'self' ws://localhost:3000");
});
