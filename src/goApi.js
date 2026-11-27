'use strict';
// Client for the Go internal Omi API (/api/internal/omi/*). The Go side is
// idempotent on provider_message_id, so forwarding may be retried safely.

class GoApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'GoApiError';
    this.status = status; // undefined for network errors / timeouts
  }
  get retryable() {
    return this.status === undefined || this.status === 429 || this.status >= 500;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function createGoApi({ baseUrl, secret, retryDelaysMs = [1000, 3000, 9000], timeoutMs = 60000, fetchImpl = fetch }) {
  const base = String(baseUrl).replace(/\/+$/, '');

  async function post(path, body) {
    let res;
    try {
      res = await fetchImpl(`${base}/api/internal/omi${path}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new GoApiError(`request failed: ${err.name}`);
    }
    if (res.status < 200 || res.status > 299) {
      await res.body?.cancel().catch(() => {});
      throw new GoApiError(`unexpected status ${res.status}`, res.status);
    }
    return res;
  }

  async function withRetry(fn) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn();
      } catch (err) {
        if (!(err instanceof GoApiError) || !err.retryable || attempt >= retryDelaysMs.length) throw err;
        await sleep(retryDelaysMs[attempt]);
      }
    }
  }

  return {
    // payload: {provider_message_id, from, display_name, body, timestamp} -> [{id,text}]
    async forwardMessage(payload) {
      return withRetry(async () => {
        const res = await post('/messages', payload);
        let data;
        try { data = await res.json(); } catch { throw new GoApiError('invalid JSON from Go', res.status); }
        return Array.isArray(data && data.replies) ? data.replies : [];
      });
    },
    async reportStatus(id, status, providerMessageId) {
      return withRetry(async () => {
        const res = await post(`/outbound/${encodeURIComponent(id)}/status`, { status, provider_message_id: providerMessageId || '' });
        await res.body?.cancel().catch(() => {});
      });
    },
    async reconcile() {
      return withRetry(async () => {
        const res = await post('/outbound/reconcile');
        await res.body?.cancel().catch(() => {});
      });
    },
  };
}

module.exports = { createGoApi, GoApiError };
