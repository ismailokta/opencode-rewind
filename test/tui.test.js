import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// Node exposes SourceTextModule only with --experimental-vm-modules.
const uiTest = vm.SourceTextModule ? test : test.skip;

async function harness() {
  const events = [], alerts = [], confirmations = [], toasts = [], sizes = [];
  let choice = 0, confirm = true, timeout = false, command, commands, selectOptions;
  const context = vm.createContext({ setTimeout: (fn, ms) => setTimeout(fn, timeout ? 1 : ms), clearTimeout });
  const module = new vm.SourceTextModule(await readFile(new URL('../src/tui.js', import.meta.url), 'utf8'), { context });
  await module.link(async path => new vm.SyntheticModule(path === './rpc.js' ? ['RewindRpc'] : ['observeFamily'], function () {
    if (path === './rpc.js') this.setExport('RewindRpc', {});
    else this.setExport('observeFamily', async () => 'idle');
  }, { context }));
  await module.evaluate();
  const rpc = {
    next: () => new Promise(() => {}),
    checkpoint: async () => ({ status: 'available', reason: '' }),
    prepare: async () => ({ token: 'token', changes: [{ name: 'new', action: 'create' }, { name: 'old', action: 'delete' }, { name: 'edit', action: 'modify' }], reason: '' }),
    begin: async () => (events.push('begin'), { sessionID: 's', messageID: 'm' }),
    finish: async () => (events.push('finish'), { success: true, message: 'done' }),
    beginUndo: async () => (events.push('beginUndo'), { success: true, sessionID: 's', messageID: 'm' }),
    finishUndo: async () => (events.push('finishUndo'), { success: true, message: 'undone' }),
    recovery: async () => ({ message: 'Journal phase recovery-required' }),
    previewRecovery: async () => ({ success: true, changes: [{ name: 'restore-me', action: 'create' }], message: 'Recovery preview.' }),
    recoverFiles: async () => (events.push('recoverFiles'), { success: false, message: 'Files recovered; conversation remains staged.' }),
    discard: async () => (events.push('discard'), { success: true, message: 'Rewind state discarded.' }),
    deleteSnapshot: async input => (events.push(['deleteSnapshot', input.sessionID, input.messageID]), { success: true, message: 'Snapshot deleted.' }),
    clearSnapshots: async input => (events.push(['clearSnapshots', input.sessionID]), { success: true, message: 'Snapshots cleared.' }),
  };
  const ctx = {
    client: { rpc: () => rpc, session: { revert: {
      stage: async input => { events.push(['stage', input.sessionID, input.messageID, input.files]); if (timeout) await new Promise(() => {}); },
      clear: async input => { events.push(['clear', input.sessionID]); if (timeout) await new Promise(() => {}); },
    } } },
    keymap: { layer: factory => { const layer = factory(); assert.equal(layer.mode, 'global'); commands = layer.commands; command = commands[0]; } },
    data: { session: { message: { sync: async () => {}, list: () => [{ type: 'user', id: 'm', text: 'A prompt' }] } } },
    ui: { router: { current: () => ({ type: 'session', sessionID: 's' }) }, toast: { show: x => toasts.push(x) }, dialog: {
      select: async options => { selectOptions = options; events.push(['select', options.options[0]?.title]); if (typeof choice === 'string') { const bind = choice; choice = undefined; await options.actions.find(a => a.bind === bind).onTrigger(0); } return choice; },
      clear: () => {},
      set: options => sizes.push(options.size),
      confirm: async options => { confirmations.push(options); return confirm; },
      alert: async options => { alerts.push(options); },
    } },
  };
  await module.namespace.default.setup(ctx);
  return { rpc, events, alerts, confirmations, toasts, sizes, run: () => command.run(), runCommand: id => commands.find(c => c.id === id).run(), options: () => selectOptions, choice: value => { choice = value; }, confirm: value => { confirm = value; }, timeout: () => { timeout = true; } };
}

uiTest('file preview requires confirmation and stages before finishing', async () => {
  const h = await harness(); await h.run();
  assert.deepEqual(h.sizes, ['large']);
  assert.match(h.events[0][1], /◆/);
  assert.match(h.options().options[0].title, /^◆ /);
  for (const name of ['new', 'old', 'edit']) assert.match(h.confirmations[0].message, new RegExp(name));
  assert.deepEqual(h.events.slice(1), ['begin', ['stage', 's', 'm', false], 'finish']);
  assert.equal(h.toasts[0].variant, 'success');
  const cancelled = await harness(); cancelled.confirm(false); await cancelled.run();
  assert.equal(cancelled.events.length, 1);
});

uiTest('unavailable prompt remains selectable with conversation-only confirmation', async () => {
  const h = await harness(); h.rpc.checkpoint = async () => ({ status: 'unavailable', reason: 'unknown' }); await h.run();
  assert.doesNotMatch(h.events[0][1], /◆/);
  assert.match(h.options().options[0].title, /^○ /);
  assert.match(h.confirmations[0].message, /Files will not change/);
  assert.deepEqual(h.events.slice(1), [['stage', 's', 'm', false]]);
});

uiTest('undo and recovery respect confirmation and report partial recovery', async () => {
  const h = await harness(); h.choice('ctrl+z'); await h.run();
  assert.deepEqual(h.events.slice(1), ['beginUndo', ['clear', 's'], 'finishUndo']);
  const recovery = await harness(); recovery.choice('ctrl+r'); recovery.confirm(false); await recovery.run();
  assert.match(recovery.alerts[0].message, /restore-me/);
  assert.match(recovery.confirmations[0].message, /rechecks for conflicts/);
  assert.match(recovery.confirmations[0].message, /does not resolve conversation state/);
  assert.equal(recovery.events.length, 1);
  recovery.confirm(true); recovery.choice('ctrl+r'); await recovery.run();
  assert.equal(recovery.events.at(-1), 'recoverFiles');
  assert.match(recovery.alerts.at(-1).message, /conversation remains staged/);
  assert.equal(recovery.toasts.length, 0);
});

uiTest('ambiguous host timeout stops the sequence without retry', async () => {
  const h = await harness(); h.timeout(); await h.run();
  assert.deepEqual(h.events.slice(1), ['begin', ['stage', 's', 'm', false]]);
  assert.match(h.alerts[0].message, /outcome is unknown/);
  assert.equal(h.toasts.length, 0);
  const undo = await harness(); undo.choice('ctrl+z'); undo.timeout(); await undo.run();
  assert.deepEqual(undo.events.slice(1), ['beginUndo', ['clear', 's']]);
  assert.equal(undo.toasts.length, 0);
});

uiTest('invalid preview and failed backend never show success', async () => {
  const h = await harness(); h.rpc.prepare = async () => ({ token: 'x', changes: [{ name: 'x', action: 'other' }] }); await h.run();
  assert.equal(h.events.length, 1); assert.match(h.alerts[0].message, /Invalid file preview/);
  const failed = await harness(); failed.rpc.finish = async () => ({ success: false, message: 'restore failed' }); await failed.run();
  assert.match(failed.alerts[0].message, /restore failed/); assert.equal(failed.toasts.length, 0);
});

uiTest('long previews are paged before confirmation', async () => {
  const h = await harness();
  h.rpc.prepare = async () => ({ token: 'x', changes: Array.from({ length: 25 }, (_, i) => ({ name: `file-${i}`, action: 'modify' })) });
  h.confirm(false); await h.run();
  assert.ok(h.alerts.length > 1);
  assert.match(h.alerts.map(x => x.message).join('\n'), /file-24/);
  assert.match(h.confirmations[0].message, /Reviewed 25 file changes/);
  assert.equal(h.events.length, 1);
});

uiTest('discarding rewind state requires confirmation that files and conversation are unchanged', async () => {
  const h = await harness(); h.confirm(false); await h.runCommand('rewind.discard');
  assert.match(h.confirmations[0].message, /Files and conversation are not changed/);
  assert.equal(h.events.length, 0);
  h.confirm(true); await h.runCommand('rewind.discard');
  assert.deepEqual(h.events, ['discard']);
  assert.equal(h.toasts[0].message, 'Rewind state discarded.');
});

uiTest('prompt list exposes shortcut actions and confirms snapshot deletion', async () => {
  const h = await harness(); h.choice('ctrl+d'); h.confirm(false); await h.run();
  assert.equal(h.options().options.length, 1);
  assert.deepEqual(Array.from(h.options().actions, a => a.bind), ['ctrl+d', 'ctrl+x', 'ctrl+z', 'ctrl+r']);
  assert.match(h.confirmations[0].message, /conversation and current files will not change/);
  assert.equal(h.events.filter(e => Array.isArray(e) && e[0] === 'deleteSnapshot').length, 0);
  h.confirm(true); h.choice('ctrl+d'); await h.run();
  assert.deepEqual(h.events.find(e => Array.isArray(e) && e[0] === 'deleteSnapshot'), ['deleteSnapshot', 's', 'm']);
  assert.equal(h.toasts[0].variant, 'success');
});

uiTest('clear all snapshots is session-wide, confirmed and works without a selection', async () => {
  const h = await harness(); h.choice('ctrl+x'); h.confirm(false); await h.run();
  assert.equal(h.options().actions.find(a => a.bind === 'ctrl+x').selection, 'none');
  assert.match(h.confirmations[0].message, /every prompt in this session/);
  assert.match(h.confirmations[0].message, /files and the conversation will not change/);
  assert.equal(h.events.filter(e => Array.isArray(e) && e[0] === 'clearSnapshots').length, 0);
  h.confirm(true); h.choice('ctrl+x'); await h.run();
  assert.deepEqual(h.events.find(e => Array.isArray(e) && e[0] === 'clearSnapshots'), ['clearSnapshots', 's']);
  assert.equal(h.toasts[0].message, 'Snapshots cleared.');
});

uiTest('clear all snapshots reports backend failure without success', async () => {
  const h = await harness(); h.rpc.clearSnapshots = async () => ({ success: false, message: 'busy' });
  h.choice('ctrl+x'); await h.run();
  assert.match(h.alerts[0].message, /busy/); assert.equal(h.toasts.length, 0);
});

uiTest('snapshot deletion failure is reported without success', async () => {
  const h = await harness(); h.rpc.deleteSnapshot = async () => ({ success: false, message: 'busy' });
  h.choice('ctrl+d'); await h.run();
  assert.match(h.alerts[0].message, /busy/); assert.equal(h.toasts.length, 0);
});

uiTest('recovery pages the complete preview before confirmation', async () => {
  const h = await harness();
  h.rpc.previewRecovery = async input => {
    assert.equal(input.sessionID, 's');
    return { success: true, changes: Array.from({ length: 25 }, (_, i) => ({ name: `recovery-file-${i}`, action: 'modify' })), message: 'Preview ready.' };
  };
  h.choice('ctrl+r'); h.confirm(false); await h.run();
  assert.ok(h.alerts.length > 1);
  assert.match(h.alerts.map(x => x.message).join('\n'), /recovery-file-24/);
  assert.match(h.confirmations[0].message, /Reviewed 25 file changes/);
  assert.ok(!h.events.includes('recoverFiles'));
});

uiTest('recovery preview failure or malformed changes prevent confirmation and mutation', async () => {
  for (const preview of [async () => { throw new Error('Recovery conflict'); }, async () => ({ success: true, changes: [{ name: 'x', action: 'invalid' }] })]) {
    const h = await harness(); h.rpc.previewRecovery = preview; h.choice('ctrl+r'); await h.run();
    assert.equal(h.confirmations.length, 0);
    assert.ok(!h.events.includes('recoverFiles'));
    assert.match(h.alerts[0].message, /Recovery conflict|Invalid file preview/);
  }
});

uiTest('unavailable recovery displays backend explanation without confirmation or mutation', async () => {
  const h = await harness(); h.rpc.previewRecovery = async () => ({ success: false, changes: [], message: 'No rewind state is recorded.' });
  h.choice('ctrl+r'); await h.run();
  assert.equal(h.alerts[0].title, 'Recovery unavailable');
  assert.equal(h.alerts[0].message, 'No rewind state is recorded.');
  assert.equal(h.confirmations.length, 0);
  assert.ok(!h.events.includes('recoverFiles'));
});
