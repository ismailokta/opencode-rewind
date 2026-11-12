import { randomUUID, createHash } from 'node:crypto';
import { lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { git, openRegular, safeRelative } from './snapshot.js';

export async function readTree(snapshot) {
  const result = await git(['--git-dir', snapshot.repo, 'ls-tree', '-rz', '--full-tree', snapshot.tree]);
  const text = result.toString('utf8');
  if (!Buffer.from(text).equals(result)) throw new Error('invalid tree path encoding');
  const entries = new Map();
  for (const item of text.split('\0').filter(Boolean)) {
    const match = /^(100644|100755) blob ([0-9a-f]+)\t([\s\S]+)$/.exec(item);
    if (!match) throw new Error('unsupported tree entry');
    if (!safeRelative(match[3])) throw new Error('unsafe tree path');
    entries.set(match[3], { mode: match[1], oid: match[2] });
  }
  return entries;
}
// Two file states (null = absent) are the same when mode and blob id match.
export const sameEntry = (a, b) => (!a && !b) || (!!a && !!b && a.mode === b.mode && a.oid === b.oid);
export async function preview(from, to) {
  if (from.root !== to.root) throw new Error('snapshot roots differ');
  const a = await readTree(from), b = await readTree(to);
  return [...new Set([...a.keys(), ...b.keys()])].sort().filter(n => !sameEntry(a.get(n), b.get(n))).map(name => ({ name, action: !a.has(name) ? 'create' : !b.has(name) ? 'delete' : 'modify' }));
}
// Absolute path for `name` under `root`, refusing symlinked or non-directory parents.
export async function restorePath(root, name, create) {
  if (!path.isAbsolute(root) || !safeRelative(name)) throw new Error('unsafe restore path');
  const parts = name.split('/'); let dir = root;
  for (const part of parts.slice(0, -1)) {
    dir = path.join(dir, part);
    try { const st = await lstat(dir); if (!st.isDirectory() || st.isSymbolicLink()) throw new Error(`unsafe parent: ${name}`); }
    catch (error) { if (error.code !== 'ENOENT' || !create) throw error; await mkdir(dir); }
  }
  if (await realpath(dir) !== dir) throw new Error(`symlink parent: ${name}`);
  return path.join(dir, parts.at(-1));
}
// Current mode and Git blob id of a regular file, or null when absent.
export async function fingerprint(file) {
  const opened = await openRegular(file);
  if (!opened) return null;
  try {
    const data = await opened.handle.readFile();
    return { mode: opened.stat.mode & 0o111 ? '100755' : '100644', oid: createHash('sha1').update(`blob ${data.length}\0`).update(data).digest('hex') };
  } finally { await opened.handle.close(); }
}
// Moves one file from `expected` to `desired` (either may be null = absent). The file is checked
// against `expected` before and again just before replacement; any mismatch fails without writing.
// These checks are best-effort, not atomic with the final rename or unlink.
export async function applyOne(root, name, expected, desired, repo) {
  const file = await restorePath(root, name, !!desired);
  if (!sameEntry(await fingerprint(file), expected)) throw new Error(`file changed or unsupported collision: ${name}`);
  if (!desired) { await unlink(file); return; }
  const data = await git(['--git-dir', repo, 'cat-file', 'blob', desired.oid]);
  const tmp = path.join(path.dirname(file), `.rewind-${randomUUID()}`);
  let handle;
  try {
    handle = await open(tmp, 'wx', desired.mode === '100755' ? 0o755 : 0o644);
    await handle.writeFile(data); await handle.chmod(desired.mode === '100755' ? 0o755 : 0o644); await handle.sync(); await handle.close(); handle = null;
    if (!sameEntry(await fingerprint(file), expected)) throw new Error(`file changed during restore: ${name}`);
    await rename(tmp, file);
  } finally { if (handle) await handle.close(); await unlink(tmp).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}
// Applies every difference from `from` to `to`, recording the file in progress in the journal.
export async function applyChanges(journal, j, from, to) {
  const a = await readTree(from), b = await readTree(to);
  for (const { name } of await preview(from, to)) {
    j.current = name; await journal.set(j);
    await applyOne(from.root, name, a.get(name), b.get(name), to.repo);
  }
  delete j.current; await journal.set(j);
}
