import { importMeter } from '../archive/import-metrics';

/** One database owner per origin. A second tab must never silently open a
 * different, empty fallback database when the persisted database is locked. */
export async function acquireDatabaseLock() {
  if (!navigator.locks) return;
  await new Promise<void>((resolve, reject) => {
    void navigator.locks.request('socialvault-database', { ifAvailable: true }, async lock => {
      if (!lock) { reject(new Error('SocialVault is already open in another tab. Close that tab and reload to use the saved archive.')); return; }
      resolve();
      await new Promise(() => {}); // Released automatically when this worker ends.
    }).catch(reject);
  });
}

/** SAH pool avoids proxy-worker round trips for every SQLite page operation.
 * A legacy database is copied in bounded stream chunks, never exported as one
 * full-database ArrayBuffer. The old file is retained as a recovery copy;
 * subsequent starts use the pool database. */
export async function openPooledDatabase(sqlite: any) {
  if (!sqlite.installOpfsSAHPoolVfs || !navigator.storage?.getDirectory) return undefined;
  const root = await navigator.storage.getDirectory();
  const existingPool = await root.getDirectoryHandle('socialvault-sahpool').then(() => true, () => false);
  let pool;
  try { pool = await sqlite.installOpfsSAHPoolVfs({ name: 'socialvault-sahpool', directory: '/socialvault-sahpool', initialCapacity: 6 }); }
  catch (error) { if (existingPool) throw new Error('The saved OPFS database could not be opened. Close other SocialVault tabs and reload; no alternate database was opened.'); return undefined; }
  const name = '/socialvault.sqlite3';
  if (!pool.getFileNames().includes(name)) {
    const legacy = await root.getFileHandle('socialvault.sqlite3').catch(() => undefined);
    if (legacy) {
      const stream = (await legacy.getFile()).stream().getReader();
      const started = performance.now(); let bytes = 0;
      try { await pool.importDb(name, async () => { const chunk = await stream.read(); if (chunk.done) return undefined; bytes += chunk.value.byteLength; return chunk.value; }); }
      finally { stream.releaseLock(); }
      importMeter.add('legacy-storage-migration', performance.now() - started, 0, bytes);
    }
  }
  return new pool.OpfsSAHPoolDb(name);
}
