import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, realpath, rm } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';

const cleanEnv = () => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
  return { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' };
};
export function git(args, { cwd, input, env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, env: { ...cleanEnv(), ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    const out = [], err = []; child.stdout.on('data', x => out.push(x)); child.stderr.on('data', x => err.push(x));
    child.on('error', reject); child.on('close', code => code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`git failed (${code}): ${Buffer.concat(err).toString().trim()}`)));
    child.stdin.on('error', () => {}); child.stdin.end(input);
  });
}
function splitZero(buf) {
  if (buf.length && buf[buf.length - 1] !== 0) throw new Error('invalid Git output');
  const text = buf.toString('utf8');
  if (!Buffer.from(text).equals(buf)) throw new Error('non-UTF-8 path is unsupported');
  return text.split('\0').filter(Boolean);
}
export function within(parent, child) {
  const rel = path.relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel));
}
// A worktree-relative path with no empty, `.`, `..` or `.git` component.
export const safeRelative = name => typeof name === 'string' && !path.isAbsolute(name) && name.split('/').every(x => x && x !== '.' && x !== '..' && x !== '.git');
// Opens an existing regular file without following a final symlink; null when absent.
export async function openRegular(file) {
  if (typeof constants.O_NOFOLLOW !== 'number') throw new Error('O_NOFOLLOW unavailable; file access refused');
  let handle;
  try { handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_NONBLOCK || 0)); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  const stat = await handle.stat();
  if (!stat.isFile()) { await handle.close(); throw new Error(`not a regular file: ${file}`); }
  return { handle, stat };
}
// Resolve an as-yet nonexistent storage path without creating anything in the worktree.
async function canonicalDestination(destination) {
  let cursor = path.resolve(destination); const rest = [];
  for (;;) {
    try { return path.join(await realpath(cursor), ...rest.reverse()); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) throw error;
      rest.push(path.basename(cursor)); cursor = parent;
    }
  }
}
async function rejectActiveSymlinks(directory, worktree) {
  let cursor = path.resolve(directory);
  for (;;) {
    if ((await lstat(cursor)).isSymbolicLink()) throw new Error('symlinked active directory is unsupported');
    if (await realpath(cursor) === worktree) return;
    const parent = path.dirname(cursor);
    if (parent === cursor) throw new Error('active directory is not a direct worktree path');
    cursor = parent;
  }
}
export const defaultDataRoot = () => path.join(process.env.XDG_DATA_HOME || path.join(homedir(), '.local', 'share'), 'opencode', 'rewind');
// Captures the active directory into <dataRoot>/<sha256(root)>/objects.git without touching the
// project's Git metadata. `ref: false` is for comparison-only captures: their objects stay
// unreferenced and are pruned by the grace-period GC instead of leaking an ownerless ref.
export async function capture(directory, { ref: keepRef = true, dataRoot = defaultDataRoot() } = {}) {
  const root = await realpath(directory);
  const topOutput = await git(['rev-parse', '--show-toplevel'], { cwd: root });
  if (!topOutput.length || topOutput[topOutput.length - 1] !== 10) throw new Error('invalid Git worktree path');
  const topBytes = topOutput.subarray(0, -1), top = topBytes.toString('utf8');
  if (!Buffer.from(top).equals(topBytes)) throw new Error('non-UTF-8 worktree path is unsupported');
  const worktree = await realpath(top);
  if (!within(worktree, root)) throw new Error('active directory is outside the Git worktree');
  await rejectActiveSymlinks(directory, worktree);
  // Git emits paths relative to cwd and applies ignore rules from the whole worktree.
  // An explicit cwd-relative pathspec keeps both indexed and untracked results scoped.
  const stages = splitZero(await git(['ls-files', '--stage', '-z', '--', '.'], { cwd: root }));
  if (stages.some(x => !/^100(644|755) [0-9a-f]+ 0\t/.test(x))) throw new Error('symlinks, submodules, and unmerged entries are unsupported');
  const files = splitZero(await git(['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', '.'], { cwd: root }));
  if (within(worktree, await canonicalDestination(dataRoot))) throw new Error('snapshot storage must be outside the worktree');
  const store = path.join(dataRoot, createHash('sha256').update(root).digest('hex'));
  await mkdir(store, { recursive: true, mode: 0o700 });
  if (within(worktree, await realpath(store))) throw new Error('snapshot storage must be outside the worktree');
  const repo = path.join(store, 'objects.git');
  await git(['init', '--bare', '--quiet', repo]);
  const temp = await mkdtemp(path.join(tmpdir(), 'opencode-rewind-index-'));
  const env = { GIT_INDEX_FILE: path.join(temp, 'index') };
  const repoArgs = ['--git-dir', repo, '--work-tree', root];
  try {
    await git([...repoArgs, 'read-tree', '--empty'], { env });
    const records = [];
    for (const name of new Set(files)) {
      if (!safeRelative(name)) throw new Error(`unsafe path: ${name}`);
      const full = path.join(root, name);
      const opened = await openRegular(full);
      if (!opened) continue;
      try {
        // Reject symlinked ancestors as well as the final component.
        if (await realpath(full) !== full) throw new Error(`symlinked path unsupported: ${name}`);
        const object = (await git([...repoArgs, 'hash-object', '-w', '--stdin'], { input: await opened.handle.readFile(), env })).toString().trim();
        records.push(Buffer.from(`${opened.stat.mode & 0o111 ? '100755' : '100644'} ${object}\t${name}\0`));
      } finally { await opened.handle.close(); }
    }
    if (records.length) await git([...repoArgs, 'update-index', '-z', '--index-info'], { input: Buffer.concat(records), env });
    const tree = (await git([...repoArgs, 'write-tree'], { env })).toString().trim();
    if (!keepRef) return { root, repo, ref: null, tree };
    const ref = `refs/rewind/${randomUUID()}`;
    await git([...repoArgs, 'update-ref', ref, tree], { env });
    return { root, repo, ref, tree };
  } finally { await rm(temp, { recursive: true, force: true }); }
}
