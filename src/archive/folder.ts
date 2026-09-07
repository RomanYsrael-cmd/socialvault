import type { ArchiveFileHandle, ArchiveSourceInput } from './source-registry';

export interface SelectedDirectoryEntry { readonly kind: 'file' | 'directory'; readonly name: string; getFile?: () => Promise<File>; entries?: () => AsyncIterableIterator<[string, SelectedDirectoryEntry]> }
export interface SelectedDirectoryHandle { readonly kind: 'directory'; readonly name: string; entries(): AsyncIterableIterator<[string, SelectedDirectoryEntry]>; queryPermission?: (options?: { mode?: 'read' }) => Promise<'granted' | 'denied' | 'prompt'>; requestPermission?: (options?: { mode?: 'read' }) => Promise<'granted' | 'denied' | 'prompt'>; }
export interface FolderDiscoveryResult { files: File[]; sources?: ArchiveSourceInput[]; directories: number; warnings: string[]; truncated: boolean; rootName: string }

const MAX_DEPTH = 8;
const MAX_DIRECTORIES = 2_000;
const MAX_FILES = 10_000;
const MAX_VISITED_ENTRIES = 50_000;
const isZipName = (name: string) => /\.zip$/i.test(name);

/** Recursively inspect only a user-selected directory, with resource bounds. */
async function discover(root: SelectedDirectoryHandle, materialize: boolean): Promise<FolderDiscoveryResult> {
  const files: File[] = [], sources: ArchiveSourceInput[] = [], warnings: string[] = [];
  let directories = 0, visitedEntries = 0, truncated = false;
  const visit = async (directory: SelectedDirectoryHandle, depth: number, relative: string) => {
    if (depth > MAX_DEPTH) { truncated = true; warnings.push(`Nested folder depth exceeded the safe limit near ${relative || directory.name}.`); return; }
    directories += 1;
    if (directories > MAX_DIRECTORIES) { truncated = true; warnings.push('Folder discovery stopped after a safety limit on nested directories.'); return; }
    try {
      for await (const [name, entry] of directory.entries()) {
        if (truncated) return;
        visitedEntries += 1;
        if (visitedEntries > MAX_VISITED_ENTRIES) { truncated = true; warnings.push('Folder discovery stopped after a safety limit on directory entries.'); return; }
        if (files.length + sources.length >= MAX_FILES) { truncated = true; warnings.push('Folder discovery stopped after a safety limit on ZIP files.'); return; }
        const childPath = relative ? `${relative}/${name}` : name;
        if (entry.kind === 'file' && isZipName(name) && entry.getFile) {
          if (materialize) {
            try { files.push(await entry.getFile()); } catch { warnings.push(`Could not read ZIP file ${name}.`); }
          } else {
            sources.push({ name, relativePath: childPath, handle: entry as unknown as ArchiveFileHandle });
          }
        } else if (entry.kind === 'directory' && entry.entries) {
          await visit(entry as SelectedDirectoryHandle, depth + 1, childPath);
          if (truncated && files.length + sources.length >= MAX_FILES) return;
        }
      }
    } catch { warnings.push(`Could not inspect folder ${relative || directory.name}.`); }
  };
  await visit(root, 0, '');
  return { files, sources: materialize ? undefined : sources, directories, warnings, truncated, rootName: root.name };
}

/** Discover folder ZIP handles without materializing all ZIP bytes up front. */
export function discoverZipSources(root: SelectedDirectoryHandle) { return discover(root, false); }
/** Compatibility helper for callers that explicitly need File objects. */
export function discoverZipFiles(root: SelectedDirectoryHandle) { return discover(root, true); }

export function directoryPicker(): (() => Promise<SelectedDirectoryHandle>) | undefined {
  const picker = (window as Window & { showDirectoryPicker?: () => Promise<SelectedDirectoryHandle> }).showDirectoryPicker;
  return picker ? () => picker() : undefined;
}
