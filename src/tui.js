import { RewindRpc } from './rpc.js';
import { observeFamily } from './observe.js';

// Host mutations stay TUI-driven, never part of the observation RPC.
// A timeout is ambiguous: the request may still complete, so never retry it.
async function hostCall(call) {
  let timer;
  try {
    return await Promise.race([call(), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Host request timed out; its outcome is unknown.')), 15000);
    })]);
  } finally { clearTimeout(timer); }
}

function previewText(changes) {
  if (!Array.isArray(changes) || changes.some(c => !c || typeof c.name !== 'string' || !['create', 'modify', 'delete'].includes(c.action))) {
    throw new Error('Invalid file preview. No changes were made.');
  }
  return ['create', 'modify', 'delete'].map(action => {
    const names = changes.filter(c => c.action === action).map(c => `  ${c.name.replace(/[\r\n\x00-\x1f\x7f]/g, ' ')}`);
    return `${action[0].toUpperCase() + action.slice(1)} (${names.length})${names.length ? `\n${names.join('\n')}` : ''}`;
  }).join('\n\n');
}

// The host confirmation dialog has a fixed viewport. Page long previews so
// confirmation never hides file names below its visible area.
function previewPages(text) {
  const lines = text.split('\n').flatMap(line => {
    if (!line) return [''];
    const chars = Array.from(line), chunks = [];
    while (chars.length) chunks.push(chars.splice(0, 42).join(''));
    return chunks;
  });
  const pages = [];
  for (let i = 0; i < lines.length; i += 10) pages.push(lines.slice(i, i + 10).join('\n'));
  return pages;
}

function installUI(ctx, rpc) {
  const dialog = ctx.ui.dialog;
  const call = (name, input = {}) => {
    if (typeof rpc[name] !== 'function') throw new Error('Rewind backend is not ready. No changes were made.');
    return rpc[name](input);
  };
  const alert = (title, message) => dialog.alert({ title, message });
  const describe = error => { if (error instanceof Error) return error.message; if (error && typeof error === 'object') { try { return error.message ? `${error._tag ? error._tag + ': ' : ''}${error.message}` : JSON.stringify(error); } catch {} } return String(error); };
  const failure = error => alert('Rewind could not finish', `${describe(error)}\n\nIf an operation started, inspect recovery before trying again.`);
  const sessionID = () => {
    const route = ctx.ui.router.current();
    if (route.type !== 'session') throw new Error('Open a session first.');
    return route.sessionID;
  };
  const stage = (sid, mid) => hostCall(() => ctx.client.session.revert.stage({ sessionID: sid, messageID: mid, files: false }));
  async function rewind(sid, message, available) {
    if (!available) {
      if (!await dialog.confirm({ title: 'Conversation only', message: 'Rewind this conversation to the selected prompt? Files will not change.', label: { confirm: 'Rewind conversation', cancel: 'Cancel' } })) return;
      await stage(sid, message.id);
      ctx.ui.toast.show({ message: 'Conversation revert staged. Files were not changed.', variant: 'info' });
      return;
    }
    const prepared = await call('prepare', { sessionID: sid, messageID: message.id });
    if (typeof prepared?.token !== 'string' || !prepared.token) throw new Error(prepared?.reason || 'File rewind is unavailable.');
    const preview = previewText(prepared.changes);
    const pages = previewPages(preview);
    if (pages.length > 1) {
      for (let i = 0; i < pages.length; i++) await alert(`File preview ${i + 1}/${pages.length}`, pages[i]);
    }
    if (!await dialog.confirm({ title: 'Confirm file rewind', message: `${pages.length > 1 ? `Reviewed ${prepared.changes.length} file changes above.` : preview}\n\nIgnored files, submodules, outside paths, databases and external effects are not restored. Files can change while you review. Continue?`, label: { confirm: 'Rewind files and conversation', cancel: 'Cancel' } })) return;
    const begun = await call('begin', { token: prepared.token });
    if (begun?.sessionID !== sid || begun?.messageID !== message.id) throw new Error('Rewind target could not be verified. Inspect recovery.');
    await stage(sid, message.id);
    const result = await call('finish', { token: prepared.token });
    if (result?.success !== true) throw new Error(result?.message || 'File rewind did not complete.');
    ctx.ui.toast.show({ message: result.message || 'Rewind completed.', variant: 'success' });
  }
  async function undo(sid) {
    if (!await dialog.confirm({ title: 'Undo rewind', message: 'Restore files and conversation from before the rewind? Conversation undo is unavailable after the staged revert is committed.', label: { confirm: 'Undo rewind', cancel: 'Cancel' } })) return;
    const begun = await call('beginUndo', { sessionID: sid });
    if (begun?.success !== true || begun.sessionID !== sid || typeof begun.messageID !== 'string') throw new Error(begun?.message || 'Undo could not start.');
    await hostCall(() => ctx.client.session.revert.clear({ sessionID: sid }));
    const result = await call('finishUndo', { sessionID: sid });
    if (result?.success !== true) throw new Error(result?.message || 'Undo did not complete.');
    ctx.ui.toast.show({ message: result.message || 'Rewind undone.', variant: 'success' });
  }
  async function recoverFiles(sid) {
    const state = await call('recovery', { sessionID: sid });
    const prepared = await call('previewRecovery', { sessionID: sid });
    if (prepared?.success !== true) {
      await alert('Recovery unavailable', prepared?.message || 'Recovery preview is unavailable. No files were changed.');
      return;
    }
    const pages = previewPages(previewText(prepared?.changes));
    for (let i = 0; i < pages.length; i++) await alert(`Recovery file preview ${i + 1}/${pages.length}`, pages[i]);
    if (!await dialog.confirm({ title: 'Recover files only', message: `${state?.message || 'Recovery state unavailable.'}\n${prepared?.message || ''}\n\nReviewed ${prepared.changes.length} file changes above. This attempts to restore files from before the interrupted operation. It does not resolve conversation state. Files can change while you review; recovery rechecks for conflicts. Continue?`, label: { confirm: 'Recover files', cancel: 'Cancel' } })) return;
    const result = await call('recoverFiles', { sessionID: sid });
    // The backend intentionally reports partial recovery as success:false.
    await alert('File recovery', result?.message || 'Recovery did not report an outcome. Inspect recovery before continuing.');
  }
  async function discard(sid) {
    const state = await call('recovery', { sessionID: sid });
    if (!await dialog.confirm({ title: 'Discard rewind state', message: `${state?.message || 'Recovery state unavailable.'}\n\nForget this rewind state? Files and conversation are not changed. Undo and file recovery for this rewind will no longer be available.`, label: { confirm: 'Discard state', cancel: 'Cancel' } })) return;
    const result = await call('discard', { sessionID: sid });
    ctx.ui.toast.show({ message: result?.message || 'Rewind state discarded.', variant: 'info' });
  }
  async function deleteSnapshot(sid, message) {
    if (!await dialog.confirm({ title: 'Delete snapshot', message: 'Delete the file snapshot for this prompt? The conversation and current files will not change. This snapshot cannot be used for file rewind afterward.', label: { confirm: 'Delete snapshot', cancel: 'Cancel' } })) return;
    const result = await call('deleteSnapshot', { sessionID: sid, messageID: message.id });
    if (result?.success !== true) throw new Error(result?.message || 'Snapshot could not be deleted.');
    ctx.ui.toast.show({ message: result.message || 'Snapshot deleted.', variant: 'success' });
  }
  async function clearSnapshots(sid) {
    if (!await dialog.confirm({ title: 'Clear all snapshots', message: 'Delete all file snapshots for every prompt in this session? Current files and the conversation will not change. These snapshots cannot be used for file rewind afterward.', label: { confirm: 'Clear all snapshots', cancel: 'Cancel' } })) return;
    const result = await call('clearSnapshots', { sessionID: sid });
    if (result?.success !== true) throw new Error(result?.message || 'Snapshots could not be cleared.');
    ctx.ui.toast.show({ message: result.message || 'All snapshots cleared.', variant: 'success' });
  }
  const actions = { undo, recoverFiles, discard, inspect: async () => alert('Storage', (await call('inspect'))?.message || 'No information available.'), recovery: async sid => alert('Recovery', (await call('recovery', { sessionID: sid }))?.message || 'No information available.') };
  async function open() {
    try {
      const sid = sessionID();
      await ctx.data.session.message.sync(sid);
      const messages = ctx.data.session.message.list(sid).filter(m => m.type === 'user' && typeof m.id === 'string');
      const checkpoints = await Promise.all(messages.map(async message => {
        try { return await call('checkpoint', { sessionID: sid, messageID: message.id }); }
        catch { return { status: 'unavailable' }; }
      }));
      const options = messages.map((message, index) => ({
        title: `${checkpoints[index]?.status === 'available' ? '◆ ' : '  '}${(message.text || '(empty prompt)').replace(/\s+/g, ' ').trim().slice(0, 120)}`,
        value: index,
      })).reverse();
      // Close the picker before showing a confirmation or preview dialog.
      const action = (fn, reopen = false) => async value => {
        dialog.clear();
        try { await fn(value); } catch (error) { await failure(error); }
        if (reopen) await open();
      };
      const selection = dialog.select({ title: 'Rewind · ◆ file checkpoint', placeholder: 'Search prompts', options, actions: [
        { bind: 'ctrl+d', title: 'Delete snapshot', onTrigger: action(index => deleteSnapshot(sid, messages[index]), true) },
        { bind: 'ctrl+x', title: 'Clear all snapshots', selection: 'none', onTrigger: action(() => clearSnapshots(sid), true) },
        { bind: 'ctrl+z', title: 'Undo rewind', selection: 'none', onTrigger: action(() => undo(sid)) },
        { bind: 'ctrl+r', title: 'Recover files only', selection: 'none', onTrigger: action(() => recoverFiles(sid)) },
      ] });
      if (typeof dialog.set === 'function') dialog.set({ size: 'large' });
      const selected = await selection;
      if (typeof selected === 'number' && messages[selected]) return await rewind(sid, messages[selected], checkpoints[selected]?.status === 'available');
    } catch (error) { await failure(error); }
  }
  ctx.keymap.layer(() => ({ mode: 'global', commands: [
    { id: 'rewind.open', title: 'Rewind', description: 'Select a prompt to rewind', slash: { name: 'rewind' }, palette: true, run: open },
    ...[['inspect', 'Inspect rewind storage'], ['recovery', 'Inspect rewind recovery'], ['discard', 'Discard rewind state']].map(([id, title]) => ({ id: `rewind.${id}`, title, palette: true, run: async () => { try { await actions[id](sessionID()); } catch (error) { await failure(error); } } })),
  ] }));
}
export default { id: 'opencode-rewind', async setup(ctx) {
  const rpc = ctx.client.rpc(RewindRpc); let stopped = false;
  installUI(ctx, rpc);
  // Answer the server's read-only activity observations; retry after transient disconnects.
  void (async () => { while (!stopped) {
    try { const request = await rpc.next({}); if (stopped) break;
      const state = await observeFamily(ctx.client, request.sessionID);
      await rpc.reply({ nonce: request.nonce, state });
    } catch { if (!stopped) await new Promise(r => setTimeout(r, 1000)); }
  } })();
  return () => { stopped = true; };
} };
