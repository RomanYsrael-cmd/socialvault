import type { ActivityRecord, ActivityType, ArchiveCoverage, ArchiveIdentity, ArchivePart, Connection, ImportPartCheckpoint, ImportSession, Media, Message, NormalizedArchiveData, Person, Post, Profile } from '../archive/schemas/models';
import type { AlbumDetail, AlbumSummary, ArchiveStats, ArchiveStatus, ConversationPreview, DatabaseRequest, DatabaseResponse, ImportState, MemoryRecord, Page, PersonSummary, RebuildResult, SearchResponse, ConnectionSummary } from './types';

let worker: Worker | undefined;
let sequence = 0;
let ready: Promise<{ mode: 'opfs' | 'indexeddb'; searchBackend: 'fts5' | 'like' }> | undefined;
const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();

function call<T>(request: Omit<DatabaseRequest, 'id'>): Promise<T> {
  if (!worker) {
    worker = new Worker(new URL('./database.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent<DatabaseResponse>) => {
      const promise = pending.get(event.data.id); if (!promise) return;
      pending.delete(event.data.id); event.data.ok ? promise.resolve(event.data.data) : promise.reject(new Error(event.data.error));
    };
    worker.onerror = event => { const message = event instanceof ErrorEvent ? event.message : 'Database worker stopped unexpectedly.'; pending.forEach(item => item.reject(new Error(message))); pending.clear(); ready = undefined; worker = undefined; };
  }
  const id = ++sequence;
  return new Promise<T>((resolve, reject) => { pending.set(id, { resolve: resolve as never, reject }); worker!.postMessage({ ...request, id }); });
}

const emptyData = (): NormalizedArchiveData => ({ people: [], profileFacts: [], posts: [], comments: [], reactions: [], connections: [], albums: [], conversations: [], messages: [], media: [], warnings: [] });

export const database = {
  init() { return ready ??= call<{ mode: 'opfs' | 'indexeddb'; searchBackend: 'fts5' | 'like' }>({ type: 'init' }); },
  replace(data: NormalizedArchiveData) { return this.init().then(() => call<void>({ type: 'replace', data })); },
  importState(sessionId?: string) { return this.init().then(() => call<ImportState>({ type: 'import-state', sessionId })); },
  beginImport(session: ImportSession, parts: ArchivePart[], archiveSet?: NormalizedArchiveData['archiveSet'], archiveIdentity?: NormalizedArchiveData['archiveIdentity']) { return this.init().then(() => call<ImportState>({ type: 'begin-import', session, data: { ...emptyData(), archiveParts: parts, archiveSet, archiveIdentity } })); },
  importPart(sessionId: string, part: ArchivePart, data: NormalizedArchiveData) { return this.init().then(() => call<ImportPartCheckpoint>({ type: 'import-part', sessionId, part, data })); },
  importBatch(sessionId: string, part: ArchivePart, data: NormalizedArchiveData) { return this.init().then(() => call<ImportPartCheckpoint>({ type: 'import-batch', sessionId, part, data })); },
  updateMediaSources(data: Pick<NormalizedArchiveData, 'media'>) { return this.init().then(() => call<void>({ type: 'update-media-sources', data: { ...emptyData(), media: data.media } })); },
  updateImport(sessionId: string, patch: Partial<ImportSession>) { return this.init().then(() => call<ImportSession>({ type: 'update-import', sessionId, session: { ...patch, id: sessionId } as ImportSession })); },
  cancelImport(sessionId: string) { return this.init().then(() => call<ImportSession>({ type: 'cancel-import', sessionId })); },
  interruptImport(sessionId: string, errorMessage?: string) { return this.init().then(() => call<ImportSession>({ type: 'interrupt-import', sessionId, errorMessage })); },
  skipImportPart(sessionId: string, part: ArchivePart, errorMessage?: string) { return this.init().then(() => call<ImportPartCheckpoint>({ type: 'skip-import-part', sessionId, part, errorMessage })); },
  failImportPart(sessionId: string, part: ArchivePart, errorMessage?: string) { return this.init().then(() => call<ImportPartCheckpoint>({ type: 'fail-import-part', sessionId, part, errorMessage })); },
  retryImportPart(sessionId: string, part: ArchivePart) { return this.init().then(() => call<ImportState>({ type: 'retry-import-part', sessionId, part })); },
  restartImport() { return this.init().then(() => call<void>({ type: 'restart-import' })); },
  rebuildSearch() { return this.init().then(() => call<RebuildResult>({ type: 'rebuild-search' })); },
  rebuildActivity() { return this.init().then(() => call<RebuildResult>({ type: 'rebuild-activity' })); },
  coverage() { return this.init().then(() => call<ArchiveCoverage>({ type: 'coverage' })); },
  diagnostics() { return this.init().then(() => call<Record<string, unknown>>({ type: 'diagnostics' })); },
  profile() { return this.init().then(() => call<Profile | undefined>({ type: 'profile' })); },
  people(options: { limit?: number; cursor?: string; query?: string } = {}) { return this.init().then(() => call<Page<PersonSummary>>({ type: 'people', ...options })); },
  person(personId: string) { return this.init().then(() => call<PersonSummary | undefined>({ type: 'person', personId })); },
  posts(options: { limit?: number; cursor?: string; sort?: 'newest' | 'oldest'; year?: number; personId?: string } = {}) { return this.init().then(() => call<Page<Post>>({ type: 'posts', ...options })); },
  post(postId: string) { return this.init().then(() => call<Post | undefined>({ type: 'post', postId })); },
  conversations(options: { limit?: number; cursor?: string; query?: string } = {}) { return this.init().then(() => call<Page<ConversationPreview>>({ type: 'conversations', ...options })); },
  messages(conversationId: string, options: { limit?: number; cursor?: string } = {}) { return this.init().then(() => call<Page<Message>>({ type: 'messages', conversationId, ...options })); },
  connections(options: { limit?: number; cursor?: string; query?: string; type?: Connection['type'] } = {}) { const { type: connectionType, ...rest } = options; return this.init().then(() => call<Page<ConnectionSummary>>({ type: 'connections', connectionType, ...rest })); },
  albums(options: { limit?: number; cursor?: string; query?: string } = {}) { return this.init().then(() => call<Page<AlbumSummary>>({ type: 'albums', ...options })); },
  album(albumId: string) { return this.init().then(() => call<AlbumDetail | undefined>({ type: 'album', albumId })); },
  memories(month: number, day: number, options: { limit?: number } = {}) { return this.init().then(() => call<MemoryRecord[]>({ type: 'memories', month, day, ...options })); },
  activity(options: { limit?: number; cursor?: string; activityType?: ActivityType; year?: number; query?: string } = {}) { return this.init().then(() => call<Page<ActivityRecord>>({ type: 'activity', ...options })); },
  media(options: { limit?: number; cursor?: string; mediaType?: Media['mediaType'] } = {}) { return this.init().then(() => call<Page<Media>>({ type: 'media', ...options })); },
  search(query: string, options: { limit?: number; cursor?: string; entityType?: string; year?: number; from?: string; to?: string } = {}) { return this.init().then(() => call<SearchResponse>({ type: 'search', query, ...options })); },
  stats() { return this.init().then(() => call<ArchiveStats>({ type: 'stats' })); },
  archiveIdentity() { return this.init().then(() => call<ArchiveIdentity | undefined>({ type: 'archive-identity' })); },
  archiveStatus() { return this.init().then(() => call<ArchiveStatus>({ type: 'archive-status' })); },
  touchMedia(path: string, byteSize?: number) { return this.init().then(() => call<void>({ type: 'media-cache', mediaPath: path, byteSize })); },
};
