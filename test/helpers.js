'use strict';
// Test doubles: a fake whatsapp-web.js Client (EventEmitter) and a fake Go API
// on an ephemeral 127.0.0.1 port. Nothing here launches Chromium or leaves the host.
const { EventEmitter } = require('node:events');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

class FakeClient extends EventEmitter {
  constructor() {
    super();
    this.initialized = 0;
    this.destroyed = 0;
    this.sent = [];
    this.sendImpl = null; // async (to, text) => message | throws
    this.initImpl = null;
  }
  async initialize() {
    this.initialized++;
    if (this.initImpl) return this.initImpl();
  }
  async destroy() {
    this.destroyed++;
  }
  async sendMessage(to, text) {
    this.sent.push({ to, text });
    if (this.sendImpl) return this.sendImpl(to, text);
    return { id: { _serialized: `true_${to}_OUT${this.sent.length}`, id: `OUT${this.sent.length}` } };
  }
}

let seq = 0;
function fakeMessage(over = {}) {
  seq++;
  const from = over.from || '6281234567890@c.us';
  return {
    id: { _serialized: `false_${from}_IN${seq}`, id: `IN${seq}` },
    from,
    fromMe: false,
    isStatus: false,
    type: 'chat',
    body: 'kos jogja 1 juta',
    timestamp: 1764000000 + seq,
    _data: { notifyName: 'Budi' },
    ...over,
  };
}

// handler(req, bodyJson) => { status, json } | Promise of it
async function startFakeGo(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', async () => {
      let body = null;
      try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }
      const entry = { method: req.method, url: req.url, auth: req.headers.authorization, body };
      requests.push(entry);
      const out = (await handler(entry)) || { status: 204 };
      res.writeHead(out.status, { 'Content-Type': 'application/json' });
      res.end(out.json === undefined ? '' : JSON.stringify(out.json));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((r) => server.close(r)),
  };
}

function makeSessionDir(mode = 0o700) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omi-gw-test-'));
  fs.chmodSync(dir, mode);
  return dir;
}

const silentLogger = { info() {}, warn() {}, error() {} };

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(pred, timeoutMs = 2000) {
  const start = Date.now();
  while (!(await pred())) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await sleep(5);
  }
}

module.exports = { FakeClient, fakeMessage, startFakeGo, makeSessionDir, silentLogger, sleep, waitFor };
