import type{NormalizedArchiveData}from'../archive/schemas/models';
import type{ImportState}from'./types';
const DB='socialvault-fallback',STORE='archives',META='metadata',KEY='current',STATE_KEY='import-state';
const SNAPSHOT_CHUNK_SIZE = 16 * 1024 * 1024;
type FallbackState={data?:NormalizedArchiveData;importState?:ImportState};
function open(){return new Promise<IDBDatabase>((resolve,reject)=>{const req=indexedDB.open(DB,2);req.onupgradeneeded=()=>{const database=req.result;if(!database.objectStoreNames.contains(STORE))database.createObjectStore(STORE);if(!database.objectStoreNames.contains(META))database.createObjectStore(META);};req.onerror=()=>reject(req.error);req.onsuccess=()=>resolve(req.result)})}
const request = <T = unknown>(store: IDBObjectStore, key: IDBValidKey) => new Promise<T | undefined>((resolve, reject) => { const get = store.get(key); get.onsuccess = () => resolve(get.result as T | undefined); get.onerror = () => reject(get.error); });
const transaction = (database: IDBDatabase, storeName: string, mode: IDBTransactionMode, work: (store: IDBObjectStore) => void) => new Promise<void>((resolve, reject) => { const tx = database.transaction(storeName, mode); work(tx.objectStore(storeName)); tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error); });
type ChunkedSnapshot = { format: 'sqlite-wasm-chunked'; generation: string; byteLength: number; chunkSize: number; chunkCount: number };
const isSnapshotRecord = (value: unknown): value is { format: string } => !!value && typeof value === 'object' && typeof (value as { format?: unknown }).format === 'string' && (value as { format: string }).format.startsWith('sqlite-wasm');
const chunkKey = (generation: string, index: number) => `${KEY}:snapshot:${generation}:${index}`;
const isChunkedSnapshot = (value: unknown): value is ChunkedSnapshot => isSnapshotRecord(value) && value.format === 'sqlite-wasm-chunked' && typeof (value as ChunkedSnapshot).generation === 'string' && Number.isFinite((value as ChunkedSnapshot).chunkCount) && Number.isFinite((value as ChunkedSnapshot).chunkSize) && Number.isFinite((value as ChunkedSnapshot).byteLength);

export function putFallback(data?:NormalizedArchiveData){return open().then(database=>request<unknown>(database.transaction(STORE,'readonly').objectStore(STORE),KEY).then(previous=>transaction(database,STORE,'readwrite',store=>{if(data)store.put(data,KEY);else store.delete(KEY);if((previous as ChunkedSnapshot|undefined)?.format==='sqlite-wasm-chunked'){for(let index=0;index<(previous as ChunkedSnapshot).chunkCount;index++)store.delete(chunkKey((previous as ChunkedSnapshot).generation,index));}}).finally(()=>database.close())))}
export function getFallback(){return open().then(database=>request<unknown>(database.transaction(STORE,'readonly').objectStore(STORE),KEY).then(value=>{database.close();return isSnapshotRecord(value)?undefined:value as NormalizedArchiveData|undefined}).catch(error=>{database.close();throw error}))}
/** Store the SQLite file itself instead of cloning every normalized record.
 * Uint8Array is structured-cloned by IndexedDB and keeps the fallback path
 * bounded to one database snapshot rather than two in-memory copies of the
 * archive. The legacy normalized-object helpers above remain for migration. */
export async function putFallbackSnapshot(bytes?:Uint8Array){
  const database = await open();
  try {
    const previous = await request<unknown>(database.transaction(STORE,'readonly').objectStore(STORE),KEY);
    const prior = previous as ChunkedSnapshot | undefined;
    if (!bytes) {
      await transaction(database,STORE,'readwrite',store=>{ store.delete(KEY); if (prior?.format === 'sqlite-wasm-chunked') for (let index=0; index<prior.chunkCount; index++) store.delete(chunkKey(prior.generation,index)); });
      return;
    }
    // Write chunks under a private generation first. The public metadata key
    // is switched only after every bounded chunk transaction has committed, so
    // a reload during a snapshot write can still use the previous snapshot.
    const generation = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const chunkCount = Math.ceil(bytes.byteLength / SNAPSHOT_CHUNK_SIZE);
    const writtenChunks: string[] = [];
    try {
      for (let index = 0; index < chunkCount; index++) {
        const start = index * SNAPSHOT_CHUNK_SIZE;
        const chunk = bytes.slice(start, Math.min(bytes.byteLength, start + SNAPSHOT_CHUNK_SIZE));
        await transaction(database,STORE,'readwrite',store=>store.put(chunk,chunkKey(generation,index)));
        writtenChunks.push(chunkKey(generation,index));
      }
      const record: ChunkedSnapshot = { format:'sqlite-wasm-chunked', generation, byteLength:bytes.byteLength, chunkSize:SNAPSHOT_CHUNK_SIZE, chunkCount };
      await transaction(database,STORE,'readwrite',store=>store.put(record,KEY));
    } catch (error) {
      // A quota failure during a later chunk must not leave a half-written
      // generation consuming the remaining fallback storage.
      if (writtenChunks.length) { try { await transaction(database,STORE,'readwrite',store=>writtenChunks.forEach(key=>store.delete(key))); } catch { /* preserve the original quota error */ } }
      throw error;
    }
    if (prior?.format === 'sqlite-wasm-chunked' && prior.generation !== generation) {
      await transaction(database,STORE,'readwrite',store=>{ for (let index=0; index<prior.chunkCount; index++) store.delete(chunkKey(prior.generation,index)); });
    }
  } finally { database.close(); }
}
export async function getFallbackSnapshot(){
  const database = await open();
  try {
    const value = await request<unknown>(database.transaction(STORE,'readonly').objectStore(STORE),KEY);
    const record = value as {format?:string;bytes?:Uint8Array|ArrayBuffer}|ChunkedSnapshot|undefined;
    if (record?.format === 'sqlite-wasm') {
      return record.bytes instanceof Uint8Array ? record.bytes : record.bytes instanceof ArrayBuffer ? new Uint8Array(record.bytes) : undefined;
    }
    if (!isChunkedSnapshot(record)) return undefined;
    const snapshot = new Uint8Array(record.byteLength);
    for (let index=0; index<record.chunkCount; index++) {
      const chunk = await request<Uint8Array|ArrayBuffer>(database.transaction(STORE,'readonly').objectStore(STORE),chunkKey(record.generation,index));
      if (!chunk) return undefined;
      const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
      snapshot.set(bytes,index * record.chunkSize);
    }
    return snapshot;
  } finally { database.close(); }
}
export function putFallbackImportState(importState:ImportState){return open().then(database=>new Promise<void>((resolve,reject)=>{const tx=database.transaction(META,'readwrite');tx.objectStore(META).put(importState,STATE_KEY);tx.oncomplete=()=>{database.close();resolve()};tx.onerror=()=>{database.close();reject(tx.error)}}))}
export function getFallbackImportState(){return open().then(database=>new Promise<ImportState|undefined>((resolve,reject)=>{const tx=database.transaction(META,'readonly'),get=tx.objectStore(META).get(STATE_KEY);get.onsuccess=()=>{database.close();resolve(get.result as ImportState|undefined)};get.onerror=()=>{database.close();reject(get.error)}}))}
export function clearFallbackImportState(){return open().then(database=>new Promise<void>((resolve,reject)=>{const tx=database.transaction(META,'readwrite');tx.objectStore(META).delete(STATE_KEY);tx.oncomplete=()=>{database.close();resolve()};tx.onerror=()=>{database.close();reject(tx.error)}}))}
