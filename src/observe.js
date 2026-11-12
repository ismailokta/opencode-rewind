// Read-only TUI observation of a session and all its descendants; incomplete or
// inconsistent results are 'unknown'.
async function activeMap(client) {
  const map = await client.session.active();
  return map && typeof map === 'object' && !Array.isArray(map) ? map : null;
}
export async function observeFamily(client, sessionID) {
  try {
    const before = await activeMap(client);
    if (!before) return 'unknown';
    const family = [sessionID], seen = new Set(family);
    for (let i = 0; i < family.length; i++) {
      if (family.length > 10000) return 'unknown';
      let cursor; const cursors = new Set();
      do {
        const page = await client.session.list(cursor ? { cursor } : { parentID: family[i] });
        if (!Array.isArray(page?.data) || !page.cursor || typeof page.cursor !== 'object') return 'unknown';
        for (const child of page.data) {
          if (typeof child?.id !== 'string') return 'unknown';
          if (!seen.has(child.id)) { seen.add(child.id); family.push(child.id); }
        }
        cursor = page.cursor.next;
        if (cursor && (typeof cursor !== 'string' || cursors.has(cursor))) return 'unknown';
        if (cursor) cursors.add(cursor);
      } while (cursor);
    }
    const after = await activeMap(client);
    if (!after) return 'unknown';
    return family.some(id => before[id] || after[id]) ? 'active' : 'idle';
  } catch { return 'unknown'; }
}
