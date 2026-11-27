'use strict';
// WhatsApp channel adapter (PRD §20.4): connect(), sendMessage(to, text),
// getStatus(), stop(), plus onMessage/onStatus callbacks. This is the only file
// that knows about whatsapp-web.js; a future official-API adapter implements
// the same shape. Tests inject a fake EventEmitter client via clientFactory.

const STATES = Object.freeze(['waiting_qr', 'authenticated', 'ready', 'auth_failure', 'disconnected']);
// Media a person sends on purpose. These are forwarded to Go with message_type
// (Go stores them and decides whether to reply, e.g. not while waiting_admin);
// the gateway never auto-replies itself. Other non-chat types (e2e_notification,
// revoked, ciphertext, call_log, ...) are system events and are ignored.
const MEDIA_TYPES = new Set([
  'image', 'video', 'audio', 'ptt', 'ptv', 'document', 'sticker',
  'location', 'vcard', 'multi_vcard', 'poll_creation',
]);

class DeliveryError extends Error {
  // deliveryStatus: 'failed' (never handed to WhatsApp) | 'unknown' (may have been sent)
  constructor(deliveryStatus, message) {
    super(message);
    this.name = 'DeliveryError';
    this.deliveryStatus = deliveryStatus;
  }
}

// Disconnect reasons from whatsapp-web.js are short enum-like strings
// (NAVIGATION, LOGOUT, CONFLICT, UNPAIRED, ...); keep only safe characters.
function safeReason(r) {
  const s = String(r ?? '').replace(/[^A-Za-z0-9_ .-]/g, '').slice(0, 64);
  return s || 'unknown';
}

function isIgnored(msg) {
  const from = String(msg.from || '');
  return Boolean(
    msg.fromMe ||
    msg.isStatus ||
    msg.broadcast ||
    !from ||
    from.endsWith('@g.us') ||
    from.endsWith('@broadcast') ||
    from.endsWith('@newsletter')
  );
}

function digitsOf(chatId) {
  return String(chatId).split('@')[0].replace(/\D/g, '');
}

function createAdapter({
  clientFactory,
  onMessage,
  onStatus = () => {},
  logger,
  sendTimeoutMs = 30000,
  backoffBaseMs = 5000,
  backoffMaxMs = 5 * 60 * 1000,
  maxReconnectAttempts = 6,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  now = Date.now,
}) {
  let status = { state: 'disconnected', qr: null, reason: 'not_started', since: new Date(now()).toISOString() };
  let current = null;
  let stopped = false;
  let reconnectTimer = null;
  let attempts = 0;
  const queues = new Map(); // chatId -> tail promise (per-chat sequential processing)

  function setState(state, { qr = null, reason = null } = {}) {
    if (!STATES.includes(state)) throw new Error(`invalid state ${state}`);
    const changed = state !== status.state || reason !== status.reason;
    status = {
      state,
      qr: state === 'waiting_qr' ? qr : null,
      reason,
      since: changed ? new Date(now()).toISOString() : status.since,
    };
    if (changed) {
      logger.info('wa_state', { state, reason });
      try { onStatus({ state, reason, since: status.since }); } catch { /* listener errors are not ours */ }
    }
  }

  function enqueue(chatId, task) {
    const prev = queues.get(chatId) || Promise.resolve();
    const tail = prev.then(task).catch((err) => {
      logger.error('message_task_failed', { error: err && err.name });
    });
    queues.set(chatId, tail);
    tail.then(() => { if (queues.get(chatId) === tail) queues.delete(chatId); });
    return tail;
  }

  // Go stores `from` as the contact's phone: digits for @c.us. Privacy ids
  // (@lid) carry no phone, so resolve it; if that fails send "lid:<digits>" so a
  // lid is never mistaken for a phone number.
  async function resolveFrom(c, chatId) {
    const id = String(chatId);
    if (!id.endsWith('@lid')) return digitsOf(id);
    try {
      const [res] = (await c.getContactLidAndPhone([id])) || [];
      const pn = res && res.pn ? digitsOf(res.pn) : '';
      if (pn) return pn;
    } catch {
      logger.warn('lid_lookup_failed');
    }
    logger.info('lid_unresolved');
    return `lid:${digitsOf(id)}`;
  }

  async function normalize(c, msg) {
    const isText = msg.type === 'chat';
    return {
      providerMessageId: msg.id && msg.id._serialized,
      shortId: msg.id && msg.id.id, // id without the phone-bearing chat part: safe to log
      chatId: msg.from,
      from: await resolveFrom(c, msg.from),
      displayName: (msg._data && msg._data.notifyName) || '',
      messageType: msg.type,
      // media: caption only (hasMedia); vcard/location bodies are not captions
      body: isText ? msg.body : (msg.hasMedia && typeof msg.body === 'string' ? msg.body : ''),
      timestamp: msg.timestamp,
    };
  }

  function handleIncoming(c, msg) {
    if (status.state !== 'ready') {
      logger.warn('message_dropped_not_ready', { state: status.state });
      return;
    }
    if (isIgnored(msg)) return;
    if (msg.type === 'chat') {
      if (typeof msg.body !== 'string' || !msg.body.trim()) return;
    } else if (!MEDIA_TYPES.has(msg.type)) {
      return;
    }
    enqueue(msg.from, async () => onMessage(await normalize(c, msg)));
  }

  function wire(c) {
    const mine = (fn) => (...args) => { if (c === current && !stopped) fn(...args); };
    // After LOGOUT whatsapp-web.js keeps the page and shows a new QR itself;
    // a live client emitting again means no reconnect is needed.
    const alive = () => {
      if (reconnectTimer !== null) {
        clearTimer(reconnectTimer);
        reconnectTimer = null;
      }
    };
    c.on('qr', mine((qr) => { alive(); setState('waiting_qr', { qr: String(qr) }); }));
    c.on('authenticated', mine(() => { alive(); setState('authenticated'); }));
    c.on('ready', mine(() => { alive(); attempts = 0; setState('ready'); }));
    c.on('auth_failure', mine(() => setState('auth_failure', { reason: 'auth_failure' })));
    c.on('disconnected', mine((reason) => {
      setState('disconnected', { reason: safeReason(reason) });
      scheduleReconnect();
    }));
    c.on('message', mine((msg) => handleIncoming(c, msg)));
  }

  function scheduleReconnect() {
    if (stopped || reconnectTimer !== null) return;
    if (attempts >= maxReconnectAttempts) {
      setState('disconnected', { reason: 'reconnect_exhausted' }); // admin action needed
      return;
    }
    const delay = Math.min(backoffBaseMs * 2 ** attempts, backoffMaxMs);
    attempts++;
    logger.info('wa_reconnect_scheduled', { attempt: attempts, delayMs: delay });
    reconnectTimer = setTimer(async () => {
      reconnectTimer = null;
      const old = current;
      current = null;
      if (old) {
        try { await old.destroy(); } catch { /* browser may already be gone */ }
      }
      await api.connect();
    }, delay);
  }

  const api = {
    async connect() {
      if (stopped) return;
      const c = clientFactory();
      current = c;
      wire(c);
      try {
        await c.initialize();
      } catch (err) {
        if (c !== current || stopped) return;
        logger.error('wa_initialize_failed', { error: err && err.name });
        setState('disconnected', { reason: 'initialize_failed' });
        scheduleReconnect();
      }
    },

    // Resolves with the provider message id. Rejects with DeliveryError:
    // 'failed' when nothing was handed to WhatsApp, 'unknown' once the send
    // call started (it may or may not have gone out; never auto-resend).
    async sendMessage(to, text) {
      const c = current;
      if (!c || stopped || status.state !== 'ready') throw new DeliveryError('failed', 'not_ready');
      let timer;
      const started = Promise.resolve().then(() => c.sendMessage(to, text));
      started.catch(() => {});
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new DeliveryError('unknown', 'send_timeout')), sendTimeoutMs);
      });
      try {
        const sent = await Promise.race([started, timeout]);
        const id = sent && sent.id && sent.id._serialized;
        // whatsapp-web.js resolves undefined when no chat was found / nothing was
        // sent: the outcome is uncertain, never report it as sent
        if (typeof id !== 'string' || !id) throw new DeliveryError('unknown', 'send_no_result');
        return id;
      } catch (err) {
        if (err instanceof DeliveryError) throw err;
        throw new DeliveryError('unknown', 'send_error');
      } finally {
        clearTimeout(timer);
      }
    },

    getStatus() {
      return { ...status };
    },

    async stop() {
      stopped = true;
      if (reconnectTimer !== null) {
        clearTimer(reconnectTimer);
        reconnectTimer = null;
      }
      const c = current;
      current = null;
      if (c) {
        try { await c.destroy(); } catch { /* already closed */ }
      }
    },
  };
  return api;
}

// Real whatsapp-web.js client. Required lazily so tests never load Puppeteer.
// --no-sandbox: see README ("Why --no-sandbox").
function createWhatsAppClientFactory({ sessionDir, executablePath }) {
  return () => {
    const { Client, LocalAuth } = require('whatsapp-web.js');
    return new Client({
      authStrategy: new LocalAuth({ dataPath: sessionDir }),
      puppeteer: {
        headless: true,
        args: ['--no-sandbox'],
        ...(executablePath ? { executablePath } : {}),
      },
    });
  };
}

module.exports = { createAdapter, createWhatsAppClientFactory, DeliveryError, STATES };
