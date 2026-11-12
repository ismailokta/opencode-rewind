// Shared test helpers: in-memory plugin storage and a disposable Git project.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { capture } from '../src/snapshot.js';

export function memoryStorage(map = new Map(), faults = {}) {
  return {
    map,
    get: async k => map.has(k) ? structuredClone(map.get(k)) : undefined,
    set: async (k, v) => { if (faults.set?.(k, v)) throw new Error('injected storage failure'); map.set(k, structuredClone(v)); },
    remove: async k => { if (faults.remove?.(k)) throw new Error('injected storage failure'); map.delete(k); },
    scan: async ({ prefix, after }) => {
      if (faults.scan?.(prefix)) throw new Error('injected scan failure');
      // Paginate one entry at a time to exercise cursor handling.
      const items = [...map].filter(([k]) => k.startsWith(prefix)).sort(([a], [b]) => a.localeCompare(b));
      const start = after ? items.findIndex(([k]) => k === after) + 1 : 0, page = items.slice(start, start + 1);
      return { entries: page.map(([key, value]) => ({ key, value: structuredClone(value) })), ...(start + 1 < items.length ? { next: page[0][0] } : {}) };
    }
  };
}

// A Git project at <base>/project with snapshot storage at <base>/data.
export async function project(t, name = 'rewind-') {
  const base = await mkdtemp(path.join(tmpdir(), name)); t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'project'), data = path.join(base, 'data'); await mkdir(root);
  execFileSync('git', ['init', '-q'], { cwd: root });
  const snapshot = (dir, opts) => capture(dir, { ...opts, dataRoot: data });
  const write = (file, content) => writeFile(path.join(root, file), content);
  return { base, root, data, snapshot, write };
}

export const gitOut = (repo, ...args) => execFileSync('git', ['--git-dir', repo, ...args], { encoding: 'utf8' });
export const refs = repo => gitOut(repo, 'for-each-ref', '--format=%(refname)', 'refs/rewind/').split('\n').filter(Boolean).sort();
export const hasObject = (repo, oid) => spawnSync('git', ['--git-dir', repo, 'cat-file', '-e', oid]).status === 0;
export const blob = text => execFileSync('git', ['hash-object', '--stdin'], { input: text, encoding: 'utf8' }).trim();
