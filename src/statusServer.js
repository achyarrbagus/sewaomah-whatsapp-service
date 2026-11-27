'use strict';
// Local status endpoint for the Go admin API only: binds 127.0.0.1, bearer auth,
// never cacheable. The QR payload is only ever returned here (PRD §20.2.2).
const http = require('node:http');
const crypto = require('node:crypto');

function safeEqual(a, b) {
  // hash first so lengths match and the compare is constant time
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function bearerOk(header, secret) {
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  return safeEqual(header.slice(7), secret);
}

function send(res, status, body) {
  const payload = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function createStatusServer({ secret, getStatus, logger }) {
  const server = http.createServer((req, res) => {
    const pathname = (req.url || '').split('?')[0];
    if (!bearerOk(req.headers.authorization, secret)) {
      logger.warn('status_unauthorized');
      return send(res, 401, { message: 'Unauthorized' });
    }
    if (pathname !== '/status') return send(res, 404, { message: 'Not Found' });
    if (req.method !== 'GET') return send(res, 405, { message: 'Method Not Allowed' });
    const s = getStatus();
    return send(res, 200, {
      state: s.state,
      qr: s.state === 'waiting_qr' ? s.qr ?? null : null,
      reason: s.reason ?? null,
      since: s.since,
    });
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 5000;
  return server;
}

module.exports = { createStatusServer, bearerOk };
