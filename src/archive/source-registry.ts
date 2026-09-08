import { cleanArchivePath } from './archive-set';
import type { ArchivePart } from './schemas/models';

/**
 * Runtime-only source references. The registry deliberately lives outside
 * React/Zustand state: UI state keeps filenames, sizes, and part IDs while
 * this module owns at most the File/handle needed for the current operation.
 */
export interface ArchiveFileHandle {
  readonly kind: 'file';
  readonly name: string;
  getFile(): Promise<File>;
}

export interface ArchiveSourceInput {
  readonly name: string;
  readonly size?: number;
  readonly lastModified?: number;
  readonly relativePath?: string;
  readonly file?: File;
  readonly handle?: ArchiveFileHandle;
}

export interface ArchiveSourceDescriptor {
  readonly key: string;
  readonly name: string;
  readonly size: number;
  readonly lastModified?: number;
  readonly relativePath?: string;
}

type SourceRecord = {
  key: string;
  name: string;
  size: number;
  lastModified?: number;
  relativePath?: string;
  file?: File;
  handle?: ArchiveFileHandle;
  partId?: string;
  state: 'connected' | 'processing' | 'processed' | 'released' | 'reconnect-required';
};

const fileKey = (file: File) => `file:${file.name}:${file.size}:${file.lastModified}`;
const sourcePath = (value: string) => cleanArchivePath(value).toLowerCase();
const lookupKeys = (path: string) => {
  const segments = path.split('/');
  const keys = new Set([path]);
  for (const count of [1, 2, 3]) if (segments.length >= count) keys.add(segments.slice(-count).join('/'));
  return keys;
};

class ArchiveSourceRegistry {
  private sources = new Map<string, SourceRecord>();
  private partToSource = new Map<string, string>();
  private manifests = new Map<string, Set<string>>();
  private pathOwners = new Map<string, Set<string>>();

  registerFiles(files: readonly File[]) {
    const descriptors: ArchiveSourceDescriptor[] = [];
    files.forEach(file => {
      const key = fileKey(file);
      const record: SourceRecord = { key, name: file.name, size: file.size, lastModified: file.lastModified, file, state: 'connected' };
      this.sources.set(key, record);
      descriptors.push(this.descriptor(record));
    });
    return descriptors;
  }

  registerHandles(inputs: readonly ArchiveSourceInput[]) {
    const descriptors: ArchiveSourceDescriptor[] = [];
    inputs.forEach(input => {
      const key = `handle:${input.relativePath ?? input.name}:${input.size ?? 0}:${input.lastModified ?? 0}`;
      const record: SourceRecord = { key, name: input.name, size: input.size ?? 0, lastModified: input.lastModified, relativePath: input.relativePath, handle: input.handle, file: input.file, state: 'connected' };
      this.sources.set(key, record);
      descriptors.push(this.descriptor(record));
    });
    return descriptors;
  }

  /** Match inspected part IDs to the one runtime source reference for each part. */
  bindParts(parts: readonly ArchivePart[]) {
    const used = new Set<string>();
    for (const part of parts) {
      const previous = this.partToSource.get(part.id);
      if (previous && this.sources.get(previous)?.partId === part.id && this.isAvailable(part.id)) { used.add(previous); continue; }
      const candidate = [...this.sources.values()].find(source => {
        if (used.has(source.key)) return false;
        if (source.name !== part.filename) return false;
        return source.size === 0 || source.size === part.fileSize;
      });
      if (!candidate) continue;
      candidate.partId = part.id;
      candidate.state = 'connected';
      this.partToSource.set(part.id, candidate.key);
      used.add(candidate.key);
    }
  }

  descriptorForPart(partId: string) {
    const key = this.partToSource.get(partId);
    const source = key ? this.sources.get(key) : undefined;
    return source ? this.descriptor(source) : undefined;
  }

  descriptors() { return [...this.sources.values()].map(source => this.descriptor(source)); }

  async materializeKey(key: string) {
    const source = this.sources.get(key);
    if (!source) return undefined;
    source.state = 'processing';
    if (!source.file && source.handle) {
      source.file = await source.handle.getFile();
      source.size = source.file.size;
      source.lastModified = source.file.lastModified;
    }
    if (!source.file) { source.state = 'reconnect-required'; return undefined; }
    return source.file;
  }

  hasHandle(key: string) { return !!this.sources.get(key)?.handle; }

  bindPartForKey(key: string, partId: string) {
    const source = this.sources.get(key);
    if (!source) return;
    source.partId = partId;
    source.state = source.file ? 'connected' : 'reconnect-required';
    this.partToSource.set(partId, key);
  }

  registerManifest(partId: string, paths: readonly string[]) {
    const previous = this.manifests.get(partId);
    if (previous) for (const suffix of previous) {
      const owners = this.pathOwners.get(suffix);
      owners?.delete(partId);
      if (!owners?.size) this.pathOwners.delete(suffix);
    }
    const manifest = new Set<string>();
    for (const path of new Set(paths.map(sourcePath).filter(Boolean))) {
      for (const suffix of lookupKeys(path)) {
        manifest.add(suffix);
        const owners = this.pathOwners.get(suffix) ?? new Set<string>();
        owners.add(partId); this.pathOwners.set(suffix, owners);
      }
    }
    this.manifests.set(partId, manifest);
  }

  resolvePart(path: string) {
    const wanted = sourcePath(path);
    if (!wanted) return undefined;
    const owners = this.pathOwners.get(wanted);
    return owners?.size === 1 ? owners.values().next().value : undefined;
  }

  async materialize(partId: string) {
    const key = this.partToSource.get(partId);
    const source = key ? this.sources.get(key) : undefined;
    if (!source) return undefined;
    return this.materializeKey(source.key);
  }

  markProcessed(partId: string) {
    const source = this.sourceForPart(partId);
    if (source) source.state = source.file ? 'processed' : source.handle ? 'connected' : 'reconnect-required';
  }

  release(partId: string) {
    const source = this.sourceForPart(partId);
    if (!source) return;
    source.file = undefined;
    source.state = source.handle ? 'connected' : 'released';
  }

  releaseKey(key: string) {
    const source = this.sources.get(key);
    if (!source) return;
    source.file = undefined;
    source.state = source.handle ? 'connected' : 'released';
  }

  releaseAll(partIds?: readonly string[]) {
    const selected = partIds ? new Set(partIds) : undefined;
    for (const source of this.sources.values()) if (!selected || (source.partId && selected.has(source.partId))) {
      source.file = undefined;
      source.state = source.handle ? 'connected' : 'released';
    }
  }

  stateForPart(partId: string) { return this.sourceForPart(partId)?.state ?? 'reconnect-required'; }

  isAvailable(partId: string) {
    const source = this.sourceForPart(partId);
    return !!source?.file || !!source?.handle;
  }

  clear() {
    this.sources.clear();
    this.partToSource.clear();
    this.manifests.clear();
    this.pathOwners.clear();
  }

  private sourceForPart(partId: string) {
    const key = this.partToSource.get(partId);
    return key ? this.sources.get(key) : undefined;
  }

  private descriptor(source: SourceRecord): ArchiveSourceDescriptor {
    return { key: source.key, name: source.name, size: source.size, lastModified: source.lastModified, relativePath: source.relativePath };
  }
}

export const archiveSourceRegistry = new ArchiveSourceRegistry();
