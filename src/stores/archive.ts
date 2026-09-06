import { create } from 'zustand';
import type { DetectionResult } from '../archive/detectors/types';
import type { ArchiveIdentity, ArchivePart, ArchiveSet } from '../archive/schemas/models';
import { objectUrlCache } from '../media/object-url-cache';

type FileRegistry = Record<string, File>;
type State = {
  /** First file is kept for older callers; media uses filesByPart. */
  file?: File;
  filesByPart: FileRegistry;
  fileName?: string;
  fileSize?: number;
  result?: DetectionResult;
  identity?: ArchiveIdentity;
  archiveSet?: ArchiveSet;
  archiveParts: ArchivePart[];
  connectedPartIds: string[];
  imported: boolean;
  storageMode?: 'opfs' | 'indexeddb';
  setArchive: (files: File | File[], result: DetectionResult, imported?: boolean) => void;
  connectArchive: (files: File[], result: DetectionResult) => void;
  restoreArchive: (archiveSet: ArchiveSet | undefined, parts: ArchivePart[], identity?: ArchiveIdentity) => void;
  markImported: (mode: 'opfs' | 'indexeddb') => void;
  clear: () => void;
};

const asFiles = (files: File | File[]) => Array.isArray(files) ? files : [files];
function partsFor(result: DetectionResult, files: File[]): ArchivePart[] {
  if (result.parts?.length) return result.parts;
  const identity = result.identity;
  if (!identity || !files[0]) return [];
  return [{ id: `archive-part:${identity.fingerprint}`, archiveId: `archive-set:facebook:${identity.fingerprint}`, partIndex: 0, filename: files[0].name, fileSize: files[0].size, entryCount: identity.entryCount, manifestFingerprint: identity.fingerprint, connected: true, status: 'ready' }];
}
function registry(parts: ArchivePart[], files: File[]): FileRegistry {
  const used = new Set<number>(); const entries: Array<[string, File]> = [];
  parts.forEach((part, index) => {
    const match = files.findIndex((file, fileIndex) => !used.has(fileIndex) && file.name === part.filename && file.size === part.fileSize);
    const fileIndex = match >= 0 ? match : files.findIndex((_, fileIndex) => !used.has(fileIndex));
    if (fileIndex >= 0) { used.add(fileIndex); entries.push([part.id, files[fileIndex]]); }
  });
  return Object.fromEntries(entries);
}

export const useArchiveStore = create<State>(set => ({
  filesByPart: {}, archiveParts: [], connectedPartIds: [], imported: false,
  setArchive: (input, result, imported = false) => {
    const files = asFiles(input); const parts = partsFor(result, files); const filesByPart = registry(parts, files);
    objectUrlCache.clear(); set({ file: files[0], filesByPart, fileName: files.length > 1 ? `${files.length} ZIP parts` : files[0]?.name, fileSize: files.reduce((sum, file) => sum + file.size, 0), result, identity: result.identity, archiveSet: result.parts?.[0] ? { id: result.parts[0].archiveId, platform: 'facebook', createdAt: Date.now(), partCount: parts.length, totalSize: files.reduce((sum, file) => sum + file.size, 0), fingerprint: result.archiveSetFingerprint ?? result.parts?.[0].manifestFingerprint ?? '', status: 'complete' } : undefined, archiveParts: parts, connectedPartIds: parts.filter(part => part.status !== 'failed' && part.status !== 'duplicate' && !!filesByPart[part.id]).map(part => part.id), imported });
  },
  connectArchive: (files, result) => set(state => {
    const parts = result.parts ?? []; const connected = registry(parts, files); const filesByPart = { ...state.filesByPart, ...connected }; const matchedPartIds = parts.filter(part => part.status !== 'failed' && part.status !== 'duplicate' && !!connected[part.id]).map(part => part.id); const connectedPartIds = [...new Set([...state.connectedPartIds, ...matchedPartIds])];
    return { filesByPart, connectedPartIds, archiveParts: state.archiveParts.map(part => connectedPartIds.includes(part.id) ? { ...part, connected: true, status: 'ready' } : part) };
  }),
  restoreArchive: (archiveSet, archiveParts, identity) => set({ archiveSet, archiveParts, identity, result: undefined, imported: true, file: undefined, filesByPart: {}, connectedPartIds: [] }),
  markImported: storageMode => set({ imported: true, storageMode }),
  clear: () => { objectUrlCache.clear(); set({ file: undefined, filesByPart: {}, fileName: undefined, fileSize: undefined, result: undefined, identity: undefined, archiveSet: undefined, archiveParts: [], connectedPartIds: [], imported: false, storageMode: undefined }); },
}));
