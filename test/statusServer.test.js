'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createStatusServer } = require('../src/statusServer');

const SECRET = 'k'.repeat(48);

async function start(status) {
  const server = createStatusServer({ secret: SECRET, getStatus: () => status, logger: { info() {}, warn() {}, error() {} } });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

test('/status without bearer -> 401, wrong bearer -> 401, never leaks status', async (t) => {
  const { server, url } = await start({ state: 'waiting_qr', qr: 'QR-PAYLOAD', reason: null, since: new Date().toISOString() });
  t.after(() => server.close());
  for (const headers of [{}, { Authorization: 'Bearer nope' }, { Authorization: `Basic ${SECRET}` }, { Authorization: `Bearer ${SECRET}x` }]) {
    const res = await fetch(`${url}/status`, { headers });
    assert.equal(res.status, 401);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.ok(!(await res.text()).includes('QR-PAYLOAD'));
  }
});

test('/status with bearer -> 200 JSON with Cache-Control: no-store', async (t) => {
  const since = new Date().toISOString();
  const { server, url } = await start({ state: 'waiting_qr', qr: 'QR-PAYLOAD', reason: null, since });
  t.after(() => server.close());
  const res = await fetch(`${url}/status`, { headers: { Authorization: `Bearer ${SECRET}` } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.match(res.headers.get('content-type'), /application\/json/);
  assert.deepEqual(await res.json(), { state: 'waiting_qr', qr: 'QR-PAYLOAD', reason: null, since });
});

test('qr is forced null outside waiting_qr', async (t) => {
  const { server, url } = await start({ state: 'ready', qr: 'STALE', reason: null, since: 'x' });
  t.after(() => server.close());
  const res = await fetch(`${url}/status`, { headers: { Authorization: `Bearer ${SECRET}` } });
  assert.equal((await res.json()).qr, null);
});

test('other paths 404, non-GET 405', async (t) => {
  const { server, url } = await start({ state: 'ready', qr: null, reason: null, since: 'x' });
  t.after(() => server.close());
  const auth = { Authorization: `Bearer ${SECRET}` };
  assert.equal((await fetch(`${url}/nope`, { headers: auth })).status, 404);
  assert.equal((await fetch(`${url}/status`, { method: 'POST', headers: auth })).status, 405);
});
