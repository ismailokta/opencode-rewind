import { randomUUID } from 'node:crypto';

// Waiters are trusted TUI long-polls; any one of them may answer an observation.
export class ObservationBridge {
  constructor(timeout = 10000) { this.timeout = timeout; this.waiters = new Set(); this.pending = new Map(); }
  next(signal) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new Error('disconnected'));
      const waiter = { resolve, reject };
      const abort = () => { this.waiters.delete(waiter); reject(new Error('disconnected')); };
      waiter.deliver = (value) => { signal?.removeEventListener('abort', abort); resolve(value); };
      this.waiters.add(waiter);
      signal?.addEventListener('abort', abort, { once: true });
    });
  }
  // Observation is read-only and the host state is server-wide, so any connected TUI can answer.
  // Several TUIs may share one server: try them in turn, and fail closed when none answers.
  async observe(sessionID) {
    const tried = new Set();
    for (;;) {
      const waiter = [...this.waiters].find(w => !tried.has(w));
      if (!waiter) return 'unknown';
      tried.add(waiter); this.waiters.delete(waiter);
      const nonce = randomUUID(), deadline = Date.now() + this.timeout;
      const state = await new Promise(resolve => {
        const timer = setTimeout(() => { this.pending.delete(nonce); resolve('unknown'); }, this.timeout);
        this.pending.set(nonce, { resolve, timer, deadline });
        waiter.deliver({ nonce, sessionID });
      });
      if (state !== 'unknown') return state;
    }
  }
  reply({ nonce, state }) {
    const item = this.pending.get(nonce);
    if (!item || Date.now() >= item.deadline || !['active', 'idle', 'unknown'].includes(state)) return { accepted: false };
    this.pending.delete(nonce); clearTimeout(item.timer); item.resolve(state); return { accepted: true };
  }
  close() {
    for (const waiter of this.waiters) waiter.reject(new Error('bridge closed'));
    this.waiters.clear();
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.resolve('unknown'); }
    this.pending.clear();
  }
}
