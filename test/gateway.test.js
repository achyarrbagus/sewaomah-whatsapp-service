'use strict';
// Gateway wiring: fake WhatsApp client + real goApi against a local fake Go API.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createGateway } = require('../src/index');
const { createGoApi } = require('../src/goApi');
const { FakeClient, fakeMessage, startFakeGo, silentLogger, sleep, waitFor } = require('./helpers');

const SECRET = 's'.repeat(40);

async function setup(handler, adapterOpts = {}) {
  const go = await startFakeGo(handler);
  const clients = [];
  const goApi = createGoApi({ baseUrl: go.url, secret: SECRET, retryDelaysMs: [5, 10], timeoutMs: 1000 });
  const gw = createGateway({
    clientFactory: () => { const c = new FakeClient(); clients.push(c); return c; },
    goApi,
    logger: silentLogger,
    adapterOptions: adapterOpts,
  });
  await gw.start();
  clients[0].emit('ready');
  return { go, gw, client: clients[0] };
}

const msgs = (go) => go.requests.filter((r) => r.url === '/api/internal/omi/messages');
const statuses = (go) => go.requests.filter((r) => /\/outbound\/[^/]+\/status$/.test(r.url));

function replyHandler(fn) {
  return (r) => {
    if (r.url === '/api/internal/omi/messages') return fn(r);
    return { status: 204 };
  };
}

test('start calls reconcile with the bearer secret', async (t) => {
  const { go, gw } = await setup(replyHandler(() => ({ status: 200, json: { replies: [] } })));
  t.after(async () => { await gw.stop(); await go.close(); });
  const rec = go.requests.find((r) => r.url === '/api/internal/omi/outbound/reconcile');
  assert.ok(rec);
  assert.equal(rec.method, 'POST');
  assert.equal(rec.auth, `Bearer ${SECRET}`);
});

test('text message is forwarded and replies are sent and reported sent', async (t) => {
  const { go, gw, client } = await setup(replyHandler(() => ({
    status: 200, json: { replies: [{ id: 'r1', text: 'hasil 1' }, { id: 'r2', text: 'hasil 2' }] },
  })));
  t.after(async () => { await gw.stop(); await go.close(); });
  const m = fakeMessage();
  client.emit('message', m);
  await waitFor(() => statuses(go).length === 2);
  const fwd = msgs(go)[0];
  assert.equal(fwd.auth, `Bearer ${SECRET}`);
  assert.deepEqual(fwd.body, {
    provider_message_id: m.id._serialized, from: '6281234567890', display_name: 'Budi',
    body: 'kos jogja 1 juta', timestamp: m.timestamp, message_type: 'chat',
  });
  assert.deepEqual(client.sent.map((s) => [s.to, s.text]), [['6281234567890@c.us', 'hasil 1'], ['6281234567890@c.us', 'hasil 2']]);
  const st = statuses(go);
  assert.equal(st[0].url, '/api/internal/omi/outbound/r1/status');
  assert.deepEqual(st[0].body, { status: 'sent', provider_message_id: 'true_6281234567890@c.us_OUT1' });
  assert.equal(st[1].url, '/api/internal/omi/outbound/r2/status');
});

test('image is forwarded with message_type and Go\'s reply is sent', async (t) => {
  const { go, gw, client } = await setup(replyHandler((r) => ({
    status: 200, json: { replies: r.body.message_type === 'image' ? [{ id: 'r-img', text: 'Omi baru bisa membaca pesan teks.' }] : [] },
  })));
  t.after(async () => { await gw.stop(); await go.close(); });
  const m = fakeMessage({ type: 'image', hasMedia: true, body: '' });
  client.emit('message', m);
  await waitFor(() => statuses(go).length === 1);
  const fwd = msgs(go)[0].body;
  assert.equal(fwd.message_type, 'image');
  assert.equal(fwd.body, '');
  assert.equal(fwd.provider_message_id, m.id._serialized);
  assert.deepEqual(client.sent.map((s) => s.text), ['Omi baru bisa membaca pesan teks.']);
  assert.deepEqual(statuses(go)[0].body.status, 'sent');
});

test('Go returning no replies for media (waiting_admin) means the gateway stays silent', async (t) => {
  const { go, gw, client } = await setup(replyHandler(() => ({ status: 200, json: { replies: [] } })));
  t.after(async () => { await gw.stop(); await go.close(); });
  client.emit('message', fakeMessage({ type: 'sticker', hasMedia: true, body: '' }));
  await waitFor(() => msgs(go).length === 1);
  await sleep(30);
  assert.equal(client.sent.length, 0);
});

test('empty send result is reported unknown, not sent', async (t) => {
  const { go, gw, client } = await setup(replyHandler(() => ({ status: 200, json: { replies: [{ id: 'r-e', text: 'x' }] } })));
  t.after(async () => { await gw.stop(); await go.close(); });
  client.sendImpl = async () => undefined;
  client.emit('message', fakeMessage());
  await waitFor(() => statuses(go).length === 1);
  assert.deepEqual(statuses(go)[0].body, { status: 'unknown', provider_message_id: '' });
  assert.equal(client.sent.length, 1);
});

test('group message is not forwarded to Go', async (t) => {
  const { go, gw, client } = await setup(replyHandler(() => ({ status: 200, json: { replies: [] } })));
  t.after(async () => { await gw.stop(); await go.close(); });
  client.emit('message', fakeMessage({ from: '120363000000000000@g.us' }));
  await sleep(40);
  assert.equal(msgs(go).length, 0);
  assert.equal(client.sent.length, 0);
});

test('fromMe message is not forwarded to Go', async (t) => {
  const { go, gw, client } = await setup(replyHandler(() => ({ status: 200, json: { replies: [] } })));
  t.after(async () => { await gw.stop(); await go.close(); });
  client.emit('message', fakeMessage({ fromMe: true }));
  await sleep(40);
  assert.equal(msgs(go).length, 0);
});

test('two messages from one chat: second is forwarded only after first replies are sent', async (t) => {
  const events = [];
  const { go, gw, client } = await setup(replyHandler(async (r) => {
    events.push(`fwd:${r.body.body}`);
    if (r.body.body === 'first') await sleep(60);
    return { status: 200, json: { replies: [{ id: `id-${r.body.body}`, text: `re:${r.body.body}` }] } };
  }));
  t.after(async () => { await gw.stop(); await go.close(); });
  client.sendImpl = async (to, text) => { events.push(`send:${text}`); return { id: { _serialized: `o-${text}` } }; };
  client.emit('message', fakeMessage({ body: 'first' }));
  client.emit('message', fakeMessage({ body: 'second' }));
  await waitFor(() => statuses(go).length === 2);
  assert.deepEqual(events, ['fwd:first', 'send:re:first', 'fwd:second', 'send:re:second']);
});

test('send throws after start -> status unknown, never resent', async (t) => {
  const { go, gw, client } = await setup(replyHandler(() => ({
    status: 200, json: { replies: [{ id: 'r-unk', text: 'hasil' }] },
  })));
  t.after(async () => { await gw.stop(); await go.close(); });
  client.sendImpl = async () => { throw new Error('Evaluation failed'); };
  client.emit('message', fakeMessage());
  await waitFor(() => statuses(go).length === 1);
  await sleep(50);
  assert.equal(client.sent.length, 1, 'unknown must not be resent');
  assert.equal(statuses(go).length, 1);
  assert.equal(statuses(go)[0].url, '/api/internal/omi/outbound/r-unk/status');
  assert.deepEqual(statuses(go)[0].body, { status: 'unknown', provider_message_id: '' });
});

test('send before ready (disconnected mid-batch) -> status failed', async (t) => {
  let clientRef;
  const { go, gw, client } = await setup(replyHandler(() => {
    clientRef.emit('disconnected', 'NAVIGATION');
    return { status: 200, json: { replies: [{ id: 'r-f', text: 'hasil' }] } };
  }), { setTimer: () => 1, clearTimer: () => {} });
  clientRef = client;
  t.after(async () => { await gw.stop(); await go.close(); });
  client.emit('message', fakeMessage());
  await waitFor(() => statuses(go).length === 1);
  assert.equal(client.sent.length, 0);
  assert.deepEqual(statuses(go)[0].body, { status: 'failed', provider_message_id: '' });
});

test('forward retries 5xx with backoff, then succeeds (same provider_message_id)', async (t) => {
  let n = 0;
  const { go, gw, client } = await setup(replyHandler(() => {
    n++;
    if (n < 3) return { status: 500, json: { message: 'x' } };
    return { status: 200, json: { replies: [{ id: 'r', text: 'ok' }] } };
  }));
  t.after(async () => { await gw.stop(); await go.close(); });
  client.emit('message', fakeMessage());
  await waitFor(() => statuses(go).length === 1);
  const f = msgs(go);
  assert.equal(f.length, 3);
  assert.ok(f.every((r) => r.body.provider_message_id === f[0].body.provider_message_id));
  assert.equal(client.sent.length, 1);
});

test('forward gives up after bounded retries and does not block the chat', async (t) => {
  const { go, gw, client } = await setup(replyHandler((r) => {
    if (r.body.body === 'bad') return { status: 503, json: {} };
    return { status: 200, json: { replies: [{ id: 'r', text: 'ok' }] } };
  }));
  t.after(async () => { await gw.stop(); await go.close(); });
  client.emit('message', fakeMessage({ body: 'bad' }));
  client.emit('message', fakeMessage({ body: 'good' }));
  await waitFor(() => statuses(go).length === 1);
  assert.equal(msgs(go).filter((r) => r.body.body === 'bad').length, 3);
  assert.equal(client.sent.length, 1);
});

test('4xx from Go is not retried', async (t) => {
  const { go, gw, client } = await setup(replyHandler(() => ({ status: 400, json: { message: 'bad' } })));
  t.after(async () => { await gw.stop(); await go.close(); });
  client.emit('message', fakeMessage());
  await sleep(80);
  assert.equal(msgs(go).length, 1);
  assert.equal(client.sent.length, 0);
});
