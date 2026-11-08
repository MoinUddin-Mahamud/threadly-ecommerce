const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { sessionSecretProblem } = require('../config/sessionSecret');

const GOOD = 'f3a9c1d27b8e4a0d95c6e1b2a7d4839c0e5f6a1b2c3d4e5f60718293a4b5c6d7';

test('missing, placeholder and short secrets are rejected; a real one is accepted', () => {
  assert.match(sessionSecretProblem(undefined), /missing/);
  assert.match(sessionSecretProblem(''), /missing/);
  assert.match(sessionSecretProblem('   '), /missing/);
  assert.match(sessionSecretProblem('replace-this-with-a-long-random-string'), /placeholder/);   // the value in .env.example
  assert.match(sessionSecretProblem('change-me-change-me-change-me-change-me'), /placeholder/);
  assert.match(sessionSecretProblem('short-but-unique-123'), /too short/);
  assert.equal(sessionSecretProblem(GOOD), null);
});

test('the old built-in development fallback value is still rejected if someone copied it', () => {
  assert.match(sessionSecretProblem('threadly-secret-key-CHANGE-IN-PRODUCTION'), /placeholder/);
});

test('a long secret that merely starts with "test" or "dev" is accepted', () => {
  assert.equal(sessionSecretProblem('test-' + GOOD), null);
  assert.equal(sessionSecretProblem('dev' + GOOD), null);
});

test('a long but predictable secret is rejected', () => {
  assert.match(sessionSecretProblem('a'.repeat(40)), /predictable/);
  assert.match(sessionSecretProblem('ab'.repeat(20)), /predictable/);
});

function startServer(env) {
  return spawnSync(process.execPath, ['-e', "require('./server'); console.log('LOADED'); process.exit(0);"], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, NODE_ENV: 'production', ...env },
    encoding: 'utf8',
    timeout: 30000
  });
}

test('production refuses the placeholder secret from .env.example', () => {
  const result = startServer({ SESSION_SECRET: 'replace-this-with-a-long-random-string' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /SESSION_SECRET is still the placeholder/);
  assert.match(result.stderr, /randomBytes/);   // tells the owner how to generate a real one
});

test('production refuses a short secret', () => {
  const result = startServer({ SESSION_SECRET: 'abc123' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /too short/);
});

test('production starts with a proper secret', () => {
  const result = startServer({ SESSION_SECRET: GOOD });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /LOADED/);
});

const fs = require('node:fs');
test('server.js has no built-in fallback secret', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.ok(!/threadly-secret-key/i.test(src), 'no guessable secret in the source');
  assert.ok(!/SESSION_SECRET\s*\|\|/.test(src), 'the session secret never falls back to a literal');
  assert.match(src, /randomBytes\(32\)/);
});

test('outside production a missing or weak secret still starts, with a warning and a random secret', () => {
  for (const env of [{ SESSION_SECRET: '' }, { SESSION_SECRET: 'replace-this-with-a-long-random-string' }, { SESSION_SECRET: 'short' }]) {
    const result = spawnSync(process.execPath, ['-e', "require('./server'); console.log('LOADED'); process.exit(0);"], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, NODE_ENV: 'development', ...env },
      encoding: 'utf8',
      timeout: 30000
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /LOADED/);
    assert.match(result.stderr + result.stdout, /random secret for this run only/);
  }
});

test('outside production a good secret is used as it is (no warning)', () => {
  const result = spawnSync(process.execPath, ['-e', "require('./server'); console.log('LOADED'); process.exit(0);"], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, NODE_ENV: 'development', SESSION_SECRET: GOOD },
    encoding: 'utf8',
    timeout: 30000
  });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!/random secret/.test(result.stderr + result.stdout));
});
