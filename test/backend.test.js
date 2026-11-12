import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ObservationBridge } from '../src/bridge.js';
import { observeFamily } from '../src/observe.js';
import { capture } from '../src/snapshot.js';
import { applyOne, preview } from '../src/transaction.js';
import { Workflow, releaseKey } from '../src/workflow.js';
import { memoryStorage, project } from './helpers.js';

// A Workflow over in-memory storage with a host revert the test controls.
function workflowFor(p, { target, binding, observe = async () => 'idle', snapshot = p.snapshot, session } = {}) {
  const storage = memoryStorage();
  const host = { revert: undefined };
  const sessionApi = session || { get: async () => ({ revert: host.revert }) };
  const make = () => new Workflow({ storage, session: sessionApi, observe, getBinding: async () => binding || { snapshot: target }, snapshot });
  return { storage, host, make, journal: () => storage.map.get('rewind-journal') };
}
// prepare -> begin -> host stage -> finish, as the TUI performs it.
async function rewind(w, workflow, sessionID = 's', messageID = 'm') {
  const p = await workflow.prepare({ sessionID, messageID });
  await workflow.begin({ token: p.token }); w.host.revert = { messageID };
  return { prepared: p, result: await workflow.finish({ token: p.token }) };
}
// beginUndo -> host clear -> finishUndo.
async function undo(w, workflow, sessionID = 's') {
  await workflow.beginUndo({ sessionID }); w.host.revert = undefined;
  return workflow.finishUndo({ sessionID });
}

test('bridge fails closed and rejects late responses', async () => {
  const bridge = new ObservationBridge(15);
  assert.equal(await bridge.observe('s'), 'unknown');
  const wait = bridge.next(); const result = bridge.observe('s'); const req = await wait;
  assert.equal(await result, 'unknown');
  assert.equal(bridge.reply({ nonce: req.nonce, state: 'idle' }).accepted, false);
  const wait2 = bridge.next(); const result2 = bridge.observe('s'); const req2 = await wait2;
  assert.equal(bridge.reply({ nonce: req2.nonce, state: 'idle' }).accepted, true);
  assert.equal(await result2, 'idle'); bridge.close();
});
test('bridge accepts several TUIs and falls through one that cannot observe', async () => {
  const bridge = new ObservationBridge(200);
  const a = bridge.next(), b = bridge.next();
  const result = bridge.observe('s');
  const first = await Promise.race([a, b]);
  assert.equal(bridge.reply({ nonce: first.nonce, state: 'unknown' }).accepted, true);
  const second = await (first === await a ? b : a);
  assert.equal(bridge.reply({ nonce: second.nonce, state: 'idle' }).accepted, true);
  assert.equal(await result, 'idle'); bridge.close();
});
test('observation detects descendants and fails closed on bad pages', async () => {
  const client = { session: { active: async () => ({ child: true }), list: async ({ parentID }) => ({ data: parentID === 'parent' ? [{ id: 'child' }] : [], cursor: {} }) } };
  assert.equal(await observeFamily(client, 'parent'), 'active');
  client.session.list = async () => ({ data: [] });
  assert.equal(await observeFamily(client, 'parent'), 'unknown');
});

test('isolated snapshot includes tracked and untracked, excludes ignored and preserves project index', async t => {
  const p = await project(t);
  const git = (...args) => execFileSync('git', args, { cwd: p.root, encoding: 'utf8' });
  await p.write('tracked', 'before'); git('add', 'tracked');
  await p.write('tracked', 'after'); await p.write('new', 'new');
  await p.write('.gitignore', 'ignored\n'); await p.write('ignored', 'secret');
  const indexBefore = await readFile(path.join(p.root, '.git', 'index'));
  const snap = await p.snapshot(p.root);
  const list = execFileSync('git', ['--git-dir', snap.repo, 'ls-tree', '-r', '--name-only', snap.tree], { encoding: 'utf8' }).trim().split('\n');
  assert.deepEqual(list.sort(), ['.gitignore', 'new', 'tracked']);
  assert.equal(execFileSync('git', ['--git-dir', snap.repo, 'show', `${snap.tree}:tracked`], { encoding: 'utf8' }), 'after');
  assert.deepEqual(await readFile(path.join(p.root, '.git', 'index')), indexBefore);
  await symlink('tracked', path.join(p.root, 'link'));
  await assert.rejects(p.snapshot(p.root));
});
test('subdirectory capture refuses storage anywhere in the worktree before creating it', async t => {
  const p = await project(t), active = path.join(p.root, 'active'); await mkdir(active);
  const alias = path.join(p.base, 'alias'); await symlink(p.root, alias);
  const storage = path.join(p.root, 'new-store');
  await assert.rejects(capture(active, { dataRoot: storage }), /outside the worktree/);
  await assert.rejects(capture(active, { dataRoot: path.join(alias, 'new-store') }), /outside the worktree/);
  await assert.rejects(readFile(storage), { code: 'ENOENT' });
});
test('ignored active directory includes force-tracked files but excludes ignored untracked files', async t => {
  const p = await project(t), active = path.join(p.root, 'ignored'); await mkdir(active);
  await p.write('.gitignore', 'ignored/\n');
  await writeFile(path.join(active, 'tracked'), 'tracked'); await writeFile(path.join(active, 'untracked'), 'ignored');
  execFileSync('git', ['add', '-f', 'ignored/tracked'], { cwd: p.root });
  const target = await p.snapshot(active);
  const names = execFileSync('git', ['--git-dir', target.repo, 'ls-tree', '-r', '--name-only', target.tree], { encoding: 'utf8' }).trim().split('\n');
  assert.deepEqual(names, ['tracked']);
});

test('workflow rewinds, survives a new instance, and undoes files and staged conversation', async t => {
  const p = await project(t);
  await p.write('file', 'checkpoint');
  const target = await p.snapshot(p.root);
  await p.write('file', 'changed'); await p.write('new', 'new');
  const w = workflowFor(p, { target });
  const prepared = await w.make().prepare({ sessionID: 's', messageID: 'm' });
  assert.deepEqual(prepared.changes, [{ name: 'file', action: 'modify' }, { name: 'new', action: 'delete' }]);
  await w.make().begin({ token: prepared.token }); w.host.revert = { messageID: 'm' };
  assert.equal((await w.make().finish({ token: prepared.token })).success, true);
  assert.equal(await readFile(path.join(p.root, 'file'), 'utf8'), 'checkpoint');
  await assert.rejects(readFile(path.join(p.root, 'new')), { code: 'ENOENT' });
  assert.equal(w.journal().phase, 'staged');
  assert.equal((await undo(w, w.make())).success, true);
  assert.equal(await readFile(path.join(p.root, 'file'), 'utf8'), 'changed');
  assert.equal(await readFile(path.join(p.root, 'new'), 'utf8'), 'new');
  assert.equal(w.journal(), undefined);
});
test('active subdirectory rewind and undo touch only its tracked and eligible untracked files', async t => {
  const p = await project(t, 'rewind-scope-');
  const active = path.join(p.root, 'active[1]'), nested = path.join(active, 'nested');
  await mkdir(active); await mkdir(nested);
  await p.write('.gitignore', '*.cache\n');
  await writeFile(path.join(nested, '.gitignore'), '*.tmp\n');
  await writeFile(path.join(active, 'tracked'), 'old tracked');
  await writeFile(path.join(active, 'deleted'), 'old deleted');
  await writeFile(path.join(active, 'tracked.cache'), 'tracked ignored');
  await writeFile(path.join(active, 'ignored.cache'), 'ignored untouched');
  await writeFile(path.join(nested, 'ignored.tmp'), 'nested ignored untouched');
  await writeFile(path.join(nested, 'kept'), 'nested content');
  await p.write('outside', 'outside old');
  await symlink('outside', path.join(p.root, 'outside-link'));
  execFileSync('git', ['add', 'active[1]/tracked', 'active[1]/deleted', 'outside', 'outside-link'], { cwd: p.root });
  execFileSync('git', ['add', '-f', 'active[1]/tracked.cache'], { cwd: p.root });
  const indexBefore = await readFile(path.join(p.root, '.git', 'index'));
  const target = await p.snapshot(active);
  assert.equal(target.root, await realpath(active));
  const names = execFileSync('git', ['--git-dir', target.repo, 'ls-tree', '-r', '--name-only', target.tree], { encoding: 'utf8' }).trim().split('\n').sort();
  assert.deepEqual(names, ['deleted', 'nested/.gitignore', 'nested/kept', 'tracked', 'tracked.cache']);
  await writeFile(path.join(active, 'tracked'), 'new tracked');
  await rm(path.join(active, 'deleted'));
  await writeFile(path.join(active, 'new'), 'new untracked');
  await p.write('outside', 'outside changed');
  const w = workflowFor(p, { target }), workflow = w.make();
  await rewind(w, workflow);
  assert.equal(await readFile(path.join(active, 'tracked'), 'utf8'), 'old tracked');
  assert.equal(await readFile(path.join(active, 'deleted'), 'utf8'), 'old deleted');
  await assert.rejects(readFile(path.join(active, 'new')), { code: 'ENOENT' });
  assert.equal(await readFile(path.join(p.root, 'outside'), 'utf8'), 'outside changed');
  assert.equal(await readFile(path.join(active, 'ignored.cache'), 'utf8'), 'ignored untouched');
  assert.equal(await readFile(path.join(nested, 'ignored.tmp'), 'utf8'), 'nested ignored untouched');
  assert.deepEqual(await readFile(path.join(p.root, '.git', 'index')), indexBefore);
  await undo(w, workflow);
  assert.equal(await readFile(path.join(active, 'tracked'), 'utf8'), 'new tracked');
  assert.equal(await readFile(path.join(active, 'new'), 'utf8'), 'new untracked');
  await assert.rejects(readFile(path.join(active, 'deleted')), { code: 'ENOENT' });
  assert.equal(await readFile(path.join(p.root, 'outside'), 'utf8'), 'outside changed');
  assert.deepEqual(await readFile(path.join(p.root, '.git', 'index')), indexBefore);
  const alias = path.join(p.root, 'active-alias'); await symlink(active, alias);
  await assert.rejects(p.snapshot(alias), /symlinked active directory/);
  await assert.rejects(p.snapshot(path.join(alias, 'nested')), /symlinked active directory/);
  await symlink(path.join(p.root, 'outside'), path.join(active, 'unsafe-link'));
  await assert.rejects(p.snapshot(active));
});
test('workflow rejects preview conflicts and unknown activity without staging', async t => {
  const p = await project(t);
  await p.write('file', 'one'); const target = await p.snapshot(p.root);
  await p.write('file', 'two'); let observed = 'idle';
  const w = workflowFor(p, { target, observe: async () => observed }), workflow = w.make();
  const prepared = await workflow.prepare({ sessionID: 's', messageID: 'm' });
  observed = 'unknown'; await assert.rejects(workflow.begin({ token: prepared.token }), /unknown/);
  observed = 'idle'; await p.write('file', 'external edit');
  await assert.rejects(workflow.begin({ token: prepared.token }), /changed since preview/);
  assert.equal(await readFile(path.join(p.root, 'file'), 'utf8'), 'external edit');
  assert.equal(w.journal().phase, 'prepared');
});
test('finish refuses when the host stage was not observed, leaving files untouched', async t => {
  const p = await project(t);
  await p.write('file', 'checkpoint'); const target = await p.snapshot(p.root);
  await p.write('file', 'later');
  const w = workflowFor(p, { target }), workflow = w.make();
  const prepared = await workflow.prepare({ sessionID: 's', messageID: 'm' });
  await workflow.begin({ token: prepared.token });
  await assert.rejects(workflow.finish({ token: prepared.token }), /revert not observed/);
  assert.equal(await readFile(path.join(p.root, 'file'), 'utf8'), 'later');
  assert.equal(w.journal().phase, 'await-stage');
});
test('mid-restore conflict retains a recovery journal and does not overwrite the conflicting file', async t => {
  const p = await project(t);
  await p.write('a', 'checkpoint-a'); await p.write('b', 'checkpoint-b');
  const target = await p.snapshot(p.root);
  await p.write('a', 'later-a'); await p.write('b', 'later-b');
  // A concurrent writer changes b right after the last pre-restore comparison.
  let interfere = false;
  const snapshot = async (dir, opts) => { const s = await p.snapshot(dir, opts); if (interfere && opts?.ref === false) await p.write('b', 'concurrent-b'); return s; };
  const w = workflowFor(p, { target, snapshot }), workflow = w.make();
  const prepared = await workflow.prepare({ sessionID: 's', messageID: 'm' });
  await workflow.begin({ token: prepared.token }); w.host.revert = { messageID: 'm' };
  interfere = true;
  await assert.rejects(workflow.finish({ token: prepared.token }), /Restore incomplete/);
  assert.equal(w.journal().phase, 'recovery-required'); assert.equal(w.journal().current, 'b');
  assert.equal(await readFile(path.join(p.root, 'a'), 'utf8'), 'checkpoint-a');
  assert.equal(await readFile(path.join(p.root, 'b'), 'utf8'), 'concurrent-b');
});
test('recovery rejects unexpected edits before restoring any file', async t => {
  const p = await project(t);
  await p.write('a', 'old-a'); await p.write('b', 'old-b'); const before = await p.snapshot(p.root);
  await p.write('a', 'new-a'); await p.write('b', 'new-b'); const target = await p.snapshot(p.root);
  await p.write('b', 'external');
  const w = workflowFor(p, { target }); w.host.revert = { messageID: 'm' };
  w.storage.map.set('rewind-journal', { sessionID: 's', messageID: 'm', before, target, phase: 'recovery-required' });
  const workflow = w.make();
  await assert.rejects(workflow.recoverFiles({ sessionID: 's' }), /Recovery conflict: b/);
  assert.equal(await readFile(path.join(p.root, 'a'), 'utf8'), 'new-a');
  await p.write('b', 'new-b');
  const result = await workflow.recoverFiles({ sessionID: 's' });
  assert.equal(result.success, false); assert.equal(w.journal().phase, 'await-clear');
  assert.equal(await readFile(path.join(p.root, 'a'), 'utf8'), 'old-a'); assert.equal(await readFile(path.join(p.root, 'b'), 'utf8'), 'old-b');
});
test('previewRecovery lists only actual recovery changes and does not mutate state', async t => {
  const p = await project(t);
  await p.write('create', 'old'); await p.write('modify', 'old'); await p.write('unchanged', 'old');
  const before = await p.snapshot(p.root);
  await rm(path.join(p.root, 'create')); await p.write('delete', 'new'); await p.write('modify', 'new'); await p.write('unchanged', 'new');
  const target = await p.snapshot(p.root);
  await p.write('unchanged', 'old');
  const w = workflowFor(p, { target }); w.host.revert = { messageID: 'm' };
  const journal = { sessionID: 's', messageID: 'm', before, target, phase: 'recovery-required', current: 'modify' };
  w.storage.map.set('rewind-journal', structuredClone(journal));
  const workflow = w.make(), result = await workflow.previewRecovery({ sessionID: 's' });
  assert.equal(result.success, true);
  assert.deepEqual(result.changes, [{ name: 'create', action: 'create' }, { name: 'delete', action: 'delete' }, { name: 'modify', action: 'modify' }]);
  assert.deepEqual(w.journal(), journal); assert.deepEqual(w.host.revert, { messageID: 'm' });
  assert.equal(await readFile(path.join(p.root, 'modify'), 'utf8'), 'new');
  assert.equal(await readFile(path.join(p.root, 'delete'), 'utf8'), 'new');
  await assert.rejects(readFile(path.join(p.root, 'create')), { code: 'ENOENT' });
  await workflow.recoverFiles({ sessionID: 's' });
  assert.equal(await readFile(path.join(p.root, 'create'), 'utf8'), 'old');
  assert.equal(await readFile(path.join(p.root, 'modify'), 'utf8'), 'old');
  await assert.rejects(readFile(path.join(p.root, 'delete')), { code: 'ENOENT' });
});
test('previewRecovery refuses conflicts and execution rechecks after preview', async t => {
  const p = await project(t);
  await p.write('a', 'old'); await p.write('b', 'old'); const before = await p.snapshot(p.root);
  await p.write('a', 'new'); await p.write('b', 'new'); const target = await p.snapshot(p.root);
  const w = workflowFor(p, { target }), workflow = w.make();
  const journal = { sessionID: 's', messageID: 'm', before, target, phase: 'recovery-required' };
  w.storage.map.set('rewind-journal', structuredClone(journal));
  assert.deepEqual(await workflow.previewRecovery({ sessionID: 'other' }), { success: false, message: 'No recoverable rewind state is recorded for this session.', changes: [] });
  w.host.revert = { messageID: 'different' };
  assert.match((await workflow.previewRecovery({ sessionID: 's' })).message, /different conversation revert/);
  w.host.revert = undefined;
  assert.equal((await workflow.previewRecovery({ sessionID: 's' })).changes.length, 2);
  await p.write('b', 'external');
  assert.deepEqual(await workflow.previewRecovery({ sessionID: 's' }), { success: false, message: 'Recovery conflict: files changed unexpectedly. No files were changed.', changes: [] });
  await assert.rejects(workflow.recoverFiles({ sessionID: 's' }), /Recovery conflict: b/);
  assert.deepEqual(w.journal(), journal); assert.equal(await readFile(path.join(p.root, 'a'), 'utf8'), 'new');
});
test('previewRecovery hides unexpected backend error details', async () => {
  const workflow = new Workflow({ storage: { get: async () => { throw new Error('sensitive backend details'); } }, session: {}, observe: async () => 'idle', getBinding: async () => undefined });
  assert.deepEqual(await workflow.previewRecovery({ sessionID: 's' }), { success: false, message: 'Recovery preview unavailable. Inspect recovery state and retry.', changes: [] });
});
test('restore rejects symlink parents, symlink leaves and mismatched files', async t => {
  const base = await mkdtemp(path.join(tmpdir(), 'rewind-refusal-')); t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'root'), outside = path.join(base, 'outside'); await mkdir(root); await mkdir(outside);
  await writeFile(path.join(outside, 'target'), 'outside');
  await symlink(outside, path.join(root, 'parent'));
  await symlink(path.join(outside, 'target'), path.join(root, 'leaf'));
  await writeFile(path.join(root, 'conflict'), 'external edit');
  const canonical = await realpath(root), expected = { mode: '100644', oid: '0'.repeat(40) };
  await assert.rejects(applyOne(canonical, 'parent/target', expected, null, '/unused'), /unsafe parent|symlink/);
  await assert.rejects(applyOne(canonical, 'leaf', expected, null, '/unused'));
  await assert.rejects(applyOne(canonical, 'conflict', expected, null, '/unused'), /file changed/);
  assert.equal(await readFile(path.join(outside, 'target'), 'utf8'), 'outside');
  assert.equal(await readFile(path.join(root, 'conflict'), 'utf8'), 'external edit');
});
test('preview lists creations, modifications and deletions', async t => {
  const p = await project(t);
  await p.write('keep', '1'); await p.write('gone', '1'); const from = await p.snapshot(p.root);
  await p.write('keep', '2'); await rm(path.join(p.root, 'gone')); await p.write('added', '1'); const to = await p.snapshot(p.root);
  assert.deepEqual(await preview(from, to), [{ name: 'added', action: 'create' }, { name: 'gone', action: 'delete' }, { name: 'keep', action: 'modify' }]);
});

test('prepare drops a journal whose session no longer exists and releases its pre-restore snapshot', async t => {
  const p = await project(t);
  await p.write('file', 'checkpoint'); const target = await p.snapshot(p.root);
  await p.write('file', 'later'); const stale = await p.snapshot(p.root);
  const session = { get: async ({ sessionID }) => { if (sessionID === 'deleted') throw Object.assign(new Error('Session not found'), { _tag: 'SessionNotFoundError' }); return {}; } };
  const w = workflowFor(p, { target, session });
  w.storage.map.set('rewind-journal', { sessionID: 'deleted', messageID: 'x', before: stale, target, phase: 'staged' });
  const prepared = await w.make().prepare({ sessionID: 's', messageID: 'm' });
  assert.equal(w.journal().token, prepared.token);
  assert.equal(w.storage.map.get(releaseKey(stale)).state, 'pending');
});
test('prepare supersedes an unstaged await-stage journal but refuses one whose stage is visible', async t => {
  const p = await project(t);
  await p.write('file', 'checkpoint'); const target = await p.snapshot(p.root);
  await p.write('file', 'later');
  const w = workflowFor(p, { target }), workflow = w.make();
  const first = await workflow.prepare({ sessionID: 's', messageID: 'm' });
  await workflow.begin({ token: first.token });
  const firstBefore = w.journal().before;
  const second = await workflow.prepare({ sessionID: 's', messageID: 'm' });
  assert.notEqual(second.token, first.token);
  assert.equal(w.storage.map.get(releaseKey(firstBefore)).reason, 'stage not observed');
  await workflow.begin({ token: second.token }); w.host.revert = { messageID: 'm' };
  await assert.rejects(workflow.prepare({ sessionID: 's', messageID: 'm' }), /unresolved/);
  assert.equal(w.journal().phase, 'await-stage');
});
test('discard resolves dead-end journals without changing files and releases the pre-restore snapshot', async t => {
  const p = await project(t);
  await p.write('file', 'checkpoint'); const target = await p.snapshot(p.root);
  await p.write('file', 'later'); const before = await p.snapshot(p.root);
  for (const phase of ['await-stage', 'await-clear', 'recovered-files-host-unknown', 'recovery-required', 'staged']) {
    const w = workflowFor(p, { target }), workflow = w.make();
    w.storage.map.set('rewind-journal', { sessionID: 's', messageID: 'm', before, target, phase });
    await assert.rejects(workflow.discard({ sessionID: 'other' }), /No rewind state/);
    const result = await workflow.discard({ sessionID: 's' });
    assert.equal(result.success, true); assert.match(result.message, /Files and conversation were not changed/);
    assert.equal(w.journal(), undefined);
    assert.equal(w.storage.map.get(releaseKey(before)).reason, 'discarded by user');
    assert.equal(await readFile(path.join(p.root, 'file'), 'utf8'), 'later');
  }
});
