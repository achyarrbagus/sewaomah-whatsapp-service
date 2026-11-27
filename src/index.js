'use strict';
// Omi WhatsApp gateway: a channel adapter only. Incoming text -> Go API,
// Go's replies -> WhatsApp, delivery status -> Go. No conversation logic here.
//
// Logging rule: never log message bodies, phone numbers / chat ids, or the QR
// string. Log ids (Go reply ids, the short WhatsApp message id), counts, states.
const fs = require('node:fs');
const path = require('node:path');
const { createAdapter, createWhatsAppClientFactory } = require('./client');
const { createGoApi } = require('./goApi');
const { createStatusServer } = require('./statusServer');
const { acquireLock, LockHeldError } = require('./lock');

class ConfigError extends Error {}

function loadConfig(env) {
  const secret = env.OMI_GATEWAY_SECRET || '';
  if (secret.length < 32) throw new ConfigError('OMI_GATEWAY_SECRET must be at least 32 characters');

  if (!env.OMI_SESSION_DIR) throw new ConfigError('OMI_SESSION_DIR is required');
  const sessionDir = path.resolve(env.OMI_SESSION_DIR);
  let st;
  try {
    st = fs.statSync(sessionDir);
  } catch {
    throw new ConfigError('OMI_SESSION_DIR does not exist (create it with mode 0700)');
  }
  if (!st.isDirectory()) throw new ConfigError('OMI_SESSION_DIR is not a directory');
  if ((st.mode & 0o777) !== 0o700) {
    throw new ConfigError(`OMI_SESSION_DIR must have mode 0700 (has ${(st.mode & 0o777).toString(8).padStart(4, '0')})`);
  }
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) {
    throw new ConfigError('OMI_SESSION_DIR must be owned by the gateway user');
  }

  const apiUrl = env.OMI_API_URL || 'http://127.0.0.1:8081';
  let u;
  try { u = new URL(apiUrl); } catch { throw new ConfigError('OMI_API_URL is not a valid URL'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new ConfigError('OMI_API_URL must be http(s)');

  const portRaw = env.OMI_GATEWAY_PORT === undefined || env.OMI_GATEWAY_PORT === '' ? '8095' : env.OMI_GATEWAY_PORT;
  if (!/^\d+$/.test(portRaw) || Number(portRaw) > 65535) throw new ConfigError('OMI_GATEWAY_PORT must be a port number');

  return {
    secret,
    sessionDir,
    apiUrl,
    port: Number(portRaw),
    chromiumPath: env.OMI_CHROMIUM_PATH || undefined,
  };
}

function createLogger(out = process.stdout, err = process.stderr) {
  const line = (stream, level, event, fields) =>
    stream.write(`${JSON.stringify({ time: new Date().toISOString(), level, event, ...fields })}\n`);
  return {
    info: (event, fields) => line(out, 'info', event, fields),
    warn: (event, fields) => line(err, 'warn', event, fields),
    error: (event, fields) => line(err, 'error', event, fields),
  };
}

function createGateway({ clientFactory, goApi, logger, adapterOptions = {} }) {
  let adapter;

  async function handleMessage(m) {
    let replies;
    try {
      replies = await goApi.forwardMessage({
        provider_message_id: m.providerMessageId,
        from: m.from,
        display_name: m.displayName,
        body: m.body,
        timestamp: m.timestamp,
        message_type: m.messageType, // 'chat' for text, else the media type (Go replies/stays silent)
      });
    } catch (err) {
      logger.error('forward_failed', { msg: m.shortId, status: err.status, error: err.name });
      return;
    }
    logger.info('forwarded', { msg: m.shortId, replies: replies.length });

    for (const r of replies) {
      if (!r || typeof r.id !== 'string' || !r.id) continue;
      let status = 'sent';
      let providerId = '';
      if (typeof r.text !== 'string' || !r.text) {
        status = 'failed';
      } else {
        try {
          providerId = await adapter.sendMessage(m.chatId, r.text);
        } catch (err) {
          status = err.deliveryStatus || 'unknown';
        }
      }
      logger.info('reply_delivery', { reply: r.id, status });
      try {
        await goApi.reportStatus(r.id, status, providerId);
      } catch (err) {
        logger.error('status_report_failed', { reply: r.id, status: err.status, error: err.name });
      }
    }
  }

  adapter = createAdapter({
    clientFactory,
    onMessage: handleMessage,
    onStatus: () => {}, // state changes are logged by the adapter; /status serves them
    logger,
    ...adapterOptions,
  });

  return {
    adapter,
    async start() {
      try {
        await goApi.reconcile();
        logger.info('reconciled');
      } catch (err) {
        logger.warn('reconcile_failed', { status: err.status, error: err.name });
      }
      await adapter.connect();
    },
    stop: () => adapter.stop(),
  };
}

async function main() {
  const logger = createLogger();
  let config;
  try {
    config = loadConfig(process.env);
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    process.stderr.write(`omi-gateway: refusing to start: ${err.message}\n`);
    process.exit(1);
  }

  let lock;
  try {
    lock = acquireLock(config.sessionDir);
  } catch (err) {
    if (err instanceof LockHeldError) {
      process.stderr.write(`omi-gateway: another gateway holds the session lock (pid ${err.pid}); exiting\n`);
    } else {
      process.stderr.write(`omi-gateway: cannot create session lock: ${err.code || err.name}\n`);
    }
    process.exit(1);
  }
  process.on('exit', () => lock.release());

  const gateway = createGateway({
    clientFactory: createWhatsAppClientFactory({ sessionDir: config.sessionDir, executablePath: config.chromiumPath }),
    goApi: createGoApi({ baseUrl: config.apiUrl, secret: config.secret }),
    logger,
  });

  const server = createStatusServer({ secret: config.secret, getStatus: gateway.adapter.getStatus, logger });
  server.on('error', (err) => {
    logger.error('status_server_error', { code: err.code });
    lock.release();
    process.exit(1);
  });
  await new Promise((resolve) => server.listen(config.port, '127.0.0.1', resolve));
  logger.info('status_server_listening', { port: server.address().port });

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('shutdown', { signal });
    server.close();
    const force = setTimeout(() => { lock.release(); process.exit(1); }, 15000);
    force.unref();
    try { await gateway.stop(); } catch (err) { logger.error('shutdown_destroy_failed', { error: err.name }); }
    lock.release();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (err) => logger.error('unhandled_rejection', { error: err && err.name }));

  await gateway.start();
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`omi-gateway: fatal: ${err && err.name}\n`);
    process.exit(1);
  });
}

module.exports = { createGateway, loadConfig, createLogger, ConfigError };
