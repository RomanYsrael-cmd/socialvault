import { mediaClient } from './client';

type Entry = { key: string; url?: string; pending?: Promise<string>; refs: number; touched: number };
const MAX_ENTRIES = 12;
class ObjectUrlCache {
  private entries = new Map<string, Entry>();
  private clock = 0;
  async acquire(file: File, path: string, mimeType?: string) {
    const key = `${file.name}:${file.size}:${file.lastModified}:${path}`;
    let entry = this.entries.get(key);
    if (!entry) { entry = { key, refs: 0, touched: ++this.clock }; this.entries.set(key, entry); }
    entry.refs++; entry.touched = ++this.clock;
    if (!entry.url) {
      entry.pending ??= mediaClient.extract(file, path, mimeType).then(blob => { const url = URL.createObjectURL(blob); if (this.entries.get(key) !== entry) { URL.revokeObjectURL(url); throw new Error('Media cache was cleared.'); } entry!.url = url; entry!.pending = undefined; this.evict(); return url; }).catch(error => { entry!.pending = undefined; throw error; });
      try { return await entry.pending; } catch (error) { this.release(key); throw error; }
    }
    return entry.url;
  }
  releaseKey(file: File, path: string) { this.release(`${file.name}:${file.size}:${file.lastModified}:${path}`); }
  private release(key: string) { const entry = this.entries.get(key); if (!entry) return; entry.refs = Math.max(0, entry.refs - 1); entry.touched = ++this.clock; this.evict(); }
  private evict() {
    while (this.entries.size > MAX_ENTRIES) {
      const candidate = [...this.entries.values()].filter(entry => entry.refs === 0).sort((a, b) => a.touched - b.touched)[0];
      if (!candidate) break;
      if (candidate.url) URL.revokeObjectURL(candidate.url);
      this.entries.delete(candidate.key);
    }
  }
  clear() { for (const entry of this.entries.values()) if (entry.url) URL.revokeObjectURL(entry.url); this.entries.clear(); }
}
export const objectUrlCache = new ObjectUrlCache();
