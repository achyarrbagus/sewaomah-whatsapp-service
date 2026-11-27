'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { acquireLock, LockHeldError } = require('../src/lock');
const { loadConfig } = require('../src/index');
const { makeSessionDir } = require('./helpers');

const INDEX = path.join(__dirname, '..', 'src', 'index.js');
const SECRET = 'z'.repeat(32);

test('acquire writes pid, second acquire with live pid throws, release removes', () => {
  const dir = makeSessionDir();
  const lock = acquireLock(dir);
  const file = path.join(dir, '.gateway.lock');
  assert.equal(fs.readFileSync(file, 'utf8').trim(), String(process.pid));
  assert.throws(() => acquireLock(dir), LockHeldError);
  lock.release();
  assert.equal(fs.existsSync(file), false);
  fs.rmSync(dir, { recursive: true });
});

test('stale lock (dead pid) is taken over', () => {
  const dir = makeSessionDir();
  fs.writeFileSync(path.join(dir, '.gateway.lock'), '999999999\n');
  const lock = acquireLock(dir);
  assert.equal(fs.readFileSync(path.join(dir, '.gateway.lock'), 'utf8').trim(), String(process.pid));
  lock.release();
  fs.rmSync(dir, { recursive: true });
});

function runGateway(env) {
  return spawnSync(process.execPath, [INDEX], {
    env: { PATH: process.env.PATH, OMI_GATEWAY_PORT: '0', OMI_API_URL: 'http://127.0.0.1:9', ...env },
    encoding: 'utf8',
    timeout: 10000,
  });
}

test('second gateway with a live lock exits 1 (before touching Chromium or the network)', () => {
  const dir = makeSessionDir();
  fs.writeFileSync(path.join(dir, '.gateway.lock'), `${process.pid}\n`);
  const r = runGateway({ OMI_GATEWAY_SECRET: SECRET, OMI_SESSION_DIR: dir });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /lock/i);
  assert.equal(fs.readFileSync(path.join(dir, '.gateway.lock'), 'utf8').trim(), String(process.pid), 'lock untouched');
  fs.rmSync(dir, { recursive: true });
});

test('refuses to start: short secret, missing dir, wrong mode', () => {
  const ok = makeSessionDir();
  const loose = makeSessionDir(0o755);
  assert.equal(runGateway({ OMI_GATEWAY_SECRET: 'short', OMI_SESSION_DIR: ok }).status, 1);
  assert.equal(runGateway({ OMI_GATEWAY_SECRET: SECRET }).status, 1);
  assert.equal(runGateway({ OMI_GATEWAY_SECRET: SECRET, OMI_SESSION_DIR: path.join(ok, 'missing') }).status, 1);
  const r = runGateway({ OMI_GATEWAY_SECRET: SECRET, OMI_SESSION_DIR: loose });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /0700/);
  fs.rmSync(ok, { recursive: true });
  fs.rmSync(loose, { recursive: true });
});

test('loadConfig defaults', () => {
  const dir = makeSessionDir();
  const c = loadConfig({ OMI_GATEWAY_SECRET: SECRET, OMI_SESSION_DIR: dir });
  assert.equal(c.apiUrl, 'http://127.0.0.1:8081');
  assert.equal(c.port, 8095);
  assert.equal(c.sessionDir, dir);
  assert.throws(() => loadConfig({ OMI_GATEWAY_SECRET: SECRET, OMI_SESSION_DIR: dir, OMI_GATEWAY_PORT: 'abc' }));
  fs.rmSync(dir, { recursive: true });
});
