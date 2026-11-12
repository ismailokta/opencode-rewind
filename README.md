# OpenCode Rewind

Rewind a session's conversation and files to an earlier prompt, including file edits made by background subagents. Rewind is a separate `/rewind` workflow; OpenCode's built-in `/timeline` is unchanged. No user configuration is changed by this package.

## Install

Clone the plugin and install its host-compatible dependencies:

```sh
git clone https://github.com/ismailokta/opencode-rewind.git ~/.config/opencode/plugins/opencode-rewind
cd ~/.config/opencode/plugins/opencode-rewind
npm install --no-save --ignore-scripts
```

Add the cloned path to the `plugins` array of your project's `opencode.json` or global `~/.config/opencode/opencode.json`:

```json
{
  "plugins": ["/absolute/path/to/.config/opencode/plugins/opencode-rewind"]
}
```

Restart OpenCode and type `/rewind` in a session. Prompts marked `◆` have a file checkpoint; unmarked prompts can only rewind the conversation. Stop other writers before confirming a file rewind. To update, run `git pull` inside the cloned directory, then restart OpenCode.

## Safety limits

- **Not atomic.** Restore, undo and file recovery use path-based filesystem operations. They refuse observed symlinks and re-check each file's expected contents; a mismatch fails instead of overwriting. The checks are not atomic with the final write or delete, so an uncooperative concurrent process can still change a file, or replace a parent directory with a symlink, between check and write. This is best-effort conflict detection, not a security boundary or a lock.
- **Activity checks are best-effort.** A checkpoint is taken only when related sessions are observed idle (see below); this is not a lock against concurrent writes.
- **Scope.** Only the active directory is captured: project-tracked and non-ignored untracked regular files beneath it, with Git's ignore rules. Ignored files, empty directories, paths outside the active directory, symlinks, submodules, databases and external side effects are not restored. Active directories reached through a symlink are refused.

## Activity observation

- Before each prompt is admitted, the server asks a connected TUI whether the session or any of its descendants is active. The TUI answers from read-only server-wide session state.
- Several TUIs on one server (for example `opencode serve --service` with many panes) are supported. The server asks each waiting TUI in turn until one gives a definite answer.
- OpenCode creates one server plugin instance per location and recreates it on hot reload. All instances in one process share a single observation bridge.
- No TUI, a timeout, an incomplete listing, active work or a capture error means no file checkpoint for that prompt. Observation replies never trigger mutations.

## Storage

Snapshots are stored in an isolated bare Git repository under `$XDG_DATA_HOME/opencode/rewind` (default `~/.local/share/opencode/rewind`), outside every project worktree. The project's Git index, branches and commits are never touched. Prompt bindings and the operation journal use plugin storage and survive restarts.

Each capture creates one ref, `refs/rewind/<uuid>`, owned by exactly one `(sessionID, messageID)` binding or, for the pre-restore snapshot, by the operation journal. Forks do not inherit file checkpoints: a fork's inherited prompts allow conversation-only rewind, and prompts submitted in the fork get their own captures. Comparison-only captures create no ref.

When a session is deleted, these steps run in order. Each is persisted and replays after a crash:

1. Journal the deletion event.
2. Write a tombstone for each of the session's bindings and archived journals, then remove the binding or archive.
3. If the operation journal belongs to the session, drop it and release its pre-restore snapshot.
4. Delete each released ref only when no binding, journal or archive references it, its name matches `^refs/rewind/[0-9a-f-]{36}$`, its repository is the plugin's own `<dataRoot>/<sha256>/objects.git`, and it still points at the recorded tree.
5. Run `git gc --prune=1.hour.ago` on that repository.

The one-hour grace protects objects another process has just written but not yet referenced. Disk space therefore returns up to an hour after deletion. Child sessions are handled through their own deletion events. Completing an undo, replacing a preview or discarding rewind state releases the journal's pre-restore snapshot the same way.

Data is preserved when safety cannot be established:

- If an inventory read fails, the whole pass stops; tombstones stay pending until the next deletion event or plugin start.
- Refs that are still referenced are marked preserved and retried.
- Containment failures are marked blocked and retried; only malformed ref names or tree ids are refused permanently.

Deletions that happen while the plugin is not running are not detected; their data remains. Nothing expires by age. **Inspect rewind storage** in the command palette reports binding, reclaimed, preserved, pending, blocked and refused counts, the journal state and lifecycle health.

## Rewind workflow

The `/rewind` list contains prompts only. Enter rewinds the selected prompt; Ctrl+D deletes its file snapshot after confirmation; Ctrl+X clears snapshots for the current session after confirmation; Ctrl+Z undoes the staged rewind; and Ctrl+R recovers files only. Deleting snapshots leaves the current files and conversation unchanged; the prompts remain available for conversation-only rewind. Shared and recovery data are preserved while referenced.

1. **Preview.** `prepare` compares the current files with the checkpoint and lists files to create, modify and delete.
2. **Confirm.** After confirmation, `begin` re-checks the files; the TUI then stages a conversation-only revert (`files: false`) on the host.
3. **Apply.** `finish` verifies the matching staged revert and restores the files. The pre-restore snapshot is kept for undo.
4. **Undo.** While the host revert is still staged, undo restores the files (`beginUndo`), the TUI clears the revert, and `finishUndo` completes. Submitting another prompt commits the revert; conversation undo is then unavailable.

A host request that times out has an unknown outcome and is never retried. Recovery is available through Ctrl+R in `/rewind`, with diagnostic commands in the command palette:

- **Inspect recovery** shows the journal phase, the host revert state and the last error.
- **Recover files only** restores files from before an interrupted operation; conflicting files are left unchanged and the conversation is not touched.
- **Discard rewind state** forgets an unresolved rewind without changing files or conversation. Use it when no other action applies.

A new preview also replaces a rewind whose host stage was never observed, and a rewind whose session no longer exists.

The workflow queue serializes operations within one OpenCode process; it is not a lock across processes. Validated against OpenCode 2.2.7 only.

## Tests

- `npm test` runs focused tests with real disposable Git repositories and mocked host and storage APIs.
- `python3 test/e2e-smoke.py --background --mock-model` starts an isolated OpenCode server and TUI with a scripted local model that calls the real subagent and write tools. It checks that an active background child makes the prompt unavailable and that same-file rewind and undo work.
- `python3 test/e2e-smoke.py --deletion --mock-model` checks on a real server that a fork inherits no file checkpoints and that deleting the parent drops its staged journal and deletes every parent-owned ref while keeping the fork's.
- Both end-to-end tests drive the workflow over HTTP rather than through the visual dialogs.
