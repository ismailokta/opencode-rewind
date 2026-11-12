import { randomUUID, createHash } from 'node:crypto';
import { capture } from './snapshot.js';
import { preview, readTree, restorePath, fingerprint, applyOne, applyChanges, sameEntry } from './transaction.js';

// A released snapshot is recorded as a reclamation tombstone. The server's reclaim
// pass deletes its ref only after confirming no binding, journal or archive uses it.
export const releaseKey = snapshot => 'rewind-deleted-' + createHash('sha256').update(`release:${snapshot.repo}\0${snapshot.ref}`).digest('hex');
const isNotFound = error => /SessionNotFound|not found/i.test(`${error?._tag || ''} ${error?.name || ''} ${error?.message || ''}`);
const stagedAt = (revert, j) => !!revert && revert.messageID === j.messageID && !revert.partID;

// Serializes journal and binding mutations. Server instances share a queue within the process;
// operation is not locked against other OpenCode processes.
export class Workflow {
  constructor({ storage, session, observe, getBinding, snapshot = capture, onRelease, queueState }) {
    Object.assign(this, { storage, session, observe, getBinding, snapshot, onRelease });
    this.queueState = queueState || { queue: Promise.resolve() };
    this.journal = { get: () => storage.get('rewind-journal'), set: value => value === null ? storage.remove('rewind-journal') : storage.set('rewind-journal', value) };
  }
  exclusive(fn) {
    const run = this.queueState.queue.then(fn);
    this.queueState.queue = run.catch(() => {}); return run;
  }
  async release(snapshot, reason) {
    if (!snapshot?.ref || !snapshot.repo) return;
    await this.storage.set(releaseKey(snapshot), { reason, binding: { snapshot }, state: 'pending' });
    this.onRelease?.();
  }
  // Removes the journal without changing files or conversation. Its pre-restore snapshot is
  // released; the target belongs to a binding and is released with that binding.
  async dropJournal(j, reason) {
    await this.release(j.before, reason);
    await this.journal.set(null);
  }
  async fail(j, label, error) {
    j.phase = 'recovery-required'; j.error = String(error.message || error); await this.journal.set(j);
    return new Error(`${label}; inspect recovery: ${j.error}`);
  }
  async idle(id) {
    const state = await this.observe(id);
    if (state !== 'idle') throw new Error(`Related work is ${state}; wait for it to finish (a TUI must be open).`);
  }
  async sessionRevert(id) { return (await this.session.get({ sessionID: id })).revert; }
  async sessionGone(id) {
    try { await this.session.get({ sessionID: id }); return false; }
    catch (error) { if (isNotFound(error)) return true; throw error; }
  }
  async requireJournal(sessionID, phases) {
    const j = await this.journal.get();
    if (!j || j.sessionID !== sessionID || !phases.includes(j.phase)) throw new Error('No matching operation in the required phase; inspect recovery.');
    return j;
  }
  async requireToken(token, phases) {
    const j = await this.journal.get();
    if (!j || j.token !== token || !phases.includes(j.phase)) throw new Error('Invalid or stale rewind token; inspect recovery.');
    return j;
  }
  async sameCurrent(snapshot) {
    const now = await this.snapshot(snapshot.root, { ref: false });
    if (now.root !== snapshot.root || now.tree !== snapshot.tree) throw new Error('Files changed since preview; rewind refused.');
  }
  prepare({ sessionID, messageID }) { return this.exclusive(async () => {
    let existing = await this.journal.get();
    if (existing && await this.sessionGone(existing.sessionID)) { await this.dropJournal(existing, 'session no longer exists'); existing = null; }
    if (existing?.phase === 'staged' && !await this.sessionRevert(existing.sessionID)) {
      // Commit and external clear are indistinguishable here. Keep the record for inspection;
      // conversation undo is no longer available. The archive is dropped with its session.
      await this.storage.set(`rewind-archive-${existing.token}`, { ...existing, phase: 'conversation-undo-unavailable' });
      await this.journal.set(null); existing = null;
    }
    // Stage was requested but never observed: nothing changed, so the attempt can be superseded.
    if (existing?.phase === 'await-stage' && !stagedAt(await this.sessionRevert(existing.sessionID), existing)) { await this.dropJournal(existing, 'stage not observed'); existing = null; }
    // A prepared preview has changed nothing; replacing it keeps a cancelled confirmation non-blocking.
    if (existing && existing.phase !== 'prepared') throw new Error(`An earlier rewind (session ${existing.sessionID}, phase ${existing.phase}) is unresolved; undo it, recover files, or discard the rewind state.`);
    await this.idle(sessionID);
    if (await this.sessionRevert(sessionID)) throw new Error('A conversation revert is already staged.');
    const binding = await this.getBinding(sessionID, messageID);
    if (!binding?.snapshot) throw new Error(binding?.reason || 'No available file checkpoint.');
    const target = binding.snapshot, before = await this.snapshot(target.root);
    let changes;
    try { changes = await preview(before, target); }
    catch (error) { await this.release(before, 'preview failed'); throw error; }
    // Releasing the superseded preview first is safe: reclaim preserves it while the journal references it.
    if (existing) await this.release(existing.before, 'preview replaced');
    const token = randomUUID();
    await this.journal.set({ token, sessionID, messageID, before, target, phase: 'prepared' });
    return { token, changes, reason: 'Confirm these file changes. Ignored files and external effects are not restored.' };
  }); }
  begin({ token }) { return this.exclusive(async () => {
    const j = await this.requireToken(token, ['prepared']);
    await this.idle(j.sessionID);
    if (await this.sessionRevert(j.sessionID)) throw new Error('A conversation revert is already staged.');
    await this.sameCurrent(j.before);
    j.phase = 'await-stage'; await this.journal.set(j);
    return { sessionID: j.sessionID, messageID: j.messageID };
  }); }
  finish({ token }) { return this.exclusive(async () => {
    const j = await this.requireToken(token, ['await-stage']);
    await this.idle(j.sessionID);
    if (!stagedAt(await this.sessionRevert(j.sessionID), j)) throw new Error('Matching conversation revert not observed; inspect recovery before proceeding.');
    await this.sameCurrent(j.before);
    j.phase = 'restoring'; await this.journal.set(j);
    try { await applyChanges(this.journal, j, j.before, j.target); }
    catch (error) { throw await this.fail(j, 'Restore incomplete', error); }
    j.phase = 'staged'; await this.journal.set(j);
    return { success: true, message: 'Files restored and conversation revert staged. Undo is available until the revert is committed.' };
  }); }
  beginUndo({ sessionID }) { return this.exclusive(async () => {
    const j = await this.requireJournal(sessionID, ['staged']);
    await this.idle(sessionID);
    if (!stagedAt(await this.sessionRevert(sessionID), j)) throw new Error('Conversation undo unavailable: revert was committed, cleared, or changed.');
    await this.sameCurrent(j.target);
    j.phase = 'undoing'; await this.journal.set(j);
    try { await applyChanges(this.journal, j, j.target, j.before); }
    catch (error) { throw await this.fail(j, 'Undo incomplete', error); }
    j.phase = 'await-clear'; await this.journal.set(j);
    return { sessionID, messageID: j.messageID, success: true, message: 'Files restored. Clear the matching staged conversation revert now.' };
  }); }
  finishUndo({ sessionID }) { return this.exclusive(async () => {
    const j = await this.requireJournal(sessionID, ['await-clear']);
    if (await this.sessionRevert(sessionID)) throw new Error('Conversation revert is still staged or changed; inspect recovery.');
    await this.sameCurrent(j.before);
    await this.dropJournal(j, 'undo completed');
    return { success: true, message: 'Files and staged conversation revert have been undone.' };
  }); }
  recovery({ sessionID }) { return this.exclusive(async () => {
    const j = await this.journal.get();
    if (!j) return { message: 'No rewind state is recorded.' };
    if (j.sessionID !== sessionID) return { message: `The unresolved rewind belongs to session ${j.sessionID} (phase ${j.phase}); open that session to resolve it.` };
    let state;
    try { const revert = await this.sessionRevert(sessionID); state = revert ? `staged at ${revert.messageID}` : 'not staged (may have been committed or cleared)'; }
    catch { state = 'unknown'; }
    return { message: `Journal phase ${j.phase}; host revert ${state}; current file ${j.current || '(none)'}${j.error ? `; last error: ${j.error}` : ''}. Do not retry stage or clear on ambiguous responses.` };
  }); }
  discard({ sessionID }) { return this.exclusive(async () => {
    const j = await this.journal.get();
    if (!j || j.sessionID !== sessionID) throw new Error('No rewind state is recorded for this session.');
    await this.dropJournal(j, 'discarded by user');
    return { success: true, message: 'Rewind state discarded. Files and conversation were not changed; undo and file recovery for that rewind are no longer available.' };
  }); }
  // Both preview and execution build the complete plan from current files, refusing all
  // writes on any conflict. Execution always rebuilds it after confirmation.
  async recoveryPlan(sessionID) {
    const j = await this.requireJournal(sessionID, ['restoring', 'undoing', 'recovering', 'recovery-required']);
    await this.idle(sessionID);
    const revert = await this.sessionRevert(sessionID);
    if (revert && !stagedAt(revert, j)) throw new Error('Different conversation revert is staged; recovery refused.');
    const before = await readTree(j.before), target = await readTree(j.target), plan = [];
    for (const { name } of await preview(j.before, j.target)) {
      let now;
      try { now = await fingerprint(await restorePath(j.before.root, name, false)); }
      catch (error) { if (error.code !== 'ENOENT') throw error; now = null; }
      const old = before.get(name);
      if (!sameEntry(now, old) && !sameEntry(now, target.get(name))) throw new Error(`Recovery conflict: ${name}; no recovery files changed.`);
      if (!sameEntry(now, old)) plan.push({ name, now, old });
    }
    return { j, revert, plan };
  }
  previewRecovery({ sessionID }) { return this.exclusive(async () => {
    try {
      const { plan } = await this.recoveryPlan(sessionID);
      return { success: true, changes: plan.map(({ name, now, old }) => ({ name, action: !now ? 'create' : !old ? 'delete' : 'modify' })), message: 'Preview only; files and conversation were not changed. Recovery rechecks the plan before writing.' };
    } catch (error) {
      const detail = String(error?.message || '');
      let message = 'Recovery preview unavailable. Inspect recovery state and retry.';
      if (detail === 'No matching operation in the required phase; inspect recovery.') message = 'No recoverable rewind state is recorded for this session.';
      else if (detail.startsWith('Recovery conflict: ')) message = 'Recovery conflict: files changed unexpectedly. No files were changed.';
      else if (detail === 'Different conversation revert is staged; recovery refused.') message = 'A different conversation revert is staged; recovery refused.';
      else if (detail.startsWith('Related work is ')) message = 'Related work is active or unknown; wait for it to finish and ensure a TUI is open.';
      return { success: false, message, changes: [] };
    }
  }); }
  recoverFiles({ sessionID }) { return this.exclusive(async () => {
    const { j, revert, plan } = await this.recoveryPlan(sessionID);
    j.phase = 'recovering'; await this.journal.set(j);
    try {
      for (const item of plan) {
        j.current = item.name; await this.journal.set(j);
        await applyOne(j.before.root, item.name, item.now, item.old, j.before.repo);
      }
    } catch (error) { throw await this.fail(j, 'Recovery incomplete', error); }
    delete j.current;
    j.phase = revert ? 'await-clear' : 'recovered-files-host-unknown';
    await this.journal.set(j);
    return { success: false, message: revert ? 'Files recovered. Conversation remains staged; explicitly clear it and finish undo.' : 'Files recovered, but conversation state may have been committed or cleared; inspect it, then discard the rewind state.' };
  }); }
}
