import { ObservationBridge } from './bridge.js';
import { RewindRpc } from './rpc.js';
import { capture, defaultDataRoot, git } from './snapshot.js';
import { Workflow, releaseKey } from './workflow.js';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';

const bindingKey = (sessionID, messageID) => 'checkpoint-' + createHash('sha256').update(JSON.stringify([sessionID, messageID])).digest('hex');
const eventKey = (prefix, id) => prefix + createHash('sha256').update(id).digest('hex');
const REF = /^refs\/rewind\/[0-9a-f-]{36}$/;
const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const GRACE = /^(?:now|\d+\.(?:second|seconds|minute|minutes|hour|hours|day|days)\.ago)$/;
const INVALID = 'invalid ref name or tree id';
// Only a malformed record is permanently refused; every other failure is retried by later passes.
const settled = value => value?.state === 'reclaimed' || value?.state === 'empty' || (value?.state === 'refused' && value.reason === INVALID);
async function scan(storage, prefix) {
  const all = []; let after; const seen = new Set();
  do {
    const page = await storage.scan({ prefix, ...(after ? { after } : {}), limit: 200 });
    if (!Array.isArray(page?.entries)) throw new Error('Incomplete storage inventory');
    all.push(...page.entries); after = page.next;
    if (after && (typeof after !== 'string' || seen.has(after))) throw new Error('Storage pagination cycle');
    if (after) seen.add(after);
  } while (after);
  return all;
}
async function diskBytes(dir) {
  const stat = await lstat(dir);
  if (stat.isSymbolicLink()) throw new Error('symlink in storage');
  if (!stat.isDirectory()) return stat.size;
  let size = 0;
  for (const child of await readdir(dir)) size += await diskBytes(path.join(dir, child));
  return size;
}
const refID = snap => `${snap.repo}\0${snap.ref}`;

// Resolve a recorded repository to the plugin's own bare store <dataRoot>/<sha256>/objects.git.
// Returns null when it no longer exists; throws when it is not provably that store.
async function ownedRepo(repo, dataRoot) {
  if (typeof repo !== 'string' || !path.isAbsolute(repo) || path.basename(repo) !== 'objects.git' || !/^[0-9a-f]{64}$/.test(path.basename(path.dirname(repo)))) throw new Error('repository is not a rewind object store');
  const root = await realpath(dataRoot);
  let base;
  try { base = await realpath(path.dirname(path.dirname(repo))); } catch (error) { if (error.code === 'ENOENT') throw new Error('repository location is unknown'); throw error; }
  if (base !== root) throw new Error('repository is outside the rewind data root');
  let stat;
  try { stat = await lstat(repo); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('repository is not a plain directory');
  const real = await realpath(repo);
  if (real !== path.join(root, path.basename(path.dirname(repo)), 'objects.git')) throw new Error('repository is outside the rewind data root');
  if ((await git(['--git-dir', real, 'rev-parse', '--is-bare-repository'])).toString().trim() !== 'true') throw new Error('repository is not bare');
  return real;
}

// OpenCode instantiates the server plugin once per location (and again after a hot reload), while
// a TUI long-poll reaches only one instance. All instances in a process therefore share one bridge;
// a bridge from older plugin code is replaced.
function acquireBridge() {
  if (!(globalThis.__opencodeRewindBridge?.bridge instanceof ObservationBridge)) globalThis.__opencodeRewindBridge = { bridge: new ObservationBridge(), users: 0 };
  const shared = globalThis.__opencodeRewindBridge; shared.users++;
  return [shared.bridge, () => { if (--shared.users <= 0) { shared.bridge.close(); if (globalThis.__opencodeRewindBridge === shared) delete globalThis.__opencodeRewindBridge; } }];
}

export async function setupServer(ctx, options = {}) {
  const dataRoot = options.dataRoot || defaultDataRoot();
  const snapshot = options.snapshot || ((dir, opts) => capture(dir, { ...opts, dataRoot }));
  const pruneGrace = options.pruneGrace || '1.hour.ago';
  if (!GRACE.test(pruneGrace)) throw new Error('invalid prune grace');
  const [bridge, releaseBridge] = acquireBridge();
  let lifecycle = 'ok';
  const report = error => { lifecycle = 'degraded; affected snapshot data preserved'; console.error('Rewind lifecycle processing failed; snapshot data preserved:', error); };
  const getBinding = (sessionID, messageID) => ctx.storage.get(bindingKey(sessionID, messageID));
  const scheduleReclaim = () => { void workflow.exclusive(reclaim).catch(report).finally(() => options.onLifecycleSettled?.()); };
  const queueState = globalThis.__opencodeRewindQueue ||= { queue: Promise.resolve() };
  const workflow = new Workflow({ storage: ctx.storage, session: ctx.session, observe: id => bridge.observe(id), getBinding, snapshot, onRelease: scheduleReclaim, queueState });

  // Reclaim pass, run inside the workflow queue. Each refs/rewind/<uuid> has exactly one owner:
  // a binding or the journal. A ref is deleted only when no binding, journal or archive references
  // it; an unreadable inventory aborts the whole pass and leaves every tombstone for a later pass.
  async function reclaim() {
    const tombs = (await scan(ctx.storage, 'rewind-deleted-')).filter(t => !settled(t.value));
    if (!tombs.length) return;
    const referenced = new Set();
    for (const entry of await scan(ctx.storage, 'checkpoint-')) if (entry.value?.snapshot?.ref) referenced.add(refID(entry.value.snapshot));
    const journal = await ctx.storage.get('rewind-journal');
    for (const snap of [journal?.before, journal?.target]) if (snap?.ref) referenced.add(refID(snap));
    for (const entry of await scan(ctx.storage, 'rewind-archive-')) for (const snap of [entry.value?.before, entry.value?.target]) if (snap?.ref) referenced.add(refID(snap));
    const mark = async (tomb, value, state, reason) => { value.state = state; if (reason) value.reason = reason; await ctx.storage.set(tomb.key, value); };
    const collect = new Map();
    for (const tomb of tombs) {
      const value = { ...tomb.value }, snap = value.binding?.snapshot;
      if (!snap?.ref) { await mark(tomb, value, 'empty'); continue; }
      if (value.state !== 'ref-deleted') {
        if (referenced.has(refID(snap))) { if (value.state !== 'preserved') await mark(tomb, value, 'preserved', 'referenced by a binding, journal or archive'); continue; }
        if (!REF.test(snap.ref) || !OID.test(snap.tree || '')) { await mark(tomb, value, 'refused', INVALID); continue; }
        let repo;
        try { repo = await ownedRepo(snap.repo, dataRoot); }
        catch (error) { await mark(tomb, value, 'blocked', String(error.message || error)); continue; }
        if (!repo) { await mark(tomb, value, 'reclaimed', 'repository already absent'); continue; }
        const line = (await git(['--git-dir', repo, 'for-each-ref', '--format=%(refname) %(objectname)', snap.ref])).toString().split('\n').find(x => x.startsWith(snap.ref + ' '));
        if (line && line.slice(snap.ref.length + 1) !== snap.tree) { await mark(tomb, value, 'preserved', 'ref points at an unexpected object'); continue; }
        if (line) await git(['--git-dir', repo, 'update-ref', '-d', snap.ref, snap.tree]);
        value.repo = repo; await mark(tomb, value, 'ref-deleted');
      }
      if (!collect.has(value.repo)) collect.set(value.repo, []);
      collect.get(value.repo).push([tomb, value]);
    }
    for (const [repo, items] of collect) {
      try {
        if (!await ownedRepo(repo, dataRoot)) throw new Error('repository vanished');
        await git(['--git-dir', repo, 'reflog', 'expire', '--expire=now', '--all']);
        // Grace period: objects written by an in-flight capture in another process
        // (hash-object -w / write-tree before update-ref) are younger than the grace and survive.
        await git(['--git-dir', repo, '-c', 'gc.auto=0', 'gc', '--quiet', `--prune=${pruneGrace}`]);
      } catch (error) { report(error); continue; }
      for (const [tomb, value] of items) await mark(tomb, value, 'reclaimed');
    }
  }

  await ctx.rpc.register(RewindRpc, {
    next: (_, context) => bridge.next(context.signal),
    reply: async value => bridge.reply(value),
    checkpoint: async ({ sessionID, messageID }) => {
      const binding = await getBinding(sessionID, messageID);
      return binding?.snapshot ? { status: 'available', reason: 'File checkpoint captured; activity will be checked again before rewind.' } : { status: 'unavailable', reason: binding?.reason || 'No checkpoint is recorded for this prompt.' };
    },
    deleteSnapshot: ({ sessionID, messageID }) => workflow.exclusive(async () => {
      try {
        if (!sessionID || !messageID) return { success: false, message: 'Session and message IDs are required.' };
        const key = bindingKey(sessionID, messageID), binding = await ctx.storage.get(key);
        if (!binding?.snapshot) return { success: false, message: 'No snapshot is recorded for this prompt.' };
        // Write the tombstone first: a crash or failed removal leaves a referenced ref safe,
        // while a crash after removal leaves the tombstone for the startup reclaim pass.
        await ctx.storage.set('rewind-deleted-' + randomUUID(), { reason: 'snapshot deleted by user', binding, state: 'pending' });
        await ctx.storage.remove(key);
        scheduleReclaim();
        return { success: true, message: 'Snapshot released. Files and conversation were not changed; shared or recovery data is preserved.' };
      } catch (error) {
        return { success: false, message: `Could not release snapshot: ${String(error.message || error)}` };
      }
    }),
    clearSnapshots: ({ sessionID }) => workflow.exclusive(async () => {
      if (!sessionID) return { success: false, message: 'Session ID is required.' };
      let released = 0, tombstoned = false;
      try {
        const entries = await scan(ctx.storage, 'checkpoint-');
        for (const entry of entries) {
          if (entry.value?.sessionID !== sessionID || !entry.value?.snapshot) continue;
          // A durable tombstone precedes each removal.
          await ctx.storage.set('rewind-deleted-' + randomUUID(), { reason: 'session snapshots cleared by user', binding: entry.value, state: 'pending' });
          tombstoned = true;
          await ctx.storage.remove(entry.key);
          released++;
        }
        return { success: true, message: `Released ${released} prompt binding(s). Files and conversation were not changed; shared or recovery data is preserved. Reclamation runs in the background.` };
      } catch (error) {
        return { success: false, message: `Could not clear all snapshots: ${released} binding(s) confirmed released; others may remain (the last removal may have succeeded). Retry to release remaining bindings. ${String(error.message || error)}` };
      } finally {
        if (tombstoned) scheduleReclaim();
      }
    }),
    prepare: input => workflow.prepare(input), begin: input => workflow.begin(input), finish: input => workflow.finish(input),
    beginUndo: input => workflow.beginUndo(input), finishUndo: input => workflow.finishUndo(input),
    recovery: input => workflow.recovery(input), previewRecovery: input => workflow.previewRecovery(input), recoverFiles: input => workflow.recoverFiles(input), discard: input => workflow.discard(input),
    inspect: async () => {
      const entries = await scan(ctx.storage, 'checkpoint-');
      const tombs = await scan(ctx.storage, 'rewind-deleted-');
      const archives = await scan(ctx.storage, 'rewind-archive-');
      const pending = await scan(ctx.storage, 'rewind-pending-');
      const j = await ctx.storage.get('rewind-journal');
      const count = test => tombs.filter(t => test(t.value?.state || 'pending', t.value)).length;
      const repos = new Set(entries.map(e => e.value?.snapshot?.repo).filter(Boolean));
      for (const entry of archives) for (const snap of [entry.value?.before, entry.value?.target]) if (snap?.repo) repos.add(snap.repo);
      for (const snap of [j?.before, j?.target]) if (snap?.repo) repos.add(snap.repo);
      let bytes = 0; let unknown = false;
      for (const repo of repos) try { bytes += await diskBytes(repo); } catch { unknown = true; }
      const released = `${count(s => s === 'reclaimed')} reclaimed, ${count(s => s === 'preserved')} preserved (still referenced), ${count(s => s === 'pending' || s === 'ref-deleted')} pending, ${count((s, v) => s === 'blocked' || (s === 'refused' && v.reason !== INVALID))} blocked (retried), ${count((s, v) => s === 'refused' && v.reason === INVALID)} refused`;
      return { message: `${entries.length} prompt bindings, ${entries.filter(e => e.value?.snapshot).length} captured snapshots; released snapshots: ${released}; ${archives.length} archived journals, ${pending.length} pending deletion events; lifecycle: ${lifecycle}; known repositories: ${repos.size}, estimated bytes: ${bytes}${unknown ? ' (incomplete)' : ''}; journal: ${j ? `${j.phase} (session ${j.sessionID})` : 'none'}. Unreferenced objects are pruned after a ${pruneGrace.replace(/\.ago$/, '').replace(/\./g, ' ')} grace period. Deletions missed while the plugin was not running are not detected. No age expiry.` };
    }
  });
  await ctx.session.hook('prompt', event => workflow.exclusive(async () => {
    const binding = { sessionID: event.sessionID, messageID: event.messageID, observed: 'unknown', status: 'unavailable', reason: 'Activity observation unavailable.' };
    try {
      const observed = await bridge.observe(event.sessionID); binding.observed = observed;
      if (observed === 'idle') {
        binding.snapshot = await snapshot(ctx.location.directory);
        binding.status = 'available'; binding.reason = 'Checkpoint captured.';
      } else binding.reason = observed === 'active' ? 'Related work is active; wait for it to finish.' : 'Activity is unknown; open a TUI and retry.';
    } catch (error) { binding.reason = `Checkpoint capture failed: ${String(error.message || error)}`; }
    const key = bindingKey(event.sessionID, event.messageID), previous = await ctx.storage.get(key);
    await ctx.storage.set(key, binding);
    if (previous?.snapshot?.ref && previous.snapshot.ref !== binding.snapshot?.ref) {
      await ctx.storage.set(releaseKey(previous.snapshot), { reason: 'binding replaced', binding: previous, state: 'pending' });
      scheduleReclaim();
    }
  }));

  // Deletion of one session, replay-safe at every step: the event is journaled; each binding and
  // archive of the session is tombstoned before removal; a journal of the session is dropped with
  // its pre-restore snapshot released; then refs are reclaimed. Child sessions emit their own events.
  const replay = async (pendingKey, item) => {
    if (item?.type !== 'session.deleted' || typeof item.sessionID !== 'string') { await ctx.storage.remove(pendingKey); throw new Error('Dropped an invalid pending lifecycle record'); }
    for (const entry of await scan(ctx.storage, 'checkpoint-')) {
      if (entry.value?.sessionID !== item.sessionID) continue;
      await ctx.storage.set(eventKey('rewind-deleted-', entry.key), { binding: entry.value, state: 'pending' });
      await ctx.storage.remove(entry.key);
    }
    for (const entry of await scan(ctx.storage, 'rewind-archive-')) {
      if (entry.value?.sessionID !== item.sessionID) continue;
      for (const [part, snap] of [['before', entry.value.before], ['target', entry.value.target]]) {
        if (snap?.ref) await ctx.storage.set(eventKey('rewind-deleted-', `${entry.key}:${part}`), { binding: { sessionID: item.sessionID, snapshot: snap }, state: 'pending' });
      }
      await ctx.storage.remove(entry.key);
    }
    const journal = await ctx.storage.get('rewind-journal');
    if (journal?.sessionID === item.sessionID) await workflow.dropJournal(journal, 'session deleted');
    await ctx.storage.remove(pendingKey);
    await reclaim();
  };
  const abort = new AbortController();
  void (async () => {
    try {
      await workflow.exclusive(async () => {
        for (const entry of await scan(ctx.storage, 'rewind-pending-')) { try { await replay(entry.key, entry.value); } catch (error) { report(error); } }
        await reclaim();
      });
    } catch (error) { report(error); }
    options.onLifecycleSettled?.();
    if (!ctx.event?.subscribe) return;
    try {
      for await (const event of ctx.event.subscribe({ types: ['session.deleted'], signal: abort.signal })) {
        if (event.type !== 'session.deleted' || typeof event.data?.sessionID !== 'string') continue;
        const item = { type: event.type, sessionID: event.data.sessionID };
        const pendingKey = eventKey('rewind-pending-', `${item.type}:${item.sessionID}`);
        try { await workflow.exclusive(async () => { await ctx.storage.set(pendingKey, item); await replay(pendingKey, item); }); }
        catch (error) { report(error); }
        options.onLifecycleSettled?.();
      }
    } catch (error) {
      if (!abort.signal.aborted) report(error);
    }
  })();
  return () => { abort.abort(); releaseBridge(); };
}
