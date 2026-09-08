import { create } from 'zustand';
import type { DetectionResult } from '../archive/detectors/types';
import type { ArchiveIdentity, ArchivePart, ArchiveSet } from '../archive/schemas/models';
import { archiveSourceRegistry, type ArchiveSourceDescriptor } from '../archive/source-registry';
import { objectUrlCache } from '../media/object-url-cache';

type State = {
  /** UI-safe source metadata. File objects and directory handles live only in the runtime registry. */
  sourceDescriptors: ArchiveSourceDescriptor[];
  fileName?: string;
  fileSize?: number;
  result?: DetectionResult;
  identity?: ArchiveIdentity;
  archiveSet?: ArchiveSet;
  archiveParts: ArchivePart[];
  connectedPartIds: string[];
  imported: boolean;
  storageMode?: 'opfs' | 'indexeddb' | 'memory';
  setArchive: (result: DetectionResult, descriptors: ArchiveSourceDescriptor[], imported?: boolean) => void;
  connectArchive: (result: DetectionResult, descriptors: ArchiveSourceDescriptor[]) => void;
  restoreArchive: (archiveSet: ArchiveSet | undefined, parts: ArchivePart[], identity?: ArchiveIdentity) => void;
  markImported: (mode: 'opfs' | 'indexeddb' | 'memory') => void;
  markImportIncomplete: () => void;
  releaseSources: (partIds?: readonly string[]) => void;
  clear: () => void;
};

const sourceParts = (result: DetectionResult, descriptors: readonly ArchiveSourceDescriptor[]): ArchivePart[] => {
  if (result.parts?.length) return result.parts;
  const identity = result.identity;
  const source = descriptors[0];
  if (!identity || !source) return [];
  return [{ id: `archive-part:${identity.fingerprint}`, archiveId: `archive-set:facebook:${identity.fingerprint}`, partIndex: 0, filename: source.name, fileSize: identity.size, entryCount: identity.entryCount, manifestFingerprint: identity.fingerprint, connected: true, status: 'ready' }];
};

const archiveSetFor = (result: DetectionResult, parts: ArchivePart[], descriptors: readonly ArchiveSourceDescriptor[], status: ArchiveSet['status'] = 'complete'): ArchiveSet | undefined => {
  if (!parts.length) return undefined;
  const fingerprint = result.archiveSetFingerprint ?? parts[0].manifestFingerprint;
  const totalSize = result.totalSize ?? descriptors.reduce((sum, source) => sum + source.size, 0);
  return { id: `archive-set:facebook:${fingerprint}`, platform: 'facebook', createdAt: Date.now(), partCount: parts.length, totalSize, fingerprint, sourceFormat: result.format === 'mixed' ? 'mixed' : result.format === 'html' ? 'html' : result.format === 'json' ? 'json' : undefined, status };
};

const connectedFor = (parts: readonly ArchivePart[]) => parts.filter(part => part.status !== 'failed' && part.status !== 'duplicate' && archiveSourceRegistry.isAvailable(part.id)).map(part => part.id);

export const useArchiveStore = create<State>(set => ({
  sourceDescriptors: [], archiveParts: [], connectedPartIds: [], imported: false,
  setArchive: (result, descriptors, imported = false) => {
    const parts = sourceParts(result, descriptors);
    archiveSourceRegistry.bindParts(parts);
    objectUrlCache.clear();
    set({ sourceDescriptors: [...descriptors], fileName: descriptors.length > 1 ? `${descriptors.length} ZIP parts` : descriptors[0]?.name, fileSize: result.totalSize ?? descriptors.reduce((sum, source) => sum + source.size, 0), result, identity: result.identity, archiveSet: archiveSetFor(result, parts, descriptors), archiveParts: parts, connectedPartIds: connectedFor(parts), imported });
  },
  connectArchive: (result, descriptors) => set(state => {
    const parts = result.parts ?? [];
    archiveSourceRegistry.bindParts(parts);
    const connectedPartIds = [...new Set([...state.connectedPartIds, ...connectedFor(parts)])];
    const archiveParts: ArchivePart[] = (state.archiveParts.length ? state.archiveParts : parts).map(part => connectedPartIds.includes(part.id) ? { ...part, connected: true, status: 'ready' as const } : part);
    return { sourceDescriptors: [...state.sourceDescriptors, ...descriptors.filter(candidate => !state.sourceDescriptors.some(existing => existing.key === candidate.key))], connectedPartIds, result: undefined, identity: result.identity ?? state.identity, archiveSet: state.archiveSet ?? (result.archiveSetFingerprint ? archiveSetFor(result, archiveParts, descriptors, 'incomplete') : undefined), archiveParts };
  }),
  restoreArchive: (archiveSet, archiveParts, identity) => set({ archiveSet, archiveParts, identity, result: undefined, sourceDescriptors: [], fileName: undefined, fileSize: undefined, imported: archiveSet?.status === 'complete', connectedPartIds: [] }),
  markImported: storageMode => set({ imported: true, storageMode }),
  markImportIncomplete: () => set({ imported: false }),
  releaseSources: partIds => { archiveSourceRegistry.releaseAll(partIds); set(state => ({ connectedPartIds: state.connectedPartIds.filter(id => archiveSourceRegistry.isAvailable(id)) })); },
  clear: () => { objectUrlCache.clear(); archiveSourceRegistry.clear(); set({ sourceDescriptors: [], fileName: undefined, fileSize: undefined, result: undefined, identity: undefined, archiveSet: undefined, archiveParts: [], connectedPartIds: [], imported: false, storageMode: undefined }); },
}));
