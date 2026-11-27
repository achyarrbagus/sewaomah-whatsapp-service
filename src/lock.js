'use strict';
// Single-instance guard: an exclusive pid lock file inside OMI_SESSION_DIR.
// Two processes driving the same WhatsApp session corrupt it (PRD §20.2.1).
const fs = require('node:fs');
const path = require('node:path');

const LOCK_NAME = '.gateway.lock';

class LockHeldError extends Error {
  constructor(pid) {
    super(`session lock is held by live pid ${pid}`);
    this.name = 'LockHeldError';
    this.pid = pid;
  }
}

function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM'; // exists but owned by someone else
  }
}

function acquireLock(dir) {
  const file = path.join(dir, LOCK_NAME);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(file, 'wx', 0o600);
      fs.writeSync(fd, `${process.pid}\n`);
      fs.closeSync(fd);
      let released = false;
      return {
        file,
        release() {
          if (released) return;
          released = true;
          try {
            if (fs.readFileSync(file, 'utf8').trim() === String(process.pid)) fs.unlinkSync(file);
          } catch { /* already gone */ }
        },
      };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      let pid = NaN;
      try { pid = Number.parseInt(fs.readFileSync(file, 'utf8').trim(), 10); } catch { /* vanished */ }
      if (isAlive(pid)) throw new LockHeldError(pid);
      try { fs.unlinkSync(file); } catch { /* raced with another remover */ }
    }
  }
  throw new LockHeldError(NaN);
}

module.exports = { acquireLock, LockHeldError, LOCK_NAME };
