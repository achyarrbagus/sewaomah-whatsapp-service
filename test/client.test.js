'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createAdapter } = require('../src/client');
const NON_TEXT_REPLY = require('../src/client').NON_TEXT_REPLY;
const { FakeClient, fakeMessage, silentLogger, sleep, waitFor } = require('./helpers');

function setup(opts = {}) {
  const clients = [];
  const handled = [];
  const statuses = [];
  const adapter = createAdapter({
    clientFactory: () => {
      const c = new FakeClient();
      clients.push(c);
      return c;
    },
    onMessage: opts.onMessage || (async (m) => { handled.push(m); }),
    onStatus: (s) => statuses.push(s),
    logger: silentLogger,
    ...opts.adapter,
  });
  return { adapter, clients, handled, statuses };
}

async function ready(t) {
  await t.adapter.connect();
  t.clients[0].emit('ready');
  return t.clients[0];
}

test('state machine: qr only while waiting_qr; authenticated is not ready', async () => {
  const t = setup();
  assert.equal(t.adapter.getStatus().qr, null);
  await t.adapter.connect();
  const c = t.clients[0];
  assert.equal(c.initialized, 1);
  c.emit('qr', 'QR-PAYLOAD');
  let s = t.adapter.getStatus();
  assert.equal(s.state, 'waiting_qr');
  assert.equal(s.qr, 'QR-PAYLOAD');
  assert.ok(!Number.isNaN(Date.parse(s.since)));
  c.emit('authenticated');
  s = t.adapter.getStatus();
  assert.equal(s.state, 'authenticated');
  assert.equal(s.qr, null);
  c.emit('message', fakeMessage());
  await sleep(10);
  assert.equal(t.handled.length, 0, 'authenticated must not process messages');
  c.emit('ready');
  assert.equal(t.adapter.getStatus().state, 'ready');
  c.emit('auth_failure', 'secret details');
  s = t.adapter.getStatus();
  assert.equal(s.state, 'auth_failure');
  assert.equal(s.qr, null);
  assert.ok(!String(s.reason).includes('secret'));
  assert.deepEqual(t.statuses.map((x) => x.state), ['waiting_qr', 'authenticated', 'ready', 'auth_failure']);
  assert.ok(t.statuses.every((x) => !('qr' in x) || x.qr === null || x.state === 'waiting_qr'));
});

test('group message is ignored', async () => {
  const t = setup();
  const c = await ready(t);
  c.emit('message', fakeMessage({ from: '120363000000000000@g.us', author: '6281234567890@c.us' }));
  await sleep(20);
  assert.equal(t.handled.length, 0);
  assert.equal(c.sent.length, 0);
});

test('fromMe, status broadcast and isStatus messages are ignored', async () => {
  const t = setup();
  const c = await ready(t);
  c.emit('message', fakeMessage({ fromMe: true }));
  c.emit('message', fakeMessage({ isStatus: true }));
  c.emit('message', fakeMessage({ from: 'status@broadcast' }));
  await sleep(20);
  assert.equal(t.handled.length, 0);
  assert.equal(c.sent.length, 0);
});

test('media is forwarded with message_type and caption, never auto-replied by the gateway', async () => {
  const t = setup();
  const c = await ready(t);
  c.emit('message', fakeMessage({ type: 'image', hasMedia: true, body: 'kamarnya begini' }));
  c.emit('message', fakeMessage({ type: 'ptt', hasMedia: true, body: '' }));
  // vcard/location bodies carry vCard text / thumbnails, not a caption: sent as ''
  c.emit('message', fakeMessage({ type: 'vcard', hasMedia: false, body: 'BEGIN:VCARD TEL:62811' }));
  c.emit('message', fakeMessage({ type: 'e2e_notification', body: '' })); // system: silent
  await waitFor(() => t.handled.length === 3);
  await sleep(20);
  assert.deepEqual(t.handled.map((m) => [m.messageType, m.body]), [['image', 'kamarnya begini'], ['ptt', ''], ['vcard', '']]);
  assert.equal(c.sent.length, 0, 'the gateway itself never replies to media');
  assert.equal(NON_TEXT_REPLY, undefined, 'non-text copy lives in Go');
});

test('normalized message: digits-only from, chat id kept for replies', async () => {
  const t = setup();
  const c = await ready(t);
  const m = fakeMessage();
  c.emit('message', m);
  await waitFor(() => t.handled.length === 1);
  const h = t.handled[0];
  assert.equal(h.providerMessageId, m.id._serialized);
  assert.equal(h.from, '6281234567890');
  assert.equal(h.chatId, '6281234567890@c.us');
  assert.equal(h.displayName, 'Budi');
  assert.equal(h.body, 'kos jogja 1 juta');
  assert.equal(h.timestamp, m.timestamp);
  assert.equal(h.messageType, 'chat');
});

test('@lid sender: phone resolved via getContactLidAndPhone, else "lid:<digits>"', async () => {
  const t = setup();
  const c = await ready(t);
  const asked = [];
  c.getContactLidAndPhone = async (ids) => {
    asked.push(ids);
    return ids[0] === '111222333@lid' ? [{ lid: '111222333@lid', pn: '6281234567890@c.us' }] : [{ lid: ids[0], pn: undefined }];
  };
  c.emit('message', fakeMessage({ from: '111222333@lid' }));
  c.emit('message', fakeMessage({ from: '444555666@lid' }));
  await waitFor(() => t.handled.length === 2);
  const byChat = Object.fromEntries(t.handled.map((m) => [m.chatId, m.from]));
  assert.equal(byChat['111222333@lid'], '6281234567890');
  assert.equal(byChat['444555666@lid'], 'lid:444555666');
  assert.deepEqual(asked.sort(), [['111222333@lid'], ['444555666@lid']]);
});

test('@lid sender: lookup throws -> "lid:<digits>", never plain lid digits', async () => {
  const t = setup();
  const c = await ready(t);
  c.getContactLidAndPhone = async () => { throw new Error('page gone'); };
  c.emit('message', fakeMessage({ from: '777888999@lid' }));
  await waitFor(() => t.handled.length === 1);
  assert.equal(t.handled[0].from, 'lid:777888999');
  assert.equal(t.handled[0].chatId, '777888999@lid');
});

test('two messages from one chat are processed in order; other chats run concurrently', async () => {
  const order = [];
  const t = setup({
    onMessage: async (m) => {
      order.push(`start:${m.body}`);
      if (m.body === 'first') await sleep(60);
      order.push(`end:${m.body}`);
    },
  });
  const c = await ready(t);
  c.emit('message', fakeMessage({ body: 'first' }));
  c.emit('message', fakeMessage({ body: 'second' }));
  c.emit('message', fakeMessage({ body: 'other', from: '6289999999999@c.us' }));
  await waitFor(() => order.length === 6);
  assert.ok(order.indexOf('end:first') < order.indexOf('start:second'), order.join(','));
  assert.ok(order.indexOf('end:other') < order.indexOf('end:first'), 'other chat must not wait');
});

test('a failing handler does not block the chat queue', async () => {
  const seen = [];
  const t = setup({
    onMessage: async (m) => {
      seen.push(m.body);
      if (m.body === 'boom') throw new Error('x');
    },
  });
  const c = await ready(t);
  c.emit('message', fakeMessage({ body: 'boom' }));
  c.emit('message', fakeMessage({ body: 'after' }));
  await waitFor(() => seen.length === 2);
  assert.deepEqual(seen, ['boom', 'after']);
});

test('sendMessage: not ready -> failed without calling the client', async () => {
  const t = setup();
  await t.adapter.connect();
  await assert.rejects(t.adapter.sendMessage('6281@c.us', 'hi'), (e) => e.deliveryStatus === 'failed');
  assert.equal(t.clients[0].sent.length, 0);
});

test('sendMessage: success returns provider id; throw after start -> unknown; timeout -> unknown', async () => {
  const t = setup({ adapter: { sendTimeoutMs: 30 } });
  const c = await ready(t);
  assert.equal(await t.adapter.sendMessage('6281@c.us', 'hi'), 'true_6281@c.us_OUT1');
  c.sendImpl = async () => { throw new Error('evaluation failed'); };
  await assert.rejects(t.adapter.sendMessage('6281@c.us', 'hi'), (e) => e.deliveryStatus === 'unknown');
  c.sendImpl = () => new Promise(() => {});
  await assert.rejects(t.adapter.sendMessage('6281@c.us', 'hi'), (e) => e.deliveryStatus === 'unknown');
  // whatsapp-web.js resolves undefined when no chat is found / nothing was sent
  for (const result of [undefined, null, {}, { id: {} }, { id: { _serialized: '' } }]) {
    c.sendImpl = async () => result;
    await assert.rejects(t.adapter.sendMessage('6281@c.us', 'hi'), (e) => e.deliveryStatus === 'unknown');
  }
  assert.equal(c.sent.length, 8);
});

test('disconnected: exponential backoff 5s..5min, max 6 attempts, then stays disconnected', async () => {
  const delays = [];
  const timers = [];
  const t = setup({
    adapter: {
      setTimer: (fn, ms) => { delays.push(ms); timers.push(fn); return timers.length; },
      clearTimer: () => {},
    },
  });
  await ready(t);
  t.clients[0].emit('disconnected', 'NAVIGATION');
  assert.equal(t.adapter.getStatus().state, 'disconnected');
  assert.equal(t.adapter.getStatus().reason, 'NAVIGATION');
  // every reconnect attempt fails to initialize
  for (let i = 0; i < 10 && timers.length > i; i++) {
    const next = timers[i];
    const before = t.clients.length;
    await next();
    if (t.clients.length > before) {
      const c = t.clients[t.clients.length - 1];
      assert.equal(c.initialized, 1);
      c.emit('disconnected', 'NAVIGATION');
    }
  }
  assert.deepEqual(delays, [5000, 10000, 20000, 40000, 80000, 160000]);
  assert.equal(t.clients.length, 7);
  assert.ok(t.clients.slice(0, 6).every((c) => c.destroyed === 1), 'old clients destroyed');
  const s = t.adapter.getStatus();
  assert.equal(s.state, 'disconnected');
  assert.equal(s.reason, 'reconnect_exhausted');
});

test('disconnected then ready resets the backoff', async () => {
  const delays = [];
  const timers = [];
  const t = setup({
    adapter: { setTimer: (fn, ms) => { delays.push(ms); timers.push(fn); return 1; }, clearTimer: () => {} },
  });
  await ready(t);
  t.clients[0].emit('disconnected', 'CONFLICT');
  await timers[0]();
  t.clients[1].emit('ready');
  t.clients[1].emit('disconnected', 'CONFLICT');
  assert.deepEqual(delays, [5000, 5000]);
});

test('stop destroys the client and cancels reconnects', async () => {
  let cleared = 0;
  const t = setup({ adapter: { setTimer: () => 42, clearTimer: () => { cleared++; } } });
  await ready(t);
  t.clients[0].emit('disconnected', 'NAVIGATION');
  await t.adapter.stop();
  assert.equal(cleared, 1);
  assert.ok(t.clients[0].destroyed >= 1);
});

test('LOGOUT then a fresh qr on the same client cancels the pending reconnect', async () => {
  let cleared = 0;
  const t = setup({ adapter: { setTimer: () => 7, clearTimer: () => { cleared++; } } });
  const c = await ready(t);
  c.emit('disconnected', 'LOGOUT');
  assert.equal(t.adapter.getStatus().reason, 'LOGOUT');
  c.emit('qr', 'NEW-QR');
  assert.equal(cleared, 1);
  assert.equal(t.adapter.getStatus().state, 'waiting_qr');
  assert.equal(t.clients.length, 1);
});
