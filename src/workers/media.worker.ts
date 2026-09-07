/// <reference lib="webworker" />
import { BlobReader, BlobWriter, ZipReader } from '@zip.js/zip.js';
import { isSuspiciousPath } from '../archive/security';

type Request = { id: number; file: File; path: string; mimeType?: string; archivePartId?: string };
type Response = { id: number; ok: true; blob: Blob } | { id: number; ok: false; error: string };
const clean = (path: string) => path.replaceAll('\\', '/').replace(/^\.\//, '').replace(/^\//, '');
const allowed = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'video/mp4', 'video/webm', 'audio/mpeg', 'audio/mp4', 'audio/wav', 'audio/ogg', 'audio/webm']);
const fallbackMime = (path: string) => {
  const ext = path.toLowerCase().split('.').pop();
  return ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : ext === 'gif' ? 'image/gif' : ext === 'mp4' || ext === 'm4v' ? 'video/mp4' : ext === 'webm' ? 'video/webm' : ext === 'mp3' ? 'audio/mpeg' : ext === 'wav' ? 'audio/wav' : ext === 'ogg' ? 'audio/ogg' : 'application/octet-stream';
};
self.onmessage = async (event: MessageEvent<Request>) => {
  const { id, file, path, archivePartId } = event.data;
  let reader: ZipReader<Blob> | undefined;
  try {
    const rawPath = path.replaceAll('\\', '/');
    if (!rawPath || isSuspiciousPath(rawPath)) throw new Error('This media path is not safe to open.');
    const requested = clean(rawPath);
    reader = new ZipReader(new BlobReader(file));
    // Media work is demand-driven. The worker receives only the connected ZIP
    // needed for this preview; it never registers or opens the archive set.
    let entries = await reader.getEntries();
    const entry = entries.find(candidate => !candidate.directory && clean(candidate.filename) === requested) ?? entries.find(candidate => !candidate.directory && clean(candidate.filename).endsWith(`/${requested}`));
    if (!entry) throw new Error(`Media entry is not present in the connected archive${archivePartId ? ` part (${archivePartId})` : ''}.`);
    const mime = (event.data.mimeType && allowed.has(event.data.mimeType.toLowerCase()) ? event.data.mimeType.toLowerCase() : fallbackMime(requested));
    if (!allowed.has(mime)) throw new Error('This file type cannot be previewed safely.');
    const fileEntry = entry as unknown as { getData: (writer: BlobWriter) => Promise<Blob> };
    const blob = await fileEntry.getData(new BlobWriter(mime));
    entries = [];
    postMessage({ id, ok: true, blob } satisfies Response);
  } catch (error) { postMessage({ id, ok: false, error: error instanceof Error ? error.message : String(error) } satisfies Response); }
  finally { await reader?.close().catch(() => {}); }
};
