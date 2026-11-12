import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setupServer } from '../src/server-core.js';
import { Workflow, releaseKey } from '../src/workflow.js';
import { blob, gitOut, hasObject, memoryStorage, project, refs } from './helpers.js';

const bindingKey = (s, m) => 'checkpoint-' + createHash('sha256').update(JSON.stringify([s, m])).digest('hex');
function eventSource() {
  const queue = []; let wake;
  return {
    push(event) { queue.push(event); wake?.(); },
    subscribe: () => (async function* () { for (;;) { while (queue.length) yield queue.shift(); await new Promise(resolve => { wake = resolve; }); } })()
  };
}
function settler() {
  let count = 0; const waiters = [];
  return {
    hook: () => { count++; for (const w of waiters.splice(0)) w(); },
    async until(predicate) { for (;;) { const seen = count; if (await predicate()) return; if (count === seen) await new Promise(r => waiters.push(r)); } }
  };
}
async function fixture(t) {
  const p = await project(t, 'rewind-gc-');
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: p.root });
  return { ...p, snap: async content => { await p.write('file', content); return p.snapshot(p.root); } };
}
// One server plugin instance. `location` defaults to the project; storage may be shared.
async function start(t, f, map, extra = {}) {
  const events = eventSource(), settled = settler(); let handlers, hook;
  const ctx = { location: { directory: extra.location || f.root }, storage: memoryStorage(map, extra.faults), session: { get: extra.sessionGet || (async () => ({})), hook: async (_, fn) => { hook = fn; } }, rpc: { register: async (_, impl) => { handlers = impl; } }, event: { subscribe: events.subscribe } };
  const close = await setupServer(ctx, { dataRoot: f.data, pruneGrace: 'now', onLifecycleSettled: settled.hook }); t.after(close);
  return { events, settled, handlers: () => handlers, hook: () => hook, close };
}
const tombStates = map => [...map].filter(([k]) => k.startsWith('rewind-deleted-')).map(([, v]) => v.state).sort();

test('clearSnapshots releases session bindings only and preserves shared and recovery refs', async t => {
  const f = await fixture(t), exclusive = await f.snap('exclusive'), shared = await f.snap('shared'), recovery = await f.snap('recovery');
  const journal = { sessionID: 's', target: recovery }, archive = { sessionID: 's', before: recovery };
  const map = new Map([
    [bindingKey('s', '1'), { sessionID: 's', snapshot: exclusive }],
    [bindingKey('s', '2'), { sessionID: 's', snapshot: shared }],
    [bindingKey('s', '3'), { sessionID: 's', snapshot: recovery }],
    [bindingKey('s', '4'), { sessionID: 's', messageID: '4', status: 'unavailable', reason: 'Activity observation unavailable.' }],
    [bindingKey('other', '1'), { sessionID: 'other', snapshot: shared }],
    ['rewind-journal', journal], ['rewind-archive-a', archive]
  ]);
  let calls = 0;
  const s = await start(t, f, map, { sessionGet: async () => { calls++; return {}; } });
  assert.equal((await s.handlers().clearSnapshots({ sessionID: '' })).success, false);
  const result = await s.handlers().clearSnapshots({ sessionID: 's' });
  assert.equal(result.success, true); assert.match(result.message, /3 prompt binding/);
  await s.settled.until(() => tombStates(map).join() === 'preserved,preserved,reclaimed');
  assert.ok(map.has(bindingKey('other', '1')));
  for (const id of ['1', '2', '3']) assert.equal(map.has(bindingKey('s', id)), false);
  assert.deepEqual(map.get(bindingKey('s', '4')), { sessionID: 's', messageID: '4', status: 'unavailable', reason: 'Activity observation unavailable.' });
  assert.deepEqual(await s.handlers().checkpoint({ sessionID: 's', messageID: '4' }), { status: 'unavailable', reason: 'Activity observation unavailable.' });
  assert.deepEqual(map.get('rewind-journal'), journal); assert.deepEqual(map.get('rewind-archive-a'), archive);
  assert.deepEqual(refs(exclusive.repo), [shared.ref, recovery.ref].sort());
  assert.equal(await readFile(path.join(f.root, 'file'), 'utf8'), 'recovery'); assert.equal(calls, 0);
  assert.match((await s.handlers().clearSnapshots({ sessionID: 's' })).message, /Released 0/);
  assert.equal(map.has(bindingKey('s', '4')), true);
});

test('clearSnapshots reports partial failure and retry safely completes', async t => {
  const f = await fixture(t), a = await f.snap('a'), b = await f.snap('b');
  const first = bindingKey('s', '1'), second = bindingKey('s', '2');
  const map = new Map([[first, { sessionID: 's', snapshot: a }], [second, { sessionID: 's', snapshot: b }]]);
  let fail = true;
  const s = await start(t, f, map, { faults: { remove: key => key === second && fail } });
  const result = await s.handlers().clearSnapshots({ sessionID: 's' });
  assert.equal(result.success, false); assert.match(result.message, /1 binding\(s\) confirmed released/);
  assert.equal(map.has(first), false); assert.equal(map.has(second), true);
  await s.settled.until(() => tombStates(map).join() === 'preserved,reclaimed');
  assert.deepEqual(refs(a.repo), [b.ref]);
  fail = false;
  assert.equal((await s.handlers().clearSnapshots({ sessionID: 's' })).success, true);
  await s.settled.until(() => tombStates(map).join() === 'reclaimed,reclaimed,reclaimed');
  assert.deepEqual(refs(a.repo), []);
});

test('clearSnapshots is serialized with prompt capture across server instances', async t => {
  const f = await fixture(t), map = new Map(), a = await start(t, f, map), b = await start(t, f, map);
  await f.write('file', 'concurrent clear');
  const waiter = a.handlers().next({}, { signal: new AbortController().signal });
  const prompt = a.hook()({ sessionID: 's', messageID: 'm' });
  const request = await waiter;
  const clear = b.handlers().clearSnapshots({ sessionID: 's' });
  await a.handlers().reply({ nonce: request.nonce, state: 'idle' });
  await prompt; assert.equal((await clear).success, true);
  await b.settled.until(() => tombStates(map).join() === 'reclaimed');
  assert.equal(map.has(bindingKey('s', 'm')), false);
});

test('deleteSnapshot releases only the selected prompt without changing files or conversation', async t => {
  const f = await fixture(t), target = await f.snap('target'), other = await f.snap('other');
  const key = bindingKey('s', 'm'), otherKey = bindingKey('s', 'other');
  const map = new Map([[key, { sessionID: 's', messageID: 'm', snapshot: target }], [otherKey, { sessionID: 's', messageID: 'other', snapshot: other }]]);
  let sessionCalls = 0;
  const s = await start(t, f, map, { sessionGet: async () => { sessionCalls++; return {}; } });
  const result = await s.handlers().deleteSnapshot({ sessionID: 's', messageID: 'm' });
  assert.equal(result.success, true);
  assert.equal((await s.handlers().checkpoint({ sessionID: 's', messageID: 'm' })).status, 'unavailable');
  assert.equal((await s.handlers().checkpoint({ sessionID: 's', messageID: 'other' })).status, 'available');
  assert.equal((await s.handlers().deleteSnapshot({ sessionID: 's', messageID: 'm' })).success, false);
  await s.settled.until(() => tombStates(map).join() === 'reclaimed');
  assert.deepEqual(refs(target.repo), [other.ref]);
  assert.equal(await readFile(path.join(f.root, 'file'), 'utf8'), 'other');
  assert.equal(sessionCalls, 0);
});

test('deleteSnapshot preserves journal, archive and shared binding references', async t => {
  const f = await fixture(t), target = await f.snap('shared');
  const binding = { sessionID: 's', messageID: 'm', snapshot: target };
  const journal = { sessionID: 's', messageID: 'm', phase: 'recovery-required', target };
  const archive = { sessionID: 's', target };
  const map = new Map([[bindingKey('s', 'm'), binding], [bindingKey('s', 'other'), { ...binding, messageID: 'other' }], ['rewind-journal', journal], ['rewind-archive-a', archive]]);
  const s = await start(t, f, map);
  assert.equal((await s.handlers().deleteSnapshot({ sessionID: 's', messageID: 'm' })).success, true);
  await s.settled.until(() => tombStates(map).join() === 'preserved');
  assert.deepEqual(map.get('rewind-journal'), journal); assert.deepEqual(map.get('rewind-archive-a'), archive);
  assert.deepEqual(refs(target.repo), [target.ref]); assert.ok(hasObject(target.repo, target.tree));
});

test('deleteSnapshot storage failure keeps the binding and restart preserves its ref', async t => {
  const f = await fixture(t), target = await f.snap('failure'), key = bindingKey('s', 'm');
  const map = new Map([[key, { sessionID: 's', messageID: 'm', snapshot: target }]]);
  const s = await start(t, f, map, { faults: { remove: k => k === key } });
  assert.equal((await s.handlers().deleteSnapshot({ sessionID: 's', messageID: 'm' })).success, false);
  assert.ok(map.has(key)); assert.deepEqual(refs(target.repo), [target.ref]);
  const restarted = await start(t, f, map);
  await restarted.settled.until(() => tombStates(map).join() === 'preserved');
  assert.deepEqual(refs(target.repo), [target.ref]);
});

test('deleteSnapshot is serialized with prompt capture across server instances', async t => {
  const f = await fixture(t), map = new Map(), a = await start(t, f, map), b = await start(t, f, map);
  await f.write('file', 'concurrent');
  const waiter = a.handlers().next({}, { signal: new AbortController().signal });
  const prompt = a.hook()({ sessionID: 's', messageID: 'm' });
  const request = await waiter;
  const deletion = b.handlers().deleteSnapshot({ sessionID: 's', messageID: 'm' });
  await a.handlers().reply({ nonce: request.nonce, state: 'idle' });
  await prompt; assert.equal((await deletion).success, true);
  await b.settled.until(() => tombStates(map).join() === 'reclaimed');
  assert.equal(map.has(bindingKey('s', 'm')), false);
});

test('session deletion reclaims its exclusive refs and objects; another session keeps its objects', async t => {
  const f = await fixture(t);
  const projectHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: f.root, encoding: 'utf8' });
  const projectIndex = await readFile(path.join(f.root, '.git', 'index'));
  const parent = await f.snap('parent only content'), other = await f.snap('other session content');
  const map = new Map([['checkpoint-p', { sessionID: 'parent', messageID: 'm1', snapshot: parent }], ['checkpoint-o', { sessionID: 'other', messageID: 'm2', snapshot: other }]]);
  const before = gitOut(parent.repo, 'count-objects', '-v');
  assert.deepEqual(refs(parent.repo), [other.ref, parent.ref].sort());
  assert.ok(hasObject(parent.repo, blob('parent only content')));
  const s = await start(t, f, map);
  s.events.push({ type: 'session.deleted', data: { sessionID: 'parent' } });
  await s.settled.until(() => tombStates(map).join() === 'reclaimed');
  const after = gitOut(parent.repo, 'count-objects', '-v');
  console.log('count-objects before:', before.replace(/\n/g, ' '), '| after:', after.replace(/\n/g, ' '));
  assert.deepEqual(refs(parent.repo), [other.ref]);
  assert.equal(hasObject(parent.repo, blob('parent only content')), false, 'unreachable blob must be pruned');
  assert.equal(hasObject(parent.repo, parent.tree), false);
  assert.ok(hasObject(parent.repo, blob('other session content'))); assert.ok(hasObject(parent.repo, other.tree));
  assert.equal(map.has('checkpoint-p'), false); assert.equal(map.has('checkpoint-o'), true);
  assert.match((await s.handlers().inspect({})).message, /1 reclaimed, 0 preserved/);
  // Replay of the same deletion is a no-op.
  s.events.push({ type: 'session.deleted', data: { sessionID: 'parent' } });
  await s.settled.until(() => ![...map.keys()].some(k => k.startsWith('rewind-pending-')));
  assert.deepEqual(refs(parent.repo), [other.ref]);
  assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: f.root, encoding: 'utf8' }), projectHead);
  assert.deepEqual(await readFile(path.join(f.root, '.git', 'index')), projectIndex);
});

test('prompt hook captures after observed idle, exposes the checkpoint, and deletion reclaims it', async t => {
  const f = await fixture(t);
  await f.write('file', 'hooked content');
  const map = new Map(), s = await start(t, f, map), handlers = s.handlers();
  const waiter = handlers.next({}, { signal: new AbortController().signal });
  const prompt = s.hook()({ sessionID: 's', messageID: 'm' });
  const req = await waiter; assert.equal((await handlers.reply({ nonce: req.nonce, state: 'idle' })).accepted, true); await prompt;
  assert.equal((await handlers.checkpoint({ sessionID: 's', messageID: 'm' })).status, 'available');
  const snap = map.get(bindingKey('s', 'm')).snapshot;
  assert.deepEqual(refs(snap.repo), [snap.ref]);
  s.events.push({ type: 'session.deleted', data: { sessionID: 's' } });
  await s.settled.until(() => tombStates(map).join() === 'reclaimed');
  assert.equal((await handlers.checkpoint({ sessionID: 's', messageID: 'm' })).status, 'unavailable');
  assert.deepEqual(refs(snap.repo), []);
  assert.equal(hasObject(snap.repo, blob('hooked content')), false);
});

test('forks own no inherited bindings; parent and child deletion leave the fork intact', async t => {
  const f = await fixture(t);
  const parent = await f.snap('parent'), child = await f.snap('child'), fork = await f.snap('fork own prompt');
  const map = new Map([
    ['checkpoint-p', { sessionID: 'parent', messageID: 'm1', snapshot: parent }],
    ['checkpoint-c', { sessionID: 'child', messageID: 'c1', snapshot: child }],
    [bindingKey('fork', 'f1'), { sessionID: 'fork', messageID: 'f1', snapshot: fork }]
  ]);
  const s = await start(t, f, map);
  s.events.push({ type: 'session.forked', data: { sessionID: 'fork', parentID: 'parent' } });
  assert.equal((await s.handlers().checkpoint({ sessionID: 'fork', messageID: 'm1' })).status, 'unavailable', 'fork does not inherit the parent checkpoint');
  // The host deletes children too and emits their own events.
  s.events.push({ type: 'session.deleted', data: { sessionID: 'parent' } });
  s.events.push({ type: 'session.deleted', data: { sessionID: 'child' } });
  await s.settled.until(() => tombStates(map).join() === 'reclaimed,reclaimed');
  assert.deepEqual(refs(parent.repo), [fork.ref]);
  assert.ok(hasObject(parent.repo, blob('fork own prompt')));
  assert.equal((await s.handlers().checkpoint({ sessionID: 'fork', messageID: 'f1' })).status, 'available');
});

test('refs used by an active journal or archive are preserved, then reclaimed once released', async t => {
  const f = await fixture(t);
  const a = await f.snap('journal target'), b = await f.snap('archived before');
  const map = new Map([
    ['checkpoint-a', { sessionID: 'parent', messageID: 'm1', snapshot: a }],
    ['checkpoint-b', { sessionID: 'parent', messageID: 'm2', snapshot: b }],
    ['rewind-journal', { sessionID: 'other', phase: 'recovery-required', target: a }],
    ['rewind-archive-x', { sessionID: 'other', phase: 'conversation-undo-unavailable', before: b }]
  ]);
  const s = await start(t, f, map);
  s.events.push({ type: 'session.deleted', data: { sessionID: 'parent' } });
  await s.settled.until(() => tombStates(map).join() === 'preserved,preserved');
  assert.deepEqual(refs(a.repo), [a.ref, b.ref].sort());
  assert.match((await s.handlers().inspect({})).message, /0 reclaimed, 2 preserved/);
  map.delete('rewind-journal'); map.delete('rewind-archive-x');
  s.events.push({ type: 'session.deleted', data: { sessionID: 'unrelated' } });
  await s.settled.until(() => tombStates(map).join() === 'reclaimed,reclaimed');
  assert.deepEqual(refs(a.repo), []);
});

test('deleting a session drops its own archive and reclaims the journal-owned before snapshot', async t => {
  const f = await fixture(t);
  const before = await f.snap('pre-restore'), target = await f.snap('checkpoint');
  const map = new Map([
    ['checkpoint-t', { sessionID: 's', messageID: 'm', snapshot: target }],
    ['rewind-archive-s', { sessionID: 's', phase: 'conversation-undo-unavailable', before, target }]
  ]);
  const s = await start(t, f, map);
  s.events.push({ type: 'session.deleted', data: { sessionID: 's' } });
  await s.settled.until(() => !map.has('rewind-archive-s') && tombStates(map).every(x => x === 'reclaimed'));
  assert.deepEqual(refs(before.repo), []);
});

test('crash after binding tombstone and after ref deletion replays to completion on restart', async t => {
  const f = await fixture(t);
  const a = await f.snap('crash case a'), b = await f.snap('crash case b');
  const map = new Map([['checkpoint-a', { sessionID: 'parent', messageID: 'm1', snapshot: a }], ['checkpoint-b', { sessionID: 'parent', messageID: 'm2', snapshot: b }]]);
  let removeFault = true, setFault = true;
  const first = await start(t, f, map, { faults: {
    remove: k => k === 'checkpoint-b' && removeFault && !(removeFault = false),
  } });
  first.events.push({ type: 'session.deleted', data: { sessionID: 'parent' } });
  await first.settled.until(() => !removeFault);
  assert.ok([...map.keys()].some(k => k.startsWith('rewind-pending-')), 'event stays journaled after a crash');
  assert.ok(map.has('checkpoint-b'));
  // Second "process": crash after the ref is deleted but before the state is recorded.
  const second = await start(t, f, map, { faults: { set: (k, v) => v?.state === 'ref-deleted' && setFault && !(setFault = false) } });
  await second.settled.until(() => !setFault);
  // Third "process" completes from the durable records.
  const third = await start(t, f, map);
  await third.settled.until(() => tombStates(map).join() === 'reclaimed,reclaimed');
  assert.deepEqual(refs(a.repo), []);
  assert.equal(map.has('checkpoint-a') || map.has('checkpoint-b'), false);
  assert.equal([...map.keys()].some(k => k.startsWith('rewind-pending-')), false);
  assert.equal(hasObject(a.repo, blob('crash case a')), false);
});

test('invalid ref names are refused and foreign repositories blocked; neither is deleted', async t => {
  const f = await fixture(t);
  const good = await f.snap('valid');
  gitOut(good.repo, 'update-ref', 'refs/rewind/bad', good.tree);
  const projectGit = path.join(f.root, '.git'), head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: f.root, encoding: 'utf8' }).trim();
  const map = new Map([
    ['checkpoint-1', { sessionID: 'x', messageID: '1', snapshot: { ...good, ref: 'refs/rewind/bad' } }],
    ['checkpoint-2', { sessionID: 'x', messageID: '2', snapshot: { ...good, ref: 'refs/heads/main' } }],
    ['checkpoint-3', { sessionID: 'x', messageID: '3', snapshot: { root: f.root, repo: projectGit, ref: good.ref, tree: head } }],
    ['checkpoint-4', { sessionID: 'x', messageID: '4', snapshot: { ...good, repo: path.join(f.base, 'elsewhere', 'a'.repeat(64), 'objects.git') } }]
  ]);
  const s = await start(t, f, map);
  s.events.push({ type: 'session.deleted', data: { sessionID: 'x' } });
  await s.settled.until(() => tombStates(map).join() === 'blocked,blocked,refused,refused');
  assert.deepEqual(refs(good.repo), [good.ref, 'refs/rewind/bad'].sort());
  assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: f.root, encoding: 'utf8' }).trim(), head);
});

test('unreadable reference inventory preserves every ref and reports degraded lifecycle', async t => {
  const f = await fixture(t);
  const a = await f.snap('unknown');
  const map = new Map([['checkpoint-a', { sessionID: 'parent', messageID: 'm1', snapshot: a }]]);
  let failing = true;
  const s = await start(t, f, map, { faults: { scan: prefix => prefix === 'rewind-archive-' && failing } });
  s.events.push({ type: 'session.deleted', data: { sessionID: 'parent' } });
  await s.settled.until(() => map.size > 0 && !map.has('checkpoint-a') && [...map.keys()].some(k => k.startsWith('rewind-pending-')));
  assert.deepEqual(refs(a.repo), [a.ref]);
  failing = false;
  assert.match((await s.handlers().inspect({})).message, /lifecycle: degraded/);
  assert.equal(tombStates(map).join(), 'pending');
});

test('completed undo releases the journal-owned pre-restore snapshot and comparison captures leave no refs', async t => {
  const f = await fixture(t);
  const target = await f.snap('checkpoint'); await writeFile(path.join(f.root, 'file'), 'later');
  const map = new Map(); let revert, reclaimRequested = 0;
  const storage = memoryStorage(map);
  const workflow = new Workflow({ storage, session: { get: async () => ({ revert }) }, observe: async () => 'idle', getBinding: async () => ({ snapshot: target }), snapshot: f.snapshot, onRelease: () => { reclaimRequested++; } });
  const p = await workflow.prepare({ sessionID: 's', messageID: 'm' });
  const before = map.get('rewind-journal').before;
  await workflow.begin({ token: p.token }); revert = { messageID: 'm' };
  await workflow.finish({ token: p.token });
  await workflow.beginUndo({ sessionID: 's' }); revert = undefined;
  await workflow.finishUndo({ sessionID: 's' });
  assert.deepEqual(refs(target.repo), [before.ref, target.ref].sort(), 'only bound and journal-owned captures have refs');
  assert.equal(reclaimRequested, 1);
  assert.equal([...map.values()].filter(v => v?.binding?.snapshot?.ref === before.ref && v.state === 'pending').length, 1);
});

test('an instance whose location contains the data root still reclaims (location is not a containment boundary)', async t => {
  const f = await fixture(t);
  const a = await f.snap('ancestor instance');
  const map = new Map([['checkpoint-a', { sessionID: 'parent', messageID: 'm1', snapshot: a }]]);
  const s = await start(t, f, map, { location: f.base });
  s.events.push({ type: 'session.deleted', data: { sessionID: 'parent' } });
  await s.settled.until(() => tombStates(map).join() === 'reclaimed');
  assert.deepEqual(refs(a.repo), []);
});

test('records refused for a transient containment reason are retried at startup; malformed ones stay refused', async t => {
  const f = await fixture(t);
  const a = await f.snap('legacy refused');
  const map = new Map([
    ['rewind-deleted-legacy', { binding: { sessionID: 'gone', snapshot: a }, state: 'refused', reason: 'repository is inside the project worktree' }],
    ['rewind-deleted-bad', { binding: { sessionID: 'gone', snapshot: { ...a, ref: 'refs/heads/main' } }, state: 'refused', reason: 'invalid ref name or tree id' }]
  ]);
  const s = await start(t, f, map);
  await s.settled.until(() => map.get('rewind-deleted-legacy').state === 'reclaimed');
  assert.equal(map.get('rewind-deleted-bad').state, 'refused');
  assert.deepEqual(refs(a.repo), []);
  assert.match((await s.handlers().inspect({})).message, /1 reclaimed, 0 preserved \(still referenced\), 0 pending, 0 blocked \(retried\), 1 refused/);
});

test('a containment failure is recorded as blocked and retried, never deleted', async t => {
  const f = await fixture(t);
  const a = await f.snap('outside store');
  const foreign = { ...a, repo: path.join(f.base, 'elsewhere', 'a'.repeat(64), 'objects.git') };
  const map = new Map([['checkpoint-a', { sessionID: 'x', messageID: '1', snapshot: foreign }]]);
  const s = await start(t, f, map);
  s.events.push({ type: 'session.deleted', data: { sessionID: 'x' } });
  await s.settled.until(() => tombStates(map).join() === 'blocked');
  s.events.push({ type: 'session.deleted', data: { sessionID: 'unrelated' } });
  await s.settled.until(() => !map.has('rewind-pending-' + createHash('sha256').update('session.deleted:unrelated').digest('hex')));
  assert.equal(tombStates(map).join(), 'blocked');
  assert.deepEqual(refs(a.repo), [a.ref]);
});

test('deleting the session of an active journal drops it and reclaims both its pre-restore and target refs', async t => {
  const f = await fixture(t);
  const target = await f.snap('target'), before = await f.snap('before');
  const map = new Map([
    [bindingKey('s', 'm'), { sessionID: 's', messageID: 'm', snapshot: target }],
    ['rewind-journal', { token: 't', sessionID: 's', messageID: 'm', before, target, phase: 'staged' }]
  ]);
  const s = await start(t, f, map);
  s.events.push({ type: 'session.deleted', data: { sessionID: 's' } });
  await s.settled.until(() => !map.has('rewind-journal') && tombStates(map).join() === 'reclaimed,reclaimed');
  assert.equal(map.get(releaseKey(before)).reason, 'session deleted');
  assert.deepEqual(refs(target.repo), []);
  assert.match((await s.handlers().inspect({})).message, /journal: none/);
});

test('two plugin instances share one bridge; the instance at an ancestor of the data root handles deletion', async t => {
  const f = await fixture(t);
  await f.write('file', 'two instances');
  const map = new Map();
  const project = await start(t, f, map), home = await start(t, f, map, { location: f.base });
  assert.equal(globalThis.__opencodeRewindBridge.users >= 2, true);
  // The TUI long-poll reaches the ancestor instance; the prompt is admitted by the project instance.
  const waiter = home.handlers().next({}, { signal: new AbortController().signal });
  const prompt = project.hook()({ sessionID: 's', messageID: 'm' });
  const req = await waiter; assert.equal((await home.handlers().reply({ nonce: req.nonce, state: 'idle' })).accepted, true); await prompt;
  assert.equal((await home.handlers().checkpoint({ sessionID: 's', messageID: 'm' })).status, 'available');
  const snap = map.get(bindingKey('s', 'm')).snapshot;
  home.events.push({ type: 'session.deleted', data: { sessionID: 's' } });
  await home.settled.until(() => tombStates(map).join() === 'reclaimed');
  assert.deepEqual(refs(snap.repo), []);
  assert.equal(hasObject(snap.repo, blob('two instances')), false);
});
