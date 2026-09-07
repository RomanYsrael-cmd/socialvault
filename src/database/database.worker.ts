/// <reference lib="webworker" />
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { clearFallbackImportState, getFallback, getFallbackImportState, getFallbackSnapshot, putFallback, putFallbackImportState, putFallbackSnapshot } from './indexeddb-fallback';
import { FTS5_SCHEMA, MIGRATIONS, SCHEMA_VERSION } from './schema';
import { archivePartId, archiveSetFingerprint, archiveSetId, mergeNormalizedData } from '../archive/archive-set';
import type { AlbumSummary, ArchiveStats, ConnectionSummary, ConversationPreview, DatabaseProgress, DatabaseRequest, DatabaseResponse, ImportState, MemoryRecord, Page, PersonSummary, RebuildResult, SearchBackend, SearchResponse, SearchResult, StorageMode } from './types';
import type { ActivityRecord, ActivityType, Album, ArchiveCoverage, ArchiveIdentity, ArchivePart, ArchiveSet, Comment, Connection, Conversation, DerivedIndexState, DerivedIndexStatus, ImportCounts, ImportDiagnostics, ImportPartCheckpoint, ImportSectionStatus, ImportSession, Media, Message, NormalizedArchiveData, Person, Post, Profile, ProfileFact, Reaction } from '../archive/schemas/models';
import { FACEBOOK_PARSER_VERSION } from '../archive/adapters/version';
import { createDiagnosticsReport } from './diagnostics';

type DB = { exec: (options: string | Record<string, unknown>) => unknown; transaction: (fn: () => void) => void; pointer?: unknown; close?: () => void };
let db: DB;
let sqliteRuntime: any;
let mode: StorageMode = 'indexeddb';
let searchBackend: SearchBackend = 'like';
let fallbackData: NormalizedArchiveData | undefined;
let batchesSinceFallback = 0;
let derivedBatchesSinceFallback = 0;
let databaseWriteDurationMs = 0;
let databaseWriteBatchCount = 0;
let activeDerivedSession: string | undefined;
let derivedCancelRequested = false;
let fallbackSnapshotTimer: ReturnType<typeof setTimeout> | undefined;
let fallbackSnapshotRunning = false;
let fallbackSnapshotRequested = false;

const send = (message: DatabaseResponse | DatabaseProgress) => postMessage(message);
const sendDerivedProgress = (requestId: number, kind: 'search' | 'activity', phase: string, status: DatabaseProgress['status'], rowsProcessed: number, totalRows: number, message: string) => postMessage({ type: 'progress', requestId, kind, phase, status, rowsProcessed, totalRows, message } satisfies DatabaseProgress);
const rows = (sql: string, bind: unknown[] = []): Record<string, unknown>[] => db.exec({ sql, bind, returnValue: 'resultRows', rowMode: 'object' } as Record<string, unknown>) as Record<string, unknown>[];
/** Keep the original SQLite/storage error if SQLite has already rolled back
 * internally (for example after SQLITE_FULL or SQLITE_NOMEM). The oo1
 * convenience wrapper attempts a second rollback in that case and masks the
 * actionable failure with "cannot rollback - no transaction is active". */
const transaction = (work: () => void) => {
  db.exec('BEGIN');
  try { work(); db.exec('COMMIT'); }
  catch (error) { try { db.exec('ROLLBACK'); } catch { /* preserve original error */ } throw error; }
};
function deserializeSnapshot(target: DB, snapshot: Uint8Array) {
  if (!sqliteRuntime?.capi?.sqlite3_deserialize || !target.pointer) return false;
  try {
    const pointer = sqliteRuntime.wasm.allocFromTypedArray(snapshot);
    const flags = sqliteRuntime.capi.SQLITE_DESERIALIZE_RESIZEABLE | sqliteRuntime.capi.SQLITE_DESERIALIZE_FREEONCLOSE;
    return sqliteRuntime.capi.sqlite3_deserialize(target.pointer, 'main', pointer, snapshot.byteLength, snapshot.byteLength, flags) === 0;
  } catch { return false; }
}
const isStorageWriteFailure = (error: unknown) => mode === 'opfs' && /SQLITE_(?:IOERR|FULL|NOMEM)|disk\s+i\/o|quota|no\s+space|write\s+failed/i.test(error instanceof Error ? error.message : String(error));
function switchToIndexedDbFallback(preserve = true) {
  if (mode !== 'opfs' || !sqliteRuntime?.oo1?.DB) return false;
  if (!preserve) {
    const previous = db;
    let memory: DB | undefined;
    try {
      memory = new sqliteRuntime.oo1.DB(':memory:', 'c') as DB;
      db = memory; mode = 'indexeddb';
      // The fresh connection does not contain the OPFS schema. Initialize it
      // before the caller starts writing import checkpoints or normalized rows.
      applyMigrations(); setupSearch();
      previous.close?.();
      batchesSinceFallback = 0; derivedBatchesSinceFallback = 0;
      return true;
    } catch { try { memory?.close?.(); } catch { /* ignore cleanup failure */ } db = previous; mode = 'opfs'; return false; }
  }
  let snapshot: Uint8Array | undefined;
  try { if (sqliteRuntime.capi?.sqlite3_js_db_export && db.pointer) snapshot = sqliteRuntime.capi.sqlite3_js_db_export(db.pointer) as Uint8Array; } catch { snapshot = undefined; }
  const previous = db;
  let memory: DB;
  try { memory = new sqliteRuntime.oo1.DB(':memory:', 'c') as DB; } catch { return false; }
  // Never switch to an empty in-memory database. If the OPFS database cannot
  // be exported or the copy cannot be deserialized, leave the original
  // connection alive and surface the storage error to the caller.
  if (!snapshot?.byteLength || !deserializeSnapshot(memory, snapshot)) { try { memory.close?.(); } catch { /* ignore cleanup failure */ } return false; }
  try { previous.close?.(); } catch { /* preserve the readable in-memory copy */ }
  db = memory; mode = 'indexeddb'; batchesSinceFallback = 0; derivedBatchesSinceFallback = 0;
  return true;
}
async function withStorageFallback<T>(work: () => T | Promise<T>): Promise<T> {
  try { return await work(); }
  catch (error) {
    if (!isStorageWriteFailure(error) || !switchToIndexedDbFallback()) throw error;
    // Retry the idempotent operation against the copied in-memory database.
    // The surrounding request handler snapshots the successfully committed
    // state; avoiding an extra export here keeps large fallback imports from
    // holding two full SQLite copies at once.
    return await work();
  }
}
const limitOf = (value?: number) => Math.min(100, Math.max(1, value ?? 20));
const SQLITE_BATCH_SIZE = 2000;
const SQLITE_MIN_BATCH_SIZE = 500;
const SQLITE_MAX_BATCH_SIZE = 2000;
let sqliteBatchSize = SQLITE_BATCH_SIZE;
/** Chosen from the M9 synthetic and representative HTML probes: 5k normalized
 * records keeps structured-clone payloads small while avoiding one SQLite
 * transaction per HTML card. Derived SQL jobs use the same upper bound. */
const DERIVED_BATCH_SIZE = 5000;
// A multi-gigabyte Facebook ZIP set can exceed the browser's OPFS quota even
// when the normalized SQLite file is still healthy. Choose the durable
// IndexedDB/memory path before the first large write so a later OPFS failure
// never requires exporting and deserializing a full archive-sized database.
const LARGE_ARCHIVE_OPFS_THRESHOLD = 2 * 1024 * 1024 * 1024;
const preferIndexedDbForArchive = (archiveSet?: ArchiveSet) => {
  if (mode !== 'opfs' || !archiveSet || archiveSet.totalSize < LARGE_ARCHIVE_OPFS_THRESHOLD) return false;
  // A fresh import has no source rows to preserve. Avoid an unnecessary
  // OPFS export/deserialization at the handoff point; resumptions still copy
  // the existing database so completed parts remain intact.
  const hasSourceRows = Number(rows('SELECT (SELECT COUNT(*) FROM profiles)+(SELECT COUNT(*) FROM posts)+(SELECT COUNT(*) FROM messages) count')[0]?.count ?? 0) > 0;
  return switchToIndexedDbFallback(hasSourceRows);
};
/** Keep SQLite writes bounded while avoiding one worker round-trip per record.
 * 2000 rows stays below SQLite's default variable limit even for the widest
 * normalized table (15 columns) while making large HTML imports materially
 * faster. */
function batchInsert(table: string, columns: string[], values: unknown[][], conflict = '') {
  if (!values.length) return;
  const placeholders = `(${columns.map(() => '?').join(',')})`;
  for (let offset = 0; offset < values.length; offset += sqliteBatchSize) {
    const chunk = values.slice(offset, offset + sqliteBatchSize);
    db.exec({ sql: `INSERT ${conflict} INTO ${table}(${columns.join(',')}) VALUES ${chunk.map(() => placeholders).join(',')}`, bind: chunk.flat() });
  }
}
const encode = (value: unknown) => encodeURIComponent(JSON.stringify(value));
const decode = (value?: string) => {
  if (!value) return undefined;
  try { return JSON.parse(decodeURIComponent(value)) as Record<string, unknown>; } catch { return undefined; }
};
const json = <T>(value: unknown, fallback: T): T => { try { return JSON.parse(String(value ?? '')) as T; } catch { return fallback; } };
const emptyCounts = (): ImportCounts => ({ profiles: 0, people: 0, posts: 0, comments: 0, reactions: 0, connections: 0, albums: 0, conversations: 0, messages: 0, media: 0, activities: 0 });
const countData = (data: Partial<NormalizedArchiveData>): ImportCounts => ({ profiles: data.profile ? 1 : 0, people: data.people?.length ?? 0, posts: data.posts?.length ?? 0, comments: data.comments?.length ?? 0, reactions: data.reactions?.length ?? 0, connections: data.connections?.length ?? 0, albums: data.albums?.length ?? 0, conversations: data.conversations?.length ?? 0, messages: data.messages?.length ?? 0, media: data.media?.length ?? 0, activities: 0 });

function applyMigrations() {
  for (const migration of MIGRATIONS) {
    if (migration.version === 1) {
      migration.statements.forEach(statement => db.exec(statement));
      db.exec({ sql: 'INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES(?,?)', bind: [migration.version, new Date().toISOString()] });
      continue;
    }
    if (rows('SELECT 1 FROM schema_migrations WHERE version=?', [migration.version]).length) continue;
    transaction(() => migration.statements.forEach(statement => db.exec(statement)));
    db.exec({ sql: 'INSERT INTO schema_migrations(version,applied_at) VALUES(?,?)', bind: [migration.version, new Date().toISOString()] });
  }
  db.exec('PRAGMA optimize');
}

/** Upgrade a v5 single-ZIP database in place: the old identity becomes part 1. */
function backfillArchiveSet() {
  const legacy = rows('SELECT filename,size,entry_count entryCount,fingerprint,known_entries knownEntries FROM archive_identity WHERE id=1')[0];
  if (!legacy || Number(rows('SELECT COUNT(*) count FROM archive_sets')[0]?.count ?? 0) > 0) return;
  const fingerprint = String(legacy.fingerprint); const archiveId = archiveSetId(fingerprint); const partId = archivePartId(fingerprint);
  transaction(() => {
    db.exec({ sql: 'INSERT OR IGNORE INTO archive_sets(id,platform,created_at,part_count,total_size,fingerprint,imported_at,status) VALUES(?,?,?,?,?,?,?,?)', bind: [archiveId, 'facebook', Date.now(), 1, Number(legacy.size), fingerprint, new Date().toISOString(), 'complete'] });
    db.exec({ sql: 'INSERT OR IGNORE INTO archive_parts(id,archive_id,part_index,filename,file_size,entry_count,manifest_fingerprint,connected,status,warning_count,sections) VALUES(?,?,?,?,?,?,?,?,?,?,?)', bind: [partId, archiveId, 0, String(legacy.filename), Number(legacy.size), Number(legacy.entryCount), fingerprint, 0, 'missing', 0, '[]'] });
    for (const table of ['posts', 'conversations', 'messages', 'media', 'comments', 'reactions', 'connections', 'albums', 'profile_facts', 'activity_records']) db.exec(`UPDATE ${table} SET archive_part_id='${partId}' WHERE archive_part_id IS NULL`);
    db.exec({ sql: 'INSERT OR IGNORE INTO source_records(entity_type,entity_id,archive_part_id) SELECT ?,id,? FROM profiles', bind: ['profile', partId] });
    db.exec({ sql: 'UPDATE person_sources SET archive_part_id=? WHERE archive_part_id IS NULL', bind: [partId] });
    db.exec({ sql: 'INSERT OR REPLACE INTO import_metadata(key,value) VALUES(?,?)', bind: ['archive_set_id', archiveId] });
  });
}

const sessionIdForArchive = (archiveId: string) => `import-session:${archiveId}`;
function countsFrom(value: unknown): ImportCounts { return { ...emptyCounts(), ...json<Partial<ImportCounts>>(value, {}) }; }
function sessionFromRow(row?: Record<string, unknown>): ImportSession | undefined {
  if (!row) return undefined;
  return {
    id: String(row.id), archiveSetId: String(row.archiveSetId), startedAt: String(row.startedAt), updatedAt: String(row.updatedAt),
    parserVersion: Number(row.parserVersion), schemaVersion: Number(row.schemaVersion), expectedPartCount: Number(row.expectedPartCount), inspectedPartCount: Number(row.inspectedPartCount), importedPartCount: Number(row.importedPartCount), failedPartCount: Number(row.failedPartCount), skippedPartCount: Number(row.skippedPartCount),
    currentStage: String(row.currentStage) as ImportSession['currentStage'], status: String(row.status) as ImportSession['status'], normalizedCounts: countsFrom(row.normalizedCounts), warningsCount: Number(row.warningsCount ?? 0), failedPartIds: json<string[]>(row.failedPartIds, []), skippedPartIds: json<string[]>(row.skippedPartIds, []), detectedSections: json<string[]>(row.detectedSections, []), importedSections: json<string[]>(row.importedSections, []), coverage: json<ArchiveCoverage | undefined>(row.coverage, undefined), lastError: row.lastError ? String(row.lastError) : undefined, metrics: json<ImportSession['metrics']>(row.metrics, undefined), sourceStatus: row.sourceStatus ? String(row.sourceStatus) as ImportSession['sourceStatus'] : undefined, derivedStatus: row.derivedStatus ? String(row.derivedStatus) as ImportSession['derivedStatus'] : undefined, derivedPhase: row.derivedPhase ? String(row.derivedPhase) : undefined, derivedRows: Number(row.derivedRows ?? 0), derivedTotal: Number(row.derivedTotal ?? 0), derivedUpdatedAt: row.derivedUpdatedAt ? String(row.derivedUpdatedAt) : undefined, derivedError: row.derivedError ? String(row.derivedError) : undefined,
  };
}
function checkpointFromRow(row: Record<string, unknown>): ImportPartCheckpoint {
  return { sessionId: String(row.sessionId), archivePartId: String(row.archivePartId), partIndex: Number(row.partIndex), manifestFingerprint: String(row.manifestFingerprint), status: String(row.status) as ImportPartCheckpoint['status'], startedAt: row.startedAt ? String(row.startedAt) : undefined, updatedAt: String(row.updatedAt), completedAt: row.completedAt ? String(row.completedAt) : undefined, parserVersion: Number(row.parserVersion), recordCounts: json<Partial<ImportCounts>>(row.recordCounts, {}), warningsCount: Number(row.warningsCount ?? 0), error: row.error ? String(row.error) : undefined, sections: json<string[]>(row.sections, []) };
}
function currentImportState(sessionId?: string): ImportState {
  const row = rows(`SELECT id,archive_set_id archiveSetId,started_at startedAt,updated_at updatedAt,parser_version parserVersion,schema_version schemaVersion,expected_part_count expectedPartCount,inspected_part_count inspectedPartCount,imported_part_count importedPartCount,failed_part_count failedPartCount,skipped_part_count skippedPartCount,current_stage currentStage,status,normalized_counts normalizedCounts,warnings_count warningsCount,failed_part_ids failedPartIds,skipped_part_ids skippedPartIds,detected_sections detectedSections,imported_sections importedSections,coverage,last_error lastError,metrics,source_status sourceStatus,derived_status derivedStatus,derived_phase derivedPhase,derived_rows derivedRows,derived_total derivedTotal,derived_updated_at derivedUpdatedAt,derived_error derivedError FROM import_sessions ${sessionId ? 'WHERE id=?' : 'ORDER BY updated_at DESC'} LIMIT 1`, sessionId ? [sessionId] : []);
  const session = sessionFromRow(row[0]);
  const checkpoints = session ? rows('SELECT session_id sessionId,archive_part_id archivePartId,part_index partIndex,manifest_fingerprint manifestFingerprint,status,started_at startedAt,updated_at updatedAt,completed_at completedAt,parser_version parserVersion,record_counts recordCounts,warnings_count warningsCount,error,sections FROM import_part_checkpoints WHERE session_id=? ORDER BY part_index,archive_part_id', [session.id]).map(checkpointFromRow) : [];
  const derivedIndexes = session ? rows('SELECT id,session_id sessionId,kind,status,phase,cursor,rows_processed rowsProcessed,total_rows totalRows,batch_size batchSize,started_at startedAt,updated_at updatedAt,completed_at completedAt,error FROM derived_index_jobs WHERE session_id=? ORDER BY kind', [session.id]).map(derivedFromRow) : [];
  return { session, checkpoints, coverage: session?.coverage, derivedIndexes };
}
function derivedFromRow(row: Record<string, unknown>): DerivedIndexState { return { id: String(row.id), sessionId: String(row.sessionId), kind: String(row.kind) as DerivedIndexState['kind'], status: String(row.status) as DerivedIndexState['status'], phase: String(row.phase), cursor: row.cursor ? String(row.cursor) : undefined, rowsProcessed: Number(row.rowsProcessed ?? 0), totalRows: Number(row.totalRows ?? 0), batchSize: Number(row.batchSize ?? DERIVED_BATCH_SIZE), startedAt: String(row.startedAt), updatedAt: String(row.updatedAt), completedAt: row.completedAt ? String(row.completedAt) : undefined, error: row.error ? String(row.error) : undefined }; }
function upsertSession(session: ImportSession) {
  db.exec({ sql: 'INSERT OR REPLACE INTO import_sessions(id,archive_set_id,started_at,updated_at,parser_version,schema_version,expected_part_count,inspected_part_count,imported_part_count,failed_part_count,skipped_part_count,current_stage,status,normalized_counts,warnings_count,failed_part_ids,skipped_part_ids,detected_sections,imported_sections,coverage,last_error,metrics,source_status,derived_status,derived_phase,derived_rows,derived_total,derived_updated_at,derived_error) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', bind: [session.id, session.archiveSetId, session.startedAt, session.updatedAt, session.parserVersion, session.schemaVersion, session.expectedPartCount, session.inspectedPartCount, session.importedPartCount, session.failedPartCount, session.skippedPartCount, session.currentStage, session.status, JSON.stringify(session.normalizedCounts), session.warningsCount, JSON.stringify(session.failedPartIds ?? []), JSON.stringify(session.skippedPartIds ?? []), JSON.stringify(session.detectedSections ?? []), JSON.stringify(session.importedSections ?? []), session.coverage ? JSON.stringify(session.coverage) : null, session.lastError ?? null, session.metrics ? JSON.stringify(session.metrics) : null, session.sourceStatus ?? 'pending', session.derivedStatus ?? 'pending', session.derivedPhase ?? null, session.derivedRows ?? 0, session.derivedTotal ?? 0, session.derivedUpdatedAt ?? null, session.derivedError ?? null] });
}
function ensureLegacyImportSession() {
  const archive = rows('SELECT id,part_count partCount,status FROM archive_sets ORDER BY created_at DESC LIMIT 1')[0];
  if (!archive || rows('SELECT 1 FROM import_sessions LIMIT 1').length) return;
  const now = new Date().toISOString(); const archiveId = String(archive.id); const counts = emptyCounts();
  for (const [key, table] of Object.entries({ profiles: 'profiles', people: 'people', posts: 'posts', comments: 'comments', reactions: 'reactions', connections: 'connections', albums: 'albums', conversations: 'conversations', messages: 'messages', media: 'media', activities: 'activity_records' })) counts[key as keyof ImportCounts] = Number(rows(`SELECT COUNT(*) count FROM ${table}`)[0]?.count ?? 0);
  const sections = json<string[]>(rows("SELECT value FROM import_metadata WHERE key='sections'")[0]?.value, []);
  const sourceStatus = archive.status === 'complete' ? 'complete' as const : 'incomplete' as const;
  const session: ImportSession = { id: sessionIdForArchive(archiveId), archiveSetId: archiveId, startedAt: now, updatedAt: now, parserVersion: FACEBOOK_PARSER_VERSION, schemaVersion: SCHEMA_VERSION, expectedPartCount: Number(archive.partCount ?? 0), inspectedPartCount: Number(archive.partCount ?? 0), importedPartCount: Number(archive.partCount ?? 0), failedPartCount: 0, skippedPartCount: 0, currentStage: sourceStatus === 'complete' ? 'indexing' : 'interrupted', status: sourceStatus === 'complete' ? 'indexing' : 'interrupted', normalizedCounts: counts, warningsCount: Number(rows("SELECT value FROM import_metadata WHERE key='warning_count'")[0]?.value ?? 0), detectedSections: sections, importedSections: sections, coverage: { detectedSections: sections, importedSections: sections, partialSections: [], unsupportedSections: [], malformedSections: [], skippedParts: [] }, sourceStatus, derivedStatus: 'pending' };
  transaction(() => { upsertSession(session); rows('SELECT id,part_index partIndex,manifest_fingerprint manifestFingerprint,status FROM archive_parts WHERE archive_id=? ORDER BY part_index', [archiveId]).forEach(row => db.exec({ sql: 'INSERT OR REPLACE INTO import_part_checkpoints(session_id,archive_part_id,part_index,manifest_fingerprint,status,updated_at,completed_at,parser_version,record_counts,warnings_count,sections) VALUES(?,?,?,?,?,?,?,?,?,?,?)', bind: [session.id, String(row.id), Number(row.partIndex), String(row.manifestFingerprint), 'complete', now, now, FACEBOOK_PARSER_VERSION, JSON.stringify(counts), 0, JSON.stringify(sections)] })); });
}
function restoreImportState(state?: ImportState) {
  if (!state?.session) return;
  transaction(() => {
    upsertSession(state.session!);
    db.exec({ sql: 'DELETE FROM import_part_checkpoints WHERE session_id=?', bind: [state.session!.id] });
    for (const checkpoint of state.checkpoints) db.exec({ sql: 'INSERT OR REPLACE INTO import_part_checkpoints(session_id,archive_part_id,part_index,manifest_fingerprint,status,started_at,updated_at,completed_at,parser_version,record_counts,warnings_count,error,sections) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)', bind: [checkpoint.sessionId, checkpoint.archivePartId, checkpoint.partIndex, checkpoint.manifestFingerprint, checkpoint.status, checkpoint.startedAt ?? null, checkpoint.updatedAt, checkpoint.completedAt ?? null, checkpoint.parserVersion, JSON.stringify(checkpoint.recordCounts ?? {}), checkpoint.warningsCount, checkpoint.error ?? null, JSON.stringify(checkpoint.sections ?? [])] });
    for (const job of state.derivedIndexes ?? []) db.exec({ sql: 'INSERT OR REPLACE INTO derived_index_jobs(session_id,kind,status,phase,cursor,rows_processed,total_rows,batch_size,started_at,updated_at,completed_at,error) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)', bind: [job.sessionId, job.kind, job.status, job.phase, job.cursor ?? null, job.rowsProcessed, job.totalRows, job.batchSize, job.startedAt, job.updatedAt, job.completedAt ?? null, job.error ?? null] });
  });
}

function setupSearch() {
  try { db.exec(FTS5_SCHEMA); searchBackend = 'fts5'; } catch { searchBackend = 'like'; }
}

function normalizedData(data: Partial<NormalizedArchiveData>): NormalizedArchiveData {
  return { ...data, people: data.people ?? [], profileFacts: data.profileFacts ?? data.profile?.facts ?? [], posts: data.posts ?? [], comments: data.comments ?? [], reactions: data.reactions ?? [], connections: data.connections ?? [], albums: data.albums ?? [], conversations: data.conversations ?? [], messages: data.messages ?? [], media: data.media ?? [], warnings: data.warnings ?? [] };
}
function metadataSnapshot(data: Partial<NormalizedArchiveData>): NormalizedArchiveData {
  return normalizedData({ profile: data.profile, warnings: (data.warnings ?? []).slice(0, 200), importedSections: data.importedSections, diagnostics: data.diagnostics, archiveIdentity: data.archiveIdentity, archiveSet: data.archiveSet, archiveParts: data.archiveParts, coverage: data.coverage, warningGroups: data.warningGroups, performance: data.performance, sourceFormat: data.sourceFormat });
}

const sourceRef = (row: Record<string, unknown>, pathKey = 'sourcePath', indexKey = 'sourceIndex') => ({ platform: 'facebook', path: String(row[pathKey] ?? ''), index: row[indexKey] === null || row[indexKey] === undefined ? undefined : Number(row[indexKey]), archivePartId: row.archivePartId ? String(row.archivePartId) : undefined });

function mapMedia(row: Record<string, unknown>): Media {
  return {
    id: String(row.id), path: String(row.path), mediaType: String(row.mediaType) as Media['mediaType'],
    filename: row.filename ? String(row.filename) : undefined, mimeType: row.mimeType ? String(row.mimeType) : undefined,
    caption: row.caption ? String(row.caption) : undefined, timestamp: row.timestamp ? String(row.timestamp) : undefined,
    ownerType: String(row.ownerType) as Media['ownerType'], ownerId: String(row.ownerId),
    width: row.width === null || row.width === undefined ? undefined : Number(row.width), height: row.height === null || row.height === undefined ? undefined : Number(row.height),
    durationMs: row.durationMs === null || row.durationMs === undefined ? undefined : Number(row.durationMs),
    source: sourceRef(row),
  };
}

function mediaForJson(value: unknown): Media[] { return json<Record<string, unknown>[]>(value, []).map(item => item.source ? item as unknown as Media : mapMedia(item)); }

function mapProfile(row?: Record<string, unknown>): Profile | undefined {
  return row ? {
    id: String(row.id), personId: String(row.personId), displayName: String(row.displayName),
    facebookId: row.facebookId ? String(row.facebookId) : undefined, username: row.username ? String(row.username) : undefined,
    profileUrl: row.profileUrl ? String(row.profileUrl) : undefined, bio: row.bio ? String(row.bio) : undefined,
    joinedAt: row.joinedAt ? String(row.joinedAt) : undefined, relationship: row.relationship ? String(row.relationship) : undefined, profilePhotoPath: row.profilePhotoPath ? String(row.profilePhotoPath) : undefined,
    coverPhotoPath: row.coverPhotoPath ? String(row.coverPhotoPath) : undefined, facts: json<ProfileFact[]>(row.factsJson, []), source: sourceRef(row),
  } : undefined;
}

function mapPost(row: Record<string, unknown>): Post {
  return {
    id: String(row.id), authorId: row.authorId ? String(row.authorId) : undefined, authorName: row.authorName ? String(row.authorName) : undefined, authorPhotoPath: row.authorPhotoPath ? String(row.authorPhotoPath) : undefined, title: row.title ? String(row.title) : undefined,
    text: row.text ? String(row.text) : undefined, createdAt: row.createdAt ? String(row.createdAt) : undefined, links: json<string[]>(row.linksJson, []),
    mediaCount: Number(row.mediaCount ?? 0), commentCount: Number(row.commentCount ?? 0), reactionCount: Number(row.reactionCount ?? 0), media: mediaForJson(row.mediaJson), comments: json<Comment[]>(row.commentsJson, []), reactions: json<Reaction[]>(row.reactionsJson, []),
    source: sourceRef(row),
  };
}

function mapMessage(row: Record<string, unknown>): Message {
  return {
    id: String(row.id), conversationId: String(row.conversationId), senderId: row.senderId ? String(row.senderId) : undefined,
    senderName: row.senderName ? String(row.senderName) : undefined, text: row.text ? String(row.text) : undefined,
    sentAt: row.sentAt ? String(row.sentAt) : undefined, mediaCount: Number(row.mediaCount ?? 0), media: mediaForJson(row.mediaJson),
    source: sourceRef(row),
  };
}

function mapPerson(row: Record<string, unknown>): PersonSummary {
  return {
    id: String(row.id), displayName: String(row.displayName), facebookId: row.facebookId ? String(row.facebookId) : undefined,
    username: row.username ? String(row.username) : undefined, profileUrl: row.profileUrl ? String(row.profileUrl) : undefined,
    profilePhotoPath: row.profilePhotoPath ? String(row.profilePhotoPath) : undefined, coverPhotoPath: row.coverPhotoPath ? String(row.coverPhotoPath) : undefined,
    firstSeen: row.firstSeen ? String(row.firstSeen) : undefined, lastSeen: row.lastSeen ? String(row.lastSeen) : undefined,
    relationship: row.relationship ? String(row.relationship) : undefined,
    identityConfidence: row.identityConfidence as Person['identityConfidence'], identitySource: row.identitySource ? String(row.identitySource) : undefined,
    sourcePaths: json<string[]>(row.sourcePaths, []), sourcePartIds: json<string[]>(row.sourcePartIds, []), isArchiveOwner: Number(row.isArchiveOwner ?? 0) === 1,
    participationCount: Number(row.participationCount ?? 0), messageCount: Number(row.messageCount ?? 0), postCount: Number(row.postCount ?? 0), mediaCount: Number(row.mediaCount ?? 0), commentCount: Number(row.commentCount ?? 0), reactionCount: Number(row.reactionCount ?? 0), connectionCount: Number(row.connectionCount ?? 0), albumCount: Number(row.albumCount ?? 0), sharedPostCount: Number(row.sharedPostCount ?? 0), sharedMediaCount: Number(row.sharedMediaCount ?? 0),
    firstInteraction: row.firstInteraction ? String(row.firstInteraction) : undefined, lastInteraction: row.lastInteraction ? String(row.lastInteraction) : undefined,
  };
}

function mediaJson(ownerType: 'post' | 'message' | 'album', ownerId: string) {
  const records = rows('SELECT id,path,media_type mediaType,filename,mime_type mimeType,caption,timestamp,owner_type ownerType,owner_id ownerId,width,height,duration_ms durationMs,source_path sourcePath,source_index sourceIndex,archive_part_id archivePartId FROM media WHERE owner_type=? AND owner_id=? ORDER BY id', [ownerType, ownerId]);
  return JSON.stringify(records.map(mapMedia));
}

function mapActivity(row: Record<string, unknown>): ActivityRecord {
  return { id: String(row.id), type: String(row.activityType) as ActivityType, actorPersonId: row.actorPersonId ? String(row.actorPersonId) : undefined, actorName: row.actorName ? String(row.actorName) : undefined, targetType: row.targetType ? String(row.targetType) : undefined, targetId: row.targetId ? String(row.targetId) : undefined, timestamp: String(row.timestamp), summary: String(row.summary), source: sourceRef(row) };
}

function replace(input: NormalizedArchiveData) {
  const data = normalizedData(input);
  const fallbackPart = data.archiveParts?.[0] ?? (data.archiveIdentity ? { id: archivePartId(data.archiveIdentity.fingerprint), archiveId: archiveSetId(data.archiveIdentity.fingerprint), partIndex: 0, filename: data.archiveIdentity.filename, fileSize: data.archiveIdentity.size, entryCount: data.archiveIdentity.entryCount, manifestFingerprint: data.archiveIdentity.fingerprint, connected: true, status: 'ready' as const } : undefined);
  const parts = data.archiveParts?.length ? data.archiveParts : fallbackPart ? [fallbackPart] : [];
  const fallbackFingerprint = parts.length ? archiveSetFingerprint(parts) : undefined;
  const archiveSet = data.archiveSet ?? (parts.length && fallbackFingerprint ? { id: archiveSetId(fallbackFingerprint), platform: 'facebook' as const, createdAt: Date.now(), partCount: parts.length, totalSize: parts.reduce((sum, part) => sum + part.fileSize, 0), fingerprint: fallbackFingerprint, status: 'complete' as const } : undefined);
  preferIndexedDbForArchive(archiveSet);
  const partIdFor = (source: { archivePartId?: string }) => source.archivePartId ?? parts[0]?.id ?? null;
  transaction(() => {
    ['activity_records', 'comments', 'reactions', 'album_media', 'albums', 'profile_facts', 'messages', 'conversations', 'posts', 'profiles', 'media', 'people', 'person_sources', 'source_records', 'import_metadata', 'archive_identity', 'archive_parts', 'archive_sets', 'import_part_checkpoints', 'import_section_status', 'diagnostic_warning_groups', 'derived_index_jobs', 'import_sessions', 'rebuild_jobs'].forEach(table => db.exec(`DELETE FROM ${table}`));
    if (archiveSet) db.exec({ sql: 'INSERT INTO archive_sets(id,platform,created_at,part_count,total_size,fingerprint,imported_at,status,source_format) VALUES(?,?,?,?,?,?,?,?,?)', bind: [archiveSet.id, archiveSet.platform, archiveSet.createdAt, archiveSet.partCount, archiveSet.totalSize, archiveSet.fingerprint, archiveSet.importedAt ?? new Date().toISOString(), archiveSet.status ?? 'complete', archiveSet.sourceFormat ?? null] });
    for (const part of parts) db.exec({ sql: 'INSERT OR REPLACE INTO archive_parts(id,archive_id,part_index,filename,file_size,entry_count,manifest_fingerprint,connected,status,warning_count,sections,source_format) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)', bind: [part.id, archiveSet?.id ?? part.archiveId, part.partIndex, part.filename, part.fileSize, part.entryCount, part.manifestFingerprint, part.connected ? 1 : 0, part.status ?? 'ready', part.warningCount ?? 0, JSON.stringify(part.sections ?? []), part.sourceFormat ?? null] });
    if (data.profile) { db.exec({ sql: 'INSERT INTO profiles(id,person_id,display_name,username,bio,joined_at,source_path) VALUES(?,?,?,?,?,?,?)', bind: [data.profile.id, data.profile.personId, data.profile.displayName, data.profile.username ?? null, data.profile.bio ?? null, data.profile.joinedAt ?? null, data.profile.source.path] }); if (partIdFor(data.profile.source)) db.exec({ sql: 'INSERT OR REPLACE INTO source_records(entity_type,entity_id,archive_part_id) VALUES(?,?,?)', bind: ['profile', data.profile.id, partIdFor(data.profile.source)] }); }
    for (const person of data.people) {
      db.exec({ sql: 'INSERT OR REPLACE INTO people(id,facebook_id,display_name,username,profile_url,profile_photo_path,cover_photo_path,first_seen,last_seen,relationship,identity_confidence,identity_source,source_paths,is_archive_owner) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)', bind: [person.id, person.facebookId ?? null, person.displayName, person.username ?? null, person.profileUrl ?? null, person.profilePhotoPath ?? null, person.coverPhotoPath ?? null, person.firstSeen ?? null, person.lastSeen ?? null, person.relationship ?? null, person.identityConfidence ?? null, person.identitySource ?? null, JSON.stringify(person.sourcePaths ?? []), person.isArchiveOwner ? 1 : 0] });
      for (const [index, path] of (person.sourcePaths ?? []).entries()) db.exec({ sql: 'INSERT OR IGNORE INTO person_sources(person_id,source_path,source_index,archive_part_id) VALUES(?,?,?,?)', bind: [person.id, path, null, person.sourcePartIds?.[index] ?? partIdFor({})] });
    }
    batchInsert('posts', ['id', 'author_id', 'title', 'body', 'created_at', 'links', 'source_path', 'source_index', 'archive_part_id'], data.posts.map(post => [post.id, post.authorId ?? null, post.title ?? null, post.text ?? null, post.createdAt ?? null, JSON.stringify(post.links ?? []), post.source.path, post.source.index ?? null, partIdFor(post.source)]));
    batchInsert('comments', ['id', 'post_id', 'author_id', 'author_name', 'body', 'created_at', 'source_path', 'source_index', 'archive_part_id'], data.comments.map(comment => [comment.id, comment.postId, comment.authorId ?? null, comment.authorName ?? null, comment.text, comment.createdAt ?? null, comment.source.path, comment.source.index ?? null, partIdFor(comment.source)]));
    batchInsert('reactions', ['id', 'target_type', 'target_id', 'person_id', 'person_name', 'kind', 'created_at', 'source_path', 'source_index', 'archive_part_id'], data.reactions.map(reaction => [reaction.id, reaction.targetType, reaction.targetId, reaction.personId ?? null, reaction.personName ?? null, reaction.kind, reaction.createdAt ?? null, reaction.source.path, reaction.source.index ?? null, partIdFor(reaction.source)]));
    batchInsert('connections', ['id', 'person_id', 'display_name', 'facebook_id', 'username', 'profile_url', 'relationship_type', 'started_at', 'ended_at', 'source_path', 'source_index', 'archive_part_id'], data.connections.map(connection => [connection.id, connection.personId, connection.displayName, connection.facebookId ?? null, connection.username ?? null, connection.profileUrl ?? null, connection.type, connection.startedAt ?? null, connection.endedAt ?? null, connection.source.path, connection.source.index ?? null, partIdFor(connection.source)]));
    batchInsert('albums', ['id', 'title', 'description', 'owner_id', 'created_at', 'updated_at', 'source_path', 'source_index', 'archive_part_id'], data.albums.map(album => [album.id, album.title, album.description ?? null, album.ownerId ?? null, album.createdAt ?? null, album.updatedAt ?? null, album.source.path, album.source.index ?? null, partIdFor(album.source)]));
    batchInsert('album_media', ['album_id', 'media_id', 'position'], data.albums.flatMap(album => album.mediaIds.map((mediaId, position) => [album.id, mediaId, position])), 'OR IGNORE');
    batchInsert('profile_facts', ['id', 'profile_id', 'category', 'label', 'value', 'start_date', 'end_date', 'source_path', 'source_index', 'archive_part_id'], data.profileFacts.map(fact => [fact.id, data.profile?.id ?? 'owner', fact.category, fact.label ?? null, fact.value, fact.startDate ?? null, fact.endDate ?? null, fact.source.path, fact.source.index ?? null, partIdFor(fact.source)]));
    batchInsert('conversations', ['id', 'title', 'participant_names', 'source_path', 'is_group', 'participant_ids', 'archive_part_id'], data.conversations.map(conversation => [conversation.id, conversation.title ?? null, JSON.stringify(conversation.participantNames), conversation.source.path, conversation.participantNames.length > 2 ? 1 : 0, JSON.stringify(conversation.participantIds), partIdFor(conversation.source)]));
    batchInsert('messages', ['id', 'conversation_id', 'sender_name', 'body', 'sent_at', 'source_path', 'source_index', 'sender_id', 'archive_part_id'], data.messages.map(message => [message.id, message.conversationId, message.senderName ?? null, message.text ?? null, message.sentAt ?? null, message.source.path, message.source.index ?? null, message.senderId ?? null, partIdFor(message.source)]));
    batchInsert('media', ['id', 'path', 'media_type', 'filename', 'mime_type', 'caption', 'timestamp', 'owner_type', 'owner_id', 'width', 'height', 'duration_ms', 'source_path', 'source_index', 'archive_part_id'], data.media.map(item => [item.id, item.path, item.mediaType, item.filename ?? null, item.mimeType ?? null, item.caption ?? null, item.timestamp ?? null, item.ownerType, item.ownerId, item.width ?? null, item.height ?? null, item.durationMs ?? null, item.source.path, item.source.index ?? null, partIdFor(item.source)]));
    const metadata: [string, string][] = [['warning_count', String(data.warnings.length)], ['section_count', String(data.importedSections?.length ?? 0)], ['sections', JSON.stringify(data.importedSections ?? [])], ['diagnostics', JSON.stringify(data.diagnostics ?? null)]];
    for (const [key, value] of metadata) db.exec({ sql: 'INSERT INTO import_metadata(key,value) VALUES(?,?)', bind: [key, value] });
    if (data.archiveIdentity) db.exec({ sql: 'INSERT INTO archive_identity(id,filename,size,entry_count,fingerprint,known_entries) VALUES(1,?,?,?,?,?)', bind: [data.archiveIdentity.filename, data.archiveIdentity.size, data.archiveIdentity.entryCount, data.archiveIdentity.fingerprint, JSON.stringify(data.archiveIdentity.knownEntries)] });
  });
  // Rebuild derived rows from the normalized SQLite tables. Keeping this
  // path set-based is important for callers that still use the legacy
  // replace API with a large archive payload.
  rebuildSearchFromTables();
  rebuildActivityIndex();
  fallbackData = metadataSnapshot(data);
  const archive = archiveSet;
  if (archive) {
    const now = new Date().toISOString(); const counts = countData(data); counts.activities = Number(rows('SELECT COUNT(*) count FROM activity_records')[0]?.count ?? 0);
    const session: ImportSession = { id: sessionIdForArchive(archive.id), archiveSetId: archive.id, startedAt: now, updatedAt: now, parserVersion: FACEBOOK_PARSER_VERSION, schemaVersion: SCHEMA_VERSION, expectedPartCount: parts.length, inspectedPartCount: parts.length, importedPartCount: parts.length, failedPartCount: 0, skippedPartCount: 0, currentStage: archive.status === 'complete' ? 'complete' : 'interrupted', status: archive.status === 'complete' ? 'complete' : 'interrupted', normalizedCounts: counts, warningsCount: data.warnings.length, detectedSections: data.coverage?.detectedSections ?? data.importedSections ?? [], importedSections: data.coverage?.importedSections ?? data.importedSections ?? [], coverage: data.coverage, sourceStatus: archive.status === 'complete' ? 'complete' : 'incomplete', derivedStatus: archive.status === 'complete' ? 'complete' : 'pending', derivedPhase: archive.status === 'complete' ? 'complete' : undefined, derivedRows: archive.status === 'complete' ? counts.activities : 0, derivedTotal: archive.status === 'complete' ? counts.activities : 0 };
    transaction(() => { upsertSession(session); for (const part of parts) db.exec({ sql: 'INSERT OR REPLACE INTO import_part_checkpoints(session_id,archive_part_id,part_index,manifest_fingerprint,status,updated_at,completed_at,parser_version,record_counts,warnings_count,sections) VALUES(?,?,?,?,?,?,?,?,?,?,?)', bind: [session.id, part.id, part.partIndex, part.manifestFingerprint, part.status === 'failed' ? 'failed' : 'complete', now, part.status === 'failed' ? null : now, FACEBOOK_PARSER_VERSION, JSON.stringify(counts), 0, JSON.stringify(part.sections ?? [])] }); });
  }
  db.exec('PRAGMA optimize');
}

const ARCHIVE_DATA_TABLES = ['activity_records', 'comments', 'reactions', 'album_media', 'albums', 'profile_facts', 'messages', 'conversations', 'posts', 'profiles', 'media', 'people', 'person_sources', 'source_records', 'import_metadata', 'archive_identity', 'archive_parts', 'archive_sets', 'import_part_checkpoints', 'import_section_status', 'diagnostic_warning_groups', 'derived_index_jobs', 'import_sessions'];
function clearArchiveData() {
  transaction(() => ARCHIVE_DATA_TABLES.forEach(table => db.exec(`DELETE FROM ${table}`)));
  db.exec('DELETE FROM search_documents');
  if (searchBackend === 'fts5') db.exec('DELETE FROM archive_fts');
  fallbackData = undefined;
}

const sectionPriority: Record<ImportSectionStatus['status'], number> = { detected: 1, imported: 2, partial: 3, malformed: 4, unsupported: 4, skipped: 4 };
function updateSectionStatuses(sessionId: string, data: NormalizedArchiveData, now: string) {
  const coverage = data.coverage;
  const detected = new Set(coverage?.detectedSections ?? data.importedSections ?? []);
  const imported = new Set(coverage?.importedSections ?? data.importedSections ?? []);
  const partial = new Set(coverage?.partialSections ?? []);
  const malformed = new Set(coverage?.malformedSections ?? []);
  const unsupported = new Set(coverage?.unsupportedSections ?? []);
  const sections = [...new Set([...detected, ...imported, ...partial, ...malformed, ...unsupported])];
  for (const section of sections) {
    const status: ImportSectionStatus['status'] = unsupported.has(section) ? 'unsupported' : malformed.has(section) ? 'malformed' : partial.has(section) ? 'partial' : imported.has(section) ? 'imported' : 'detected';
    const prior = rows('SELECT status,record_count recordCount,warning_count warningCount FROM import_section_status WHERE session_id=? AND section=?', [sessionId, section])[0];
    const priorStatus = prior ? String(prior.status) as ImportSectionStatus['status'] : 'detected';
    const nextStatus = sectionPriority[priorStatus] > sectionPriority[status] ? priorStatus : status;
    const recordCount = Number(prior?.recordCount ?? 0) + (section === 'Profile' && data.profile ? 1 : section === 'Posts' ? data.posts.length : section === 'Comments' ? data.comments.length : section === 'Reactions' ? data.reactions.length : section === 'Friends' ? data.connections.length : section === 'Albums' ? data.albums.length : section === 'Messages' ? data.messages.length : section === 'Photos' ? data.media.length : 0);
    const warningCount = Number(prior?.warningCount ?? 0) + (data.warningGroups ?? []).filter(group => group.sourcePaths.some(path => path.toLowerCase().includes(section.toLowerCase()))).reduce((sum, group) => sum + group.count, 0);
    db.exec({ sql: 'INSERT OR REPLACE INTO import_section_status(session_id,section,parser_version,status,record_count,warning_count,updated_at) VALUES(?,?,?,?,?,?,?)', bind: [sessionId, section, FACEBOOK_PARSER_VERSION, nextStatus, recordCount, warningCount, now] });
  }
}
function updateWarningGroups(sessionId: string, groups: NormalizedArchiveData['warningGroups'] = []) {
  for (const group of groups) {
    const prior = rows('SELECT occurrence_count occurrenceCount,source_paths sourcePaths FROM diagnostic_warning_groups WHERE session_id=? AND category=? AND message=?', [sessionId, group.category, group.message])[0];
    const sourcePaths = [...new Set([...json<string[]>(prior?.sourcePaths, []), ...group.sourcePaths])].slice(0, 32);
    db.exec({ sql: 'INSERT OR REPLACE INTO diagnostic_warning_groups(session_id,category,message,occurrence_count,source_paths) VALUES(?,?,?,?,?)', bind: [sessionId, group.category, group.message, Number(prior?.occurrenceCount ?? 0) + group.count, JSON.stringify(sourcePaths)] });
  }
}
function mergeDiagnostics(existing: ImportDiagnostics | undefined, incoming: ImportDiagnostics | undefined): ImportDiagnostics | undefined {
  if (!existing && !incoming) return undefined;
  const left = existing ?? { candidateFiles: 0, parsedFiles: 0, unsupportedCandidates: 0, malformedFiles: 0, missingMedia: 0, incompleteIdentities: 0 };
  const right = incoming ?? { candidateFiles: 0, parsedFiles: 0, unsupportedCandidates: 0, malformedFiles: 0, missingMedia: 0, incompleteIdentities: 0 };
  const incomingFormat = right.sourceFormat && right.sourceFormat !== 'unknown' ? right.sourceFormat : undefined;
  const sourceFormat = incomingFormat ? !left.sourceFormat ? incomingFormat : left.sourceFormat === incomingFormat ? left.sourceFormat : 'mixed' : left.sourceFormat;
  return { candidateFiles: left.candidateFiles + right.candidateFiles, parsedFiles: left.parsedFiles + right.parsedFiles, unsupportedCandidates: left.unsupportedCandidates + right.unsupportedCandidates, malformedFiles: left.malformedFiles + right.malformedFiles, missingMedia: left.missingMedia + right.missingMedia, incompleteIdentities: left.incompleteIdentities + right.incompleteIdentities, htmlCandidateFiles: (left.htmlCandidateFiles ?? 0) + (right.htmlCandidateFiles ?? 0), htmlParsedFiles: (left.htmlParsedFiles ?? 0) + (right.htmlParsedFiles ?? 0), htmlRecordCount: (left.htmlRecordCount ?? 0) + (right.htmlRecordCount ?? 0), sourceFormat, shapeSignatures: [...new Set([...(left.shapeSignatures ?? []), ...(right.shapeSignatures ?? [])])].slice(0, 100), detectedSections: [...new Set([...(left.detectedSections ?? []), ...(right.detectedSections ?? [])])], unsupportedSections: [...new Set([...(left.unsupportedSections ?? []), ...(right.unsupportedSections ?? [])])] };
}
function appendFallbackSnapshot(data: NormalizedArchiveData) {
  // Normalized rows already live in SQLite. Keep only small metadata here;
  // retaining every message/media object would defeat the bounded producer /
  // consumer queue on browsers using the IndexedDB fallback.
  const prior = fallbackData ?? normalizedData({});
  if (data.profile && !prior.profile) prior.profile = data.profile;
  prior.importedSections = [...new Set([...(prior.importedSections ?? []), ...(data.importedSections ?? [])])];
  prior.diagnostics = mergeDiagnostics(prior.diagnostics, data.diagnostics);
  prior.archiveSet = prior.archiveSet ?? data.archiveSet; prior.archiveIdentity = prior.archiveIdentity ?? data.archiveIdentity;
  prior.sourceFormat = prior.sourceFormat ?? data.sourceFormat;
  prior.warnings = [...new Set([...(prior.warnings ?? []), ...(data.warnings ?? [])])].slice(0, 200);
  fallbackData = prior;
  if (data.archiveParts?.length) {
    const parts = new Map((fallbackData.archiveParts ?? []).map(part => [part.id, part]));
    data.archiveParts.forEach(part => parts.set(part.id, { ...parts.get(part.id), ...part }));
    fallbackData.archiveParts = [...parts.values()];
  }
  fallbackData.coverage = data.coverage ?? fallbackData.coverage;
  fallbackData.warningGroups = data.warningGroups ?? fallbackData.warningGroups;
  fallbackData.performance = data.performance ?? fallbackData.performance;
}
function importPartData(dataInput: NormalizedArchiveData, part: ArchivePart, sessionId: string, finalize = true, collectFallback = mode === 'indexeddb'): ImportPartCheckpoint {
  const data = normalizedData(dataInput); const now = new Date().toISOString();
  // Batch writes do not need to rebuild the complete session/checkpoint state
  // for every acknowledgement. A single-row lookup keeps the acknowledgement
  // path cheap while final part completion still performs the full state fold.
  const existing = finalize
    ? currentImportState(sessionId).checkpoints.find(checkpoint => checkpoint.archivePartId === part.id)
    : (() => {
      const row = rows('SELECT session_id sessionId,archive_part_id archivePartId,part_index partIndex,manifest_fingerprint manifestFingerprint,status,started_at startedAt,updated_at updatedAt,completed_at completedAt,parser_version parserVersion,record_counts recordCounts,warnings_count warningsCount,error,sections FROM import_part_checkpoints WHERE session_id=? AND archive_part_id=? LIMIT 1', [sessionId, part.id])[0];
      return row ? checkpointFromRow(row) : undefined;
    })();
  if (existing?.status === 'complete' || existing?.status === 'skipped') return existing;
  const recordCounts = countData(data); const partWarningCount = data.warningGroups?.reduce((sum, group) => sum + group.count, 0) ?? data.warnings.length;
  // The parser hands the database one part at a time. Keep the logical set
  // metadata created by beginImportSession instead of accidentally replacing
  // it with a one-part fallback for every checkpoint. Batch writes do not need
  // to read or rewrite that metadata at all.
  const savedArchiveSet = finalize ? archiveSetFromRow(rows('SELECT id,platform,created_at createdAt,part_count partCount,total_size totalSize,fingerprint,imported_at importedAt,status,source_format sourceFormat FROM archive_sets WHERE id=? LIMIT 1', [part.archiveId])[0]) ?? archiveSetFromRow(rows('SELECT id,platform,created_at createdAt,part_count partCount,total_size totalSize,fingerprint,imported_at importedAt,status,source_format sourceFormat FROM archive_sets ORDER BY created_at DESC LIMIT 1')[0]) : undefined;
  const archiveSet = finalize ? data.archiveSet ?? savedArchiveSet ?? { id: part.archiveId, platform: 'facebook' as const, createdAt: Date.now(), partCount: 1, totalSize: part.fileSize, fingerprint: part.manifestFingerprint, status: 'incomplete' as const } : undefined;
  // Activity is a derived stage, not part of the source commit. Deferring it
  // avoids rebuilding/allocating a second record for every message while ZIP
  // parts are still arriving; the resumable activity job runs after base data
  // is complete.
  recordCounts.activities = 0;
  const persistStartedAt = performance.now();
  transaction(() => {
    if (finalize && archiveSet) {
      db.exec({ sql: 'INSERT OR IGNORE INTO archive_sets(id,platform,created_at,part_count,total_size,fingerprint,imported_at,status,source_format) VALUES(?,?,?,?,?,?,?,?,?)', bind: [archiveSet.id, archiveSet.platform, archiveSet.createdAt, archiveSet.partCount, archiveSet.totalSize, archiveSet.fingerprint, null, 'incomplete', archiveSet.sourceFormat ?? data.sourceFormat ?? null] });
      db.exec({ sql: 'UPDATE archive_sets SET part_count=?,total_size=?,status=? WHERE id=?', bind: [archiveSet.partCount, archiveSet.totalSize, 'incomplete', archiveSet.id] });
      db.exec({ sql: 'INSERT OR REPLACE INTO archive_parts(id,archive_id,part_index,filename,file_size,entry_count,manifest_fingerprint,connected,status,warning_count,sections,source_format) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)', bind: [part.id, archiveSet.id, part.partIndex, part.filename, part.fileSize, part.entryCount, part.manifestFingerprint, part.connected ? 1 : 0, 'complete', partWarningCount, JSON.stringify(part.sections ?? data.importedSections ?? []), part.sourceFormat ?? data.sourceFormat ?? null] });
    } else if (!existing || existing.status !== 'importing') {
      db.exec({ sql: 'UPDATE archive_parts SET status=? WHERE id=?', bind: ['importing', part.id] });
    }
    if (data.profile) {
      db.exec({ sql: 'INSERT OR REPLACE INTO profiles(id,person_id,display_name,username,bio,joined_at,source_path) VALUES(?,?,?,?,?,?,?)', bind: [data.profile.id, data.profile.personId, data.profile.displayName, data.profile.username ?? null, data.profile.bio ?? null, data.profile.joinedAt ?? null, data.profile.source.path] });
      db.exec({ sql: 'INSERT OR REPLACE INTO source_records(entity_type,entity_id,archive_part_id) VALUES(?,?,?)', bind: ['profile', data.profile.id, part.id] });
    }
    for (const person of data.people) {
      const prior = rows('SELECT source_paths sourcePaths FROM people WHERE id=?', [person.id])[0];
      const sourcePaths = [...new Set([...json<string[]>(prior?.sourcePaths, []), ...(person.sourcePaths ?? [])])];
      db.exec({ sql: 'INSERT OR REPLACE INTO people(id,facebook_id,display_name,username,profile_url,profile_photo_path,cover_photo_path,first_seen,last_seen,relationship,identity_confidence,identity_source,source_paths,is_archive_owner) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)', bind: [person.id, person.facebookId ?? null, person.displayName, person.username ?? null, person.profileUrl ?? null, person.profilePhotoPath ?? null, person.coverPhotoPath ?? null, person.firstSeen ?? null, person.lastSeen ?? null, person.relationship ?? null, person.identityConfidence ?? null, person.identitySource ?? null, JSON.stringify(sourcePaths), person.isArchiveOwner ? 1 : 0] });
      sourcePaths.forEach(path => db.exec({ sql: 'INSERT OR IGNORE INTO person_sources(person_id,source_path,source_index,archive_part_id) VALUES(?,?,?,?)', bind: [person.id, path, null, part.id] }));
    }
    batchInsert('posts', ['id', 'author_id', 'title', 'body', 'created_at', 'links', 'source_path', 'source_index', 'archive_part_id'], data.posts.map(post => [post.id, post.authorId ?? null, post.title ?? null, post.text ?? null, post.createdAt ?? null, JSON.stringify(post.links ?? []), post.source.path, post.source.index ?? null, part.id]), 'OR IGNORE');
    batchInsert('comments', ['id', 'post_id', 'author_id', 'author_name', 'body', 'created_at', 'source_path', 'source_index', 'archive_part_id'], data.comments.map(comment => [comment.id, comment.postId, comment.authorId ?? null, comment.authorName ?? null, comment.text, comment.createdAt ?? null, comment.source.path, comment.source.index ?? null, part.id]), 'OR IGNORE');
    batchInsert('reactions', ['id', 'target_type', 'target_id', 'person_id', 'person_name', 'kind', 'created_at', 'source_path', 'source_index', 'archive_part_id'], data.reactions.map(reaction => [reaction.id, reaction.targetType, reaction.targetId, reaction.personId ?? null, reaction.personName ?? null, reaction.kind, reaction.createdAt ?? null, reaction.source.path, reaction.source.index ?? null, part.id]), 'OR IGNORE');
    batchInsert('connections', ['id', 'person_id', 'display_name', 'facebook_id', 'username', 'profile_url', 'relationship_type', 'started_at', 'ended_at', 'source_path', 'source_index', 'archive_part_id'], data.connections.map(connection => [connection.id, connection.personId, connection.displayName, connection.facebookId ?? null, connection.username ?? null, connection.profileUrl ?? null, connection.type, connection.startedAt ?? null, connection.endedAt ?? null, connection.source.path, connection.source.index ?? null, part.id]), 'OR IGNORE');
    batchInsert('albums', ['id', 'title', 'description', 'owner_id', 'created_at', 'updated_at', 'source_path', 'source_index', 'archive_part_id'], data.albums.map(album => [album.id, album.title, album.description ?? null, album.ownerId ?? null, album.createdAt ?? null, album.updatedAt ?? null, album.source.path, album.source.index ?? null, part.id]), 'OR IGNORE');
    batchInsert('album_media', ['album_id', 'media_id', 'position'], data.albums.flatMap(album => album.mediaIds.map((mediaId, position) => [album.id, mediaId, position])), 'OR IGNORE');
    batchInsert('profile_facts', ['id', 'profile_id', 'category', 'label', 'value', 'start_date', 'end_date', 'source_path', 'source_index', 'archive_part_id'], data.profileFacts.map(fact => [fact.id, data.profile?.id ?? 'owner', fact.category, fact.label ?? null, fact.value, fact.startDate ?? null, fact.endDate ?? null, fact.source.path, fact.source.index ?? null, part.id]), 'OR IGNORE');
    for (const conversation of data.conversations) {
      const prior = rows('SELECT participant_names participantNames,participant_ids participantIds,title FROM conversations WHERE id=?', [conversation.id])[0];
      const names = [...new Set([...json<string[]>(prior?.participantNames, []), ...conversation.participantNames])], ids = [...new Set([...json<string[]>(prior?.participantIds, []), ...conversation.participantIds])];
      db.exec({ sql: 'INSERT OR REPLACE INTO conversations(id,title,participant_names,source_path,is_group,participant_ids,archive_part_id) VALUES(?,?,?,?,?,?,?)', bind: [conversation.id, prior?.title ?? conversation.title ?? null, JSON.stringify(names), conversation.source.path, names.length > 2 ? 1 : 0, JSON.stringify(ids), part.id] });
    }
    batchInsert('messages', ['id', 'conversation_id', 'sender_name', 'body', 'sent_at', 'source_path', 'source_index', 'sender_id', 'archive_part_id'], data.messages.map(message => [message.id, message.conversationId, message.senderName ?? null, message.text ?? null, message.sentAt ?? null, message.source.path, message.source.index ?? null, message.senderId ?? null, part.id]), 'OR IGNORE');
    batchInsert('media', ['id', 'path', 'media_type', 'filename', 'mime_type', 'caption', 'timestamp', 'owner_type', 'owner_id', 'width', 'height', 'duration_ms', 'source_path', 'source_index', 'archive_part_id'], data.media.map(item => [item.id, item.path, item.mediaType, item.filename ?? null, item.mimeType ?? null, item.caption ?? null, item.timestamp ?? null, item.ownerType, item.ownerId, item.width ?? null, item.height ?? null, item.durationMs ?? null, item.source.path, item.source.index ?? null, item.source.archivePartId ?? part.id]), 'OR IGNORE');
    if (finalize) {
      const warningCount = Number(rows("SELECT value FROM import_metadata WHERE key='warning_count'")[0]?.value ?? 0) + partWarningCount;
      db.exec({ sql: 'INSERT OR REPLACE INTO import_metadata(key,value) VALUES(?,?)', bind: ['warning_count', String(warningCount)] });
      const cumulativeDiagnostics = mergeDiagnostics(json<ImportDiagnostics | undefined>(rows("SELECT value FROM import_metadata WHERE key='diagnostics'")[0]?.value, undefined), data.diagnostics);
      db.exec({ sql: 'INSERT OR REPLACE INTO import_metadata(key,value) VALUES(?,?)', bind: ['diagnostics', JSON.stringify(cumulativeDiagnostics ?? null)] });
      db.exec({ sql: 'INSERT OR REPLACE INTO import_metadata(key,value) VALUES(?,?)', bind: ['sections', JSON.stringify([...new Set([...json<string[]>(rows("SELECT value FROM import_metadata WHERE key='sections'")[0]?.value, []), ...(data.importedSections ?? [])])])] });
      db.exec({ sql: 'INSERT OR REPLACE INTO import_metadata(key,value) VALUES(?,?)', bind: ['section_count', String(rows("SELECT value FROM import_metadata WHERE key='sections'")[0] ? json<string[]>(rows("SELECT value FROM import_metadata WHERE key='sections'")[0].value, []).length : (data.importedSections?.length ?? 0))] });
      db.exec({ sql: 'INSERT OR REPLACE INTO import_metadata(key,value) VALUES(?,?)', bind: ['warnings', JSON.stringify([...new Set([...json<string[]>(rows("SELECT value FROM import_metadata WHERE key='warnings'")[0]?.value, []), ...data.warnings])].slice(0, 200))] });
      updateSectionStatuses(sessionId, data, now);
      updateWarningGroups(sessionId, data.warningGroups ?? data.diagnostics?.warningGroups ?? []);
    }
    // The importer resolves each media reference to its owning ZIP part before
    // this transaction. If a later pass needs to repair provenance, update by
    // the media primary key; a path lookup would scan the growing media table
    // once per reference and turns large HTML imports into an O(n²) workload.
    for (const item of data.media) if (item.source.archivePartId && item.source.archivePartId !== part.id) db.exec({ sql: 'UPDATE media SET archive_part_id=? WHERE id=?', bind: [item.source.archivePartId, item.id] });
    if (finalize) db.exec({ sql: 'INSERT OR REPLACE INTO import_part_checkpoints(session_id,archive_part_id,part_index,manifest_fingerprint,status,started_at,updated_at,completed_at,parser_version,record_counts,warnings_count,sections) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)', bind: [sessionId, part.id, part.partIndex, part.manifestFingerprint, 'complete', now, now, now, FACEBOOK_PARSER_VERSION, JSON.stringify(recordCounts), partWarningCount, JSON.stringify(data.importedSections ?? part.sections ?? [])] });
  });
  const persistDurationMs = performance.now() - persistStartedAt;
  databaseWriteDurationMs += persistDurationMs;
  databaseWriteBatchCount += 1;
  if (persistDurationMs > 300) sqliteBatchSize = Math.max(SQLITE_MIN_BATCH_SIZE, Math.floor(sqliteBatchSize * 0.75));
  else if (persistDurationMs < 60) sqliteBatchSize = Math.min(SQLITE_MAX_BATCH_SIZE, sqliteBatchSize + 250);
  const state = finalize ? currentImportState(sessionId) : undefined; if (finalize && state?.session) {
    const counts = { ...emptyCounts() }; for (const [key, table] of Object.entries({ profiles: 'profiles', people: 'people', posts: 'posts', comments: 'comments', reactions: 'reactions', connections: 'connections', albums: 'albums', conversations: 'conversations', messages: 'messages', media: 'media', activities: 'activity_records' })) counts[key as keyof ImportCounts] = Number(rows(`SELECT COUNT(*) count FROM ${table}`)[0]?.count ?? 0);
    const checkpoints = state.checkpoints; const failed = checkpoints.filter(item => item.status === 'failed'); const skipped = checkpoints.filter(item => item.status === 'skipped');
    const previousMetrics = state.session.metrics ?? {}; const partDuration = data.performance?.totalDurationMs ?? data.diagnostics?.performance?.totalDurationMs; const sectionCounts = { ...(previousMetrics.sectionCounts ?? {}) }; for (const [section, value] of Object.entries(data.performance?.sectionCounts ?? {})) sectionCounts[section] = (sectionCounts[section] ?? 0) + value;
    const stageDurationsMs = { ...(previousMetrics.stageDurationsMs ?? {}), database: Math.round((previousMetrics.stageDurationsMs?.database ?? 0) + databaseWriteDurationMs) };
    const stageCounts = { ...(previousMetrics.stageCounts ?? {}), databaseBatches: (previousMetrics.stageCounts?.databaseBatches ?? 0) + databaseWriteBatchCount };
    upsertSession({ ...state.session, updatedAt: now, currentStage: 'parsing', status: 'importing', importedPartCount: checkpoints.filter(item => item.status === 'complete').length, failedPartCount: failed.length, skippedPartCount: skipped.length, normalizedCounts: counts, warningsCount: Number(rows("SELECT value FROM import_metadata WHERE key='warning_count'")[0]?.value ?? 0), failedPartIds: failed.map(item => item.archivePartId), skippedPartIds: skipped.map(item => item.archivePartId), sourceStatus: 'importing', derivedStatus: 'pending', derivedPhase: undefined, derivedRows: 0, derivedTotal: 0, derivedUpdatedAt: now, derivedError: undefined, metrics: { ...previousMetrics, totalDurationMs: (previousMetrics.totalDurationMs ?? 0) + (partDuration ?? 0), partDurationsMs: { ...(previousMetrics.partDurationsMs ?? {}), [part.id]: partDuration ?? 0 }, sectionCounts, stageDurationsMs, stageCounts, batchSize: Math.max(previousMetrics.batchSize ?? 0, data.performance?.batchSize ?? 0) || undefined, batchCount: (previousMetrics.batchCount ?? 0) + (data.performance?.batchCount ?? 0) } });
    databaseWriteDurationMs = 0;
    databaseWriteBatchCount = 0;
  }
  if (finalize && data.performance) {
    const persisted = currentImportState(sessionId).session;
    if (persisted) {
      const metrics = persisted.metrics ?? {};
      const stageDurationsMs = { ...(metrics.stageDurationsMs ?? {}) };
      for (const [stage, duration] of Object.entries(data.performance.stageDurationsMs ?? {})) stageDurationsMs[stage] = (stageDurationsMs[stage] ?? 0) + duration;
      const stageCounts = { ...(metrics.stageCounts ?? {}) };
      for (const [stage, count] of Object.entries(data.performance.stageCounts ?? {})) stageCounts[stage] = (stageCounts[stage] ?? 0) + count;
      upsertSession({ ...persisted, metrics: { ...metrics, stageDurationsMs, stageCounts } });
    }
  }
  if (finalize) resetDerivedJobs(sessionId, true);
  if (collectFallback) {
    if (finalize) {
      const merged = mergeNormalizedData([...(fallbackData ? [fallbackData] : []), data]);
      const persistedSet = archiveSetFromRow(rows('SELECT id,platform,created_at createdAt,part_count partCount,total_size totalSize,fingerprint,imported_at importedAt,status,source_format sourceFormat FROM archive_sets ORDER BY created_at DESC LIMIT 1')[0]);
      const persistedParts = rows('SELECT id,archive_id archiveId,part_index partIndex,filename,file_size fileSize,entry_count entryCount,manifest_fingerprint manifestFingerprint,connected,status,warning_count warningCount,sections,source_format sourceFormat FROM archive_parts ORDER BY part_index,id').map(archivePartFromRow);
      const persistedIdentity = identityFromRow(rows('SELECT filename,size,entry_count entryCount,fingerprint,known_entries knownEntries FROM archive_identity WHERE id=1')[0]);
      fallbackData = metadataSnapshot({ ...merged, archiveSet: persistedSet as ArchiveSet | undefined, archiveParts: persistedParts, archiveIdentity: persistedIdentity ?? merged.archiveIdentity ?? data.archiveIdentity });
    } else appendFallbackSnapshot(data);
  }
  if (!finalize) return { ...(existing ?? { sessionId, archivePartId: part.id, partIndex: part.partIndex, manifestFingerprint: part.manifestFingerprint, status: 'pending' as const, updatedAt: now, parserVersion: FACEBOOK_PARSER_VERSION, warningsCount: 0, sections: part.sections ?? [] }), status: 'importing', updatedAt: now, recordCounts, warningsCount: partWarningCount };
  return currentImportState(sessionId).checkpoints.find(checkpoint => checkpoint.archivePartId === part.id)!;
}

/** Persist one bounded parser batch without completing its ZIP checkpoint. */
function importBatchData(dataInput: NormalizedArchiveData, part: ArchivePart, sessionId: string): ImportPartCheckpoint {
  return importPartData(dataInput, part, sessionId, false);
}

function beginImportSession(sessionInput?: ImportSession, parts: ArchivePart[] = [], archiveSet?: NormalizedArchiveData['archiveSet'], archiveIdentity?: ArchiveIdentity) {
  const now = new Date().toISOString();
  const set = archiveSet ?? (parts[0] ? { id: archiveSetId(archiveSetFingerprint(parts)), platform: 'facebook' as const, createdAt: Date.now(), partCount: parts.length, totalSize: parts.reduce((sum, part) => sum + part.fileSize, 0), fingerprint: archiveSetFingerprint(parts), status: 'incomplete' as const } : undefined);
  if (!set) throw new Error('Archive set metadata is required to start an import.');
  const existingSet = rows('SELECT id FROM archive_sets ORDER BY created_at DESC LIMIT 1')[0];
  if (existingSet && String(existingSet.id) !== set.id) clearArchiveData();
  const session: ImportSession = sessionInput ?? { id: sessionIdForArchive(set.id), archiveSetId: set.id, startedAt: now, updatedAt: now, parserVersion: FACEBOOK_PARSER_VERSION, schemaVersion: SCHEMA_VERSION, expectedPartCount: parts.length || set.partCount, inspectedPartCount: 0, importedPartCount: 0, failedPartCount: 0, skippedPartCount: 0, currentStage: 'inspection', status: 'new', normalizedCounts: emptyCounts(), warningsCount: 0, detectedSections: [], importedSections: [], sourceStatus: 'pending', derivedStatus: 'pending' };
  const existingIdentity = identityFromRow(rows('SELECT filename,size,entry_count entryCount,fingerprint,known_entries knownEntries FROM archive_identity WHERE id=1')[0]);
  const identity: ArchiveIdentity | undefined = archiveIdentity ?? (existingIdentity?.fingerprint === set.fingerprint ? existingIdentity : parts.length ? {
    filename: parts.length === 1 ? parts[0].filename : `${parts.length} Facebook ZIP parts`,
    size: set.totalSize,
    entryCount: parts.reduce((sum, part) => sum + part.entryCount, 0),
    fingerprint: set.fingerprint,
    knownEntries: [...new Set(parts.flatMap(part => part.sections ?? []))].slice(0, 80),
  } : undefined);
  transaction(() => {
    upsertSession({ ...session, archiveSetId: set.id, expectedPartCount: parts.length || session.expectedPartCount, updatedAt: now, currentStage: session.status === 'complete' ? 'complete' : session.currentStage, status: session.status, sourceStatus: session.sourceStatus ?? 'pending', derivedStatus: session.derivedStatus ?? 'pending' });
    for (const part of parts) db.exec({ sql: 'INSERT OR IGNORE INTO import_part_checkpoints(session_id,archive_part_id,part_index,manifest_fingerprint,status,updated_at,parser_version,record_counts,warnings_count,sections) VALUES(?,?,?,?,?,?,?,?,?,?)', bind: [session.id, part.id, part.partIndex, part.manifestFingerprint, 'pending', now, FACEBOOK_PARSER_VERSION, JSON.stringify({}), 0, JSON.stringify(part.sections ?? [])] });
    db.exec({ sql: 'INSERT OR IGNORE INTO archive_sets(id,platform,created_at,part_count,total_size,fingerprint,imported_at,status,source_format) VALUES(?,?,?,?,?,?,?,?,?)', bind: [set.id, set.platform, set.createdAt, set.partCount, set.totalSize, set.fingerprint, null, 'incomplete', set.sourceFormat ?? null] });
    if (identity) db.exec({ sql: 'INSERT OR REPLACE INTO archive_identity(id,filename,size,entry_count,fingerprint,known_entries) VALUES(1,?,?,?,?,?)', bind: [identity.filename, identity.size, identity.entryCount, identity.fingerprint, JSON.stringify(identity.knownEntries)] });
    for (const part of parts) db.exec({ sql: 'INSERT OR REPLACE INTO archive_parts(id,archive_id,part_index,filename,file_size,entry_count,manifest_fingerprint,connected,status,warning_count,sections,source_format) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)', bind: [part.id, set.id, part.partIndex, part.filename, part.fileSize, part.entryCount, part.manifestFingerprint, part.connected ? 1 : 0, part.status ?? 'pending', part.warningCount ?? 0, JSON.stringify(part.sections ?? []), part.sourceFormat ?? set.sourceFormat ?? null] });
    for (const kind of ['search', 'activity'] as const) db.exec({ sql: 'INSERT OR IGNORE INTO derived_index_jobs(session_id,kind,status,phase,cursor,rows_processed,total_rows,batch_size,started_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)', bind: [session.id, kind, 'pending', 'pending', null, 0, 0, DERIVED_BATCH_SIZE, now, now] });
  });
  // Keep archive identity and part metadata in the IndexedDB snapshot even if
  // cancellation happens before the first normalized batch is acknowledged.
  // Without this seed, a reload could restore records but lose the resumable
  // archive-set shell that tells the UI which ZIP parts are still needed.
  if (mode === 'indexeddb') {
    const base = fallbackData ?? metadataSnapshot({});
    fallbackData = { ...base, archiveSet: set, archiveParts: parts, archiveIdentity: identity ?? base.archiveIdentity, sourceFormat: set.sourceFormat ?? base.sourceFormat };
  }
  return currentImportState(session.id);
}

function updateImportSession(sessionId: string, patch: Partial<ImportSession>) {
  const current = currentImportState(sessionId).session; if (!current) throw new Error('Import session not found.');
  const session = { ...current, ...patch, id: current.id, updatedAt: new Date().toISOString(), normalizedCounts: patch.normalizedCounts ?? current.normalizedCounts };
  upsertSession(session);
  if (session.status === 'complete' || session.status === 'failed' || session.status === 'cancelled' || session.status === 'interrupted') db.exec({ sql: 'UPDATE archive_sets SET status=?,imported_at=? WHERE id=?', bind: [session.status === 'complete' ? 'complete' : 'incomplete', session.status === 'complete' ? session.updatedAt : null, session.archiveSetId] });
  return session;
}

function checkpointPart(sessionId: string, part: ArchivePart, status: ImportPartCheckpoint['status'], error?: string) {
  const now = new Date().toISOString();
  db.exec({ sql: 'INSERT OR REPLACE INTO import_part_checkpoints(session_id,archive_part_id,part_index,manifest_fingerprint,status,started_at,updated_at,completed_at,parser_version,record_counts,warnings_count,error,sections) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)', bind: [sessionId, part.id, part.partIndex, part.manifestFingerprint, status, now, now, status === 'complete' ? now : null, FACEBOOK_PARSER_VERSION, JSON.stringify({}), 0, error ?? null, JSON.stringify(part.sections ?? [])] });
  db.exec({ sql: 'UPDATE archive_parts SET status=?,connected=?,warning_count=?,sections=? WHERE id=?', bind: [status, part.connected ? 1 : 0, part.warningCount ?? 0, JSON.stringify(part.sections ?? []), part.id] });
  const state = currentImportState(sessionId); if (state.session) updateImportSession(sessionId, { status: status === 'failed' ? 'failed' : status === 'skipped' ? 'interrupted' : state.session.status, currentStage: status === 'failed' ? 'failed' : 'interrupted', failedPartIds: state.checkpoints.filter(item => item.status === 'failed').map(item => item.archivePartId), skippedPartIds: state.checkpoints.filter(item => item.status === 'skipped').map(item => item.archivePartId), failedPartCount: state.checkpoints.filter(item => item.status === 'failed').length, skippedPartCount: state.checkpoints.filter(item => item.status === 'skipped').length });
  return currentImportState(sessionId).checkpoints.find(item => item.archivePartId === part.id);
}

function resetDerivedJobs(sessionId: string, clearTables: boolean) {
  const now = new Date().toISOString();
  transaction(() => {
    if (clearTables) { db.exec('DELETE FROM activity_records'); db.exec('DELETE FROM search_documents'); if (searchBackend === 'fts5') db.exec('DELETE FROM archive_fts'); }
    db.exec({ sql: 'UPDATE derived_index_jobs SET status=?,phase=?,cursor=NULL,rows_processed=0,total_rows=0,batch_size=?,started_at=COALESCE(started_at,?),updated_at=?,completed_at=NULL,error=NULL WHERE session_id=?', bind: ['pending', 'pending', DERIVED_BATCH_SIZE, now, now, sessionId] });
  });
}

function rebuildSearchFromTables(): RebuildResult {
  const started = new Date().toISOString();
  const columns = 'entity_type,entity_id,title,body,context,created_at,conversation_id,source_path';
  // Build both indexes directly inside SQLite. A JavaScript row/object for
  // every message is needlessly expensive for large HTML exports; SELECT-based
  // inserts keep the rebuild bounded to SQLite's own page cache.
  const statements = [
    `INSERT OR REPLACE INTO search_documents(${columns}) SELECT 'person',id,display_name,trim(COALESCE(username,'')||' '||COALESCE(relationship,'')),facebook_id,NULL,NULL,COALESCE(identity_source,json_extract(source_paths,'$[0]')) FROM people`,
    `INSERT OR REPLACE INTO search_documents(${columns}) SELECT 'profile-fact','fact:'||id,category,trim(COALESCE(label,'')||' '||value),trim(COALESCE(start_date,'')||' '||COALESCE(end_date,'')),COALESCE(start_date,end_date),NULL,source_path FROM profile_facts`,
    `INSERT OR REPLACE INTO search_documents(${columns}) SELECT 'post',id,title,body,trim(COALESCE(created_at,'')||' '||COALESCE(links,'')),created_at,NULL,source_path FROM posts`,
    `INSERT OR REPLACE INTO search_documents(${columns}) SELECT 'comment',id,author_name,body,post_id,created_at,NULL,source_path FROM comments`,
    `INSERT OR REPLACE INTO search_documents(${columns}) SELECT 'reaction',id,kind,person_name,target_id,created_at,NULL,source_path FROM reactions`,
    `INSERT OR REPLACE INTO search_documents(${columns}) SELECT 'connection',id,display_name,trim(COALESCE(relationship_type,'')||' '||COALESCE(username,'')),COALESCE(started_at,ended_at),COALESCE(started_at,ended_at),NULL,source_path FROM connections`,
    `INSERT OR REPLACE INTO search_documents(${columns}) SELECT 'album',id,title,description,created_at,COALESCE(updated_at,created_at),NULL,source_path FROM albums`,
    `INSERT OR REPLACE INTO search_documents(${columns}) SELECT 'media',id,COALESCE(filename,path),caption,path,timestamp,NULL,source_path FROM media`,
    `INSERT OR REPLACE INTO search_documents(${columns}) SELECT 'conversation',id,COALESCE(title,'Conversation'),participant_names,participant_names,NULL,NULL,source_path FROM conversations`,
    `INSERT OR REPLACE INTO search_documents(${columns}) SELECT 'message',m.id,COALESCE(c.title,'Conversation'),m.body,trim(COALESCE(m.sender_name,'')||' '||COALESCE(m.sent_at,'')),m.sent_at,m.conversation_id,m.source_path FROM messages m LEFT JOIN conversations c ON c.id=m.conversation_id`,
  ];
  transaction(() => {
    db.exec('DELETE FROM search_documents'); if (searchBackend === 'fts5') db.exec('DELETE FROM archive_fts');
    statements.forEach(statement => db.exec(statement));
    if (searchBackend === 'fts5') db.exec(`INSERT INTO archive_fts(${columns}) SELECT ${columns} FROM search_documents`);
  });
  db.exec('PRAGMA optimize');
  return { kind: 'search', rows: Number(rows('SELECT COUNT(*) count FROM search_documents')[0]?.count ?? 0), completedAt: new Date().toISOString() };
}

function rebuildActivityIndex(): RebuildResult {
  // Activity rows are derived data. Generate them with SQL so rebuilding an
  // archive with hundreds of thousands of messages does not materialize a
  // second copy of every normalized record in JavaScript.
  const calendar = (column: string) => `CAST(strftime('%m',${column}) AS INTEGER),CAST(strftime('%d',${column}) AS INTEGER),CAST(strftime('%Y',${column}) AS INTEGER)`;
  const valid = (column: string) => `WHERE ${column} IS NOT NULL AND strftime('%Y',${column}) IS NOT NULL`;
  const statements = [
    `INSERT OR IGNORE INTO activity_records(id,activity_type,actor_person_id,target_type,target_id,occurred_at,calendar_month,calendar_day,calendar_year,summary,source_path,source_index,archive_part_id) SELECT 'activity:profile:'||id,'profile',person_id,'profile',id,joined_at,${calendar('joined_at')},'Profile: '||display_name,source_path,NULL,NULL FROM profiles ${valid('joined_at')}`,
    `INSERT OR IGNORE INTO activity_records(id,activity_type,actor_person_id,target_type,target_id,occurred_at,calendar_month,calendar_day,calendar_year,summary,source_path,source_index,archive_part_id) SELECT 'activity:post:'||id,'post',CASE WHEN author_id='owner' THEN (SELECT person_id FROM profiles LIMIT 1) ELSE author_id END,'post',id,created_at,${calendar('created_at')},CASE WHEN title IS NOT NULL AND title<>'' THEN 'Posted '||char(8220)||title||char(8221) WHEN body IS NOT NULL AND body<>'' THEN 'Posted '||char(8220)||substr(replace(replace(body,char(10),' '),char(13),' '),1,160)||char(8221) ELSE 'Posted' END,source_path,source_index,archive_part_id FROM posts ${valid('created_at')}`,
    `INSERT OR IGNORE INTO activity_records(id,activity_type,actor_person_id,target_type,target_id,occurred_at,calendar_month,calendar_day,calendar_year,summary,source_path,source_index,archive_part_id) SELECT 'activity:comment:'||id,'comment',author_id,'post',post_id,created_at,${calendar('created_at')},CASE WHEN author_name IS NOT NULL AND author_name<>'' THEN 'Commented as '||author_name||': '||char(8220)||substr(replace(replace(body,char(10),' '),char(13),' '),1,160)||char(8221) ELSE 'Commented: '||char(8220)||substr(replace(replace(body,char(10),' '),char(13),' '),1,160)||char(8221) END,source_path,source_index,archive_part_id FROM comments ${valid('created_at')}`,
    `INSERT OR IGNORE INTO activity_records(id,activity_type,actor_person_id,target_type,target_id,occurred_at,calendar_month,calendar_day,calendar_year,summary,source_path,source_index,archive_part_id) SELECT 'activity:reaction:'||id,'reaction',person_id,target_type,target_id,created_at,${calendar('created_at')},'Reacted '||kind||CASE WHEN person_name IS NOT NULL AND person_name<>'' THEN ' as '||person_name ELSE '' END,source_path,source_index,archive_part_id FROM reactions ${valid('created_at')}`,
    `INSERT OR IGNORE INTO activity_records(id,activity_type,actor_person_id,target_type,target_id,occurred_at,calendar_month,calendar_day,calendar_year,summary,source_path,source_index,archive_part_id) SELECT 'activity:message:'||id,'message',sender_id,'conversation',conversation_id,sent_at,${calendar('sent_at')},'Message'||CASE WHEN sender_name IS NOT NULL AND sender_name<>'' THEN ' from '||sender_name ELSE '' END||CASE WHEN body IS NOT NULL AND body<>'' THEN ': '||char(8220)||substr(replace(replace(body,char(10),' '),char(13),' '),1,160)||char(8221) ELSE '' END,source_path,source_index,archive_part_id FROM messages ${valid('sent_at')}`,
    `INSERT OR IGNORE INTO activity_records(id,activity_type,actor_person_id,target_type,target_id,occurred_at,calendar_month,calendar_day,calendar_year,summary,source_path,source_index,archive_part_id) SELECT 'activity:connection:'||id,'connection',person_id,'person',person_id,COALESCE(started_at,ended_at),${calendar('COALESCE(started_at,ended_at)')},replace(relationship_type,'_',' ')||': '||display_name,source_path,source_index,archive_part_id FROM connections WHERE COALESCE(started_at,ended_at) IS NOT NULL AND strftime('%Y',COALESCE(started_at,ended_at)) IS NOT NULL`,
    `INSERT OR IGNORE INTO activity_records(id,activity_type,actor_person_id,target_type,target_id,occurred_at,calendar_month,calendar_day,calendar_year,summary,source_path,source_index,archive_part_id) SELECT 'activity:album:'||id,'album',owner_id,'album',id,COALESCE(created_at,updated_at),${calendar('COALESCE(created_at,updated_at)')},'Album: '||title,source_path,source_index,archive_part_id FROM albums WHERE COALESCE(created_at,updated_at) IS NOT NULL AND strftime('%Y',COALESCE(created_at,updated_at)) IS NOT NULL`,
    `INSERT OR IGNORE INTO activity_records(id,activity_type,actor_person_id,target_type,target_id,occurred_at,calendar_month,calendar_day,calendar_year,summary,source_path,source_index,archive_part_id) SELECT 'activity:media:'||id,'media',NULL,owner_type,owner_id,timestamp,${calendar('timestamp')},'Media: '||COALESCE(filename,path),source_path,source_index,archive_part_id FROM media ${valid('timestamp')}`,
    `INSERT OR IGNORE INTO activity_records(id,activity_type,actor_person_id,target_type,target_id,occurred_at,calendar_month,calendar_day,calendar_year,summary,source_path,source_index,archive_part_id) SELECT 'activity:profile-fact:'||id,'profile',(SELECT person_id FROM profiles LIMIT 1),'profile',(SELECT id FROM profiles LIMIT 1),COALESCE(start_date,end_date),${calendar('COALESCE(start_date,end_date)')},category||CASE WHEN label IS NOT NULL AND label<>'' THEN ' · '||label ELSE '' END||': '||value,source_path,source_index,archive_part_id FROM profile_facts WHERE COALESCE(start_date,end_date) IS NOT NULL AND strftime('%Y',COALESCE(start_date,end_date)) IS NOT NULL`,
  ];
  transaction(() => { db.exec('DELETE FROM activity_records'); statements.forEach(statement => db.exec(statement)); });
  return { kind: 'activity', rows: Number(rows('SELECT COUNT(*) count FROM activity_records')[0]?.count ?? 0), completedAt: new Date().toISOString() };
}

function runRebuildJob<T extends RebuildResult>(kind: T['kind'], work: () => T): T {
  const id = `rebuild:${kind}:${Date.now()}`, startedAt = new Date().toISOString();
  db.exec({ sql: 'INSERT INTO rebuild_jobs(id,kind,status,started_at,updated_at,rows_processed) VALUES(?,?,?,?,?,?)', bind: [id, kind, 'running', startedAt, startedAt, 0] });
  try {
    const result = work();
    db.exec({ sql: 'UPDATE rebuild_jobs SET status=?,updated_at=?,rows_processed=? WHERE id=?', bind: ['complete', result.completedAt, result.rows, id] });
    return result;
  } catch (error) {
    db.exec({ sql: 'UPDATE rebuild_jobs SET status=?,updated_at=?,error=? WHERE id=?', bind: ['failed', new Date().toISOString(), error instanceof Error ? error.message : String(error), id] });
    throw error;
  }
}

type DerivedPhase = { name: string; table: string; where?: string; countSql: string; insertSql: string; label: string };
const derivedWhere = (where: string | undefined) => where ? `WHERE ${where} AND rowid>?` : 'WHERE rowid>?';
const searchPhases = (): DerivedPhase[] => [
  { name: 'people', table: 'people', countSql: 'SELECT COUNT(*) count FROM people', label: 'people', insertSql: `INSERT OR REPLACE INTO search_documents(entity_type,entity_id,title,body,context,created_at,conversation_id,source_path) SELECT 'person',id,display_name,trim(COALESCE(username,'')||' '||COALESCE(relationship,'')),facebook_id,NULL,NULL,COALESCE(identity_source,json_extract(source_paths,'$[0]')) FROM people WHERE rowid>? ORDER BY rowid LIMIT ?` },
  { name: 'profile-facts', table: 'profile_facts', countSql: 'SELECT COUNT(*) count FROM profile_facts', label: 'profile facts', insertSql: `INSERT OR REPLACE INTO search_documents(entity_type,entity_id,title,body,context,created_at,conversation_id,source_path) SELECT 'profile-fact','fact:'||id,category,trim(COALESCE(label,'')||' '||value),trim(COALESCE(start_date,'')||' '||COALESCE(end_date,'')),COALESCE(start_date,end_date),NULL,source_path FROM profile_facts WHERE rowid>? ORDER BY rowid LIMIT ?` },
  { name: 'posts', table: 'posts', countSql: 'SELECT COUNT(*) count FROM posts', label: 'posts', insertSql: `INSERT OR REPLACE INTO search_documents(entity_type,entity_id,title,body,context,created_at,conversation_id,source_path) SELECT 'post',id,title,body,trim(COALESCE(created_at,'')||' '||COALESCE(links,'')),created_at,NULL,source_path FROM posts WHERE rowid>? ORDER BY rowid LIMIT ?` },
  { name: 'comments', table: 'comments', countSql: 'SELECT COUNT(*) count FROM comments', label: 'comments', insertSql: `INSERT OR REPLACE INTO search_documents(entity_type,entity_id,title,body,context,created_at,conversation_id,source_path) SELECT 'comment',id,author_name,body,post_id,created_at,NULL,source_path FROM comments WHERE rowid>? ORDER BY rowid LIMIT ?` },
  { name: 'reactions', table: 'reactions', countSql: 'SELECT COUNT(*) count FROM reactions', label: 'reactions', insertSql: `INSERT OR REPLACE INTO search_documents(entity_type,entity_id,title,body,context,created_at,conversation_id,source_path) SELECT 'reaction',id,kind,person_name,target_id,created_at,NULL,source_path FROM reactions WHERE rowid>? ORDER BY rowid LIMIT ?` },
  { name: 'connections', table: 'connections', countSql: 'SELECT COUNT(*) count FROM connections', label: 'connections', insertSql: `INSERT OR REPLACE INTO search_documents(entity_type,entity_id,title,body,context,created_at,conversation_id,source_path) SELECT 'connection',id,display_name,trim(COALESCE(relationship_type,'')||' '||COALESCE(username,'')),COALESCE(started_at,ended_at),COALESCE(started_at,ended_at),NULL,source_path FROM connections WHERE rowid>? ORDER BY rowid LIMIT ?` },
  { name: 'albums', table: 'albums', countSql: 'SELECT COUNT(*) count FROM albums', label: 'albums', insertSql: `INSERT OR REPLACE INTO search_documents(entity_type,entity_id,title,body,context,created_at,conversation_id,source_path) SELECT 'album',id,title,description,created_at,COALESCE(updated_at,created_at),NULL,source_path FROM albums WHERE rowid>? ORDER BY rowid LIMIT ?` },
  { name: 'media', table: 'media', countSql: 'SELECT COUNT(*) count FROM media', label: 'media metadata', insertSql: `INSERT OR REPLACE INTO search_documents(entity_type,entity_id,title,body,context,created_at,conversation_id,source_path) SELECT 'media',id,COALESCE(filename,path),caption,path,timestamp,NULL,source_path FROM media WHERE rowid>? ORDER BY rowid LIMIT ?` },
  { name: 'conversations', table: 'conversations', countSql: 'SELECT COUNT(*) count FROM conversations', label: 'conversations', insertSql: `INSERT OR REPLACE INTO search_documents(entity_type,entity_id,title,body,context,created_at,conversation_id,source_path) SELECT 'conversation',id,COALESCE(title,'Conversation'),participant_names,participant_names,NULL,NULL,source_path FROM conversations WHERE rowid>? ORDER BY rowid LIMIT ?` },
  { name: 'messages', table: 'messages', countSql: 'SELECT COUNT(*) count FROM messages', label: 'messages', insertSql: `INSERT OR REPLACE INTO search_documents(entity_type,entity_id,title,body,context,created_at,conversation_id,source_path) SELECT 'message',m.id,COALESCE(c.title,'Conversation'),m.body,trim(COALESCE(m.sender_name,'')||' '||COALESCE(m.sent_at,'')),m.sent_at,m.conversation_id,m.source_path FROM messages m LEFT JOIN conversations c ON c.id=m.conversation_id WHERE m.rowid>? ORDER BY m.rowid LIMIT ?` },
  { name: 'fts', table: 'search_documents', countSql: 'SELECT COUNT(*) count FROM search_documents', label: 'FTS5 index', insertSql: `INSERT INTO archive_fts(entity_type,entity_id,title,body,context,created_at,conversation_id,source_path) SELECT entity_type,entity_id,title,body,context,created_at,conversation_id,source_path FROM search_documents WHERE rowid>? ORDER BY rowid LIMIT ?` },
];
const activityPhases = (): DerivedPhase[] => {
  const calendar = (column: string) => `CAST(strftime('%m',${column}) AS INTEGER),CAST(strftime('%d',${column}) AS INTEGER),CAST(strftime('%Y',${column}) AS INTEGER)`;
  const target = 'id,activity_type,actor_person_id,target_type,target_id,occurred_at,calendar_month,calendar_day,calendar_year,summary,source_path,source_index,archive_part_id';
  return [
    { name: 'profiles', table: 'profiles', where: "joined_at IS NOT NULL AND strftime('%Y',joined_at) IS NOT NULL", countSql: "SELECT COUNT(*) count FROM profiles WHERE joined_at IS NOT NULL AND strftime('%Y',joined_at) IS NOT NULL", label: 'profile dates', insertSql: `INSERT OR IGNORE INTO activity_records(${target}) SELECT 'activity:profile:'||id,'profile',person_id,'profile',id,joined_at,${calendar('joined_at')},'Profile: '||display_name,source_path,NULL,NULL FROM profiles WHERE joined_at IS NOT NULL AND strftime('%Y',joined_at) IS NOT NULL AND rowid>? ORDER BY rowid LIMIT ?` },
    { name: 'posts', table: 'posts', where: "created_at IS NOT NULL AND strftime('%Y',created_at) IS NOT NULL", countSql: "SELECT COUNT(*) count FROM posts WHERE created_at IS NOT NULL AND strftime('%Y',created_at) IS NOT NULL", label: 'post activity', insertSql: `INSERT OR IGNORE INTO activity_records(${target}) SELECT 'activity:post:'||id,'post',CASE WHEN author_id='owner' THEN (SELECT person_id FROM profiles LIMIT 1) ELSE author_id END,'post',id,created_at,${calendar('created_at')},CASE WHEN title IS NOT NULL AND title<>'' THEN 'Posted '||char(8220)||title||char(8221) WHEN body IS NOT NULL AND body<>'' THEN 'Posted '||char(8220)||substr(replace(replace(body,char(10),' '),char(13),' '),1,160)||char(8221) ELSE 'Posted' END,source_path,source_index,archive_part_id FROM posts WHERE created_at IS NOT NULL AND strftime('%Y',created_at) IS NOT NULL AND rowid>? ORDER BY rowid LIMIT ?` },
    { name: 'comments', table: 'comments', where: "created_at IS NOT NULL AND strftime('%Y',created_at) IS NOT NULL", countSql: "SELECT COUNT(*) count FROM comments WHERE created_at IS NOT NULL AND strftime('%Y',created_at) IS NOT NULL", label: 'comment activity', insertSql: `INSERT OR IGNORE INTO activity_records(${target}) SELECT 'activity:comment:'||id,'comment',author_id,'post',post_id,created_at,${calendar('created_at')},CASE WHEN author_name IS NOT NULL AND author_name<>'' THEN 'Commented as '||author_name||': '||char(8220)||substr(replace(replace(body,char(10),' '),char(13),' '),1,160)||char(8221) ELSE 'Commented: '||char(8220)||substr(replace(replace(body,char(10),' '),char(13),' '),1,160)||char(8221) END,source_path,source_index,archive_part_id FROM comments WHERE created_at IS NOT NULL AND strftime('%Y',created_at) IS NOT NULL AND rowid>? ORDER BY rowid LIMIT ?` },
    { name: 'reactions', table: 'reactions', where: "created_at IS NOT NULL AND strftime('%Y',created_at) IS NOT NULL", countSql: "SELECT COUNT(*) count FROM reactions WHERE created_at IS NOT NULL AND strftime('%Y',created_at) IS NOT NULL", label: 'reaction activity', insertSql: `INSERT OR IGNORE INTO activity_records(${target}) SELECT 'activity:reaction:'||id,'reaction',person_id,target_type,target_id,created_at,${calendar('created_at')},'Reacted '||kind||CASE WHEN person_name IS NOT NULL AND person_name<>'' THEN ' as '||person_name ELSE '' END,source_path,source_index,archive_part_id FROM reactions WHERE created_at IS NOT NULL AND strftime('%Y',created_at) IS NOT NULL AND rowid>? ORDER BY rowid LIMIT ?` },
    { name: 'messages', table: 'messages', where: "sent_at IS NOT NULL AND strftime('%Y',sent_at) IS NOT NULL", countSql: "SELECT COUNT(*) count FROM messages WHERE sent_at IS NOT NULL AND strftime('%Y',sent_at) IS NOT NULL", label: 'message activity', insertSql: `INSERT OR IGNORE INTO activity_records(${target}) SELECT 'activity:message:'||id,'message',sender_id,'conversation',conversation_id,sent_at,${calendar('sent_at')},'Message'||CASE WHEN sender_name IS NOT NULL AND sender_name<>'' THEN ' from '||sender_name ELSE '' END||CASE WHEN body IS NOT NULL AND body<>'' THEN ': '||char(8220)||substr(replace(replace(body,char(10),' '),char(13),' '),1,160)||char(8221) ELSE '' END,source_path,source_index,archive_part_id FROM messages WHERE sent_at IS NOT NULL AND strftime('%Y',sent_at) IS NOT NULL AND rowid>? ORDER BY rowid LIMIT ?` },
    { name: 'connections', table: 'connections', where: "COALESCE(started_at,ended_at) IS NOT NULL AND strftime('%Y',COALESCE(started_at,ended_at)) IS NOT NULL", countSql: "SELECT COUNT(*) count FROM connections WHERE COALESCE(started_at,ended_at) IS NOT NULL AND strftime('%Y',COALESCE(started_at,ended_at)) IS NOT NULL", label: 'connection activity', insertSql: `INSERT OR IGNORE INTO activity_records(${target}) SELECT 'activity:connection:'||id,'connection',person_id,'person',person_id,COALESCE(started_at,ended_at),${calendar('COALESCE(started_at,ended_at)')},replace(relationship_type,'_',' ')||': '||display_name,source_path,source_index,archive_part_id FROM connections WHERE COALESCE(started_at,ended_at) IS NOT NULL AND strftime('%Y',COALESCE(started_at,ended_at)) IS NOT NULL AND rowid>? ORDER BY rowid LIMIT ?` },
    { name: 'albums', table: 'albums', where: "COALESCE(created_at,updated_at) IS NOT NULL AND strftime('%Y',COALESCE(created_at,updated_at)) IS NOT NULL", countSql: "SELECT COUNT(*) count FROM albums WHERE COALESCE(created_at,updated_at) IS NOT NULL AND strftime('%Y',COALESCE(created_at,updated_at)) IS NOT NULL", label: 'album activity', insertSql: `INSERT OR IGNORE INTO activity_records(${target}) SELECT 'activity:album:'||id,'album',owner_id,'album',id,COALESCE(created_at,updated_at),${calendar('COALESCE(created_at,updated_at)')},'Album: '||title,source_path,source_index,archive_part_id FROM albums WHERE COALESCE(created_at,updated_at) IS NOT NULL AND strftime('%Y',COALESCE(created_at,updated_at)) IS NOT NULL AND rowid>? ORDER BY rowid LIMIT ?` },
    { name: 'media', table: 'media', where: "timestamp IS NOT NULL AND strftime('%Y',timestamp) IS NOT NULL", countSql: "SELECT COUNT(*) count FROM media WHERE timestamp IS NOT NULL AND strftime('%Y',timestamp) IS NOT NULL", label: 'media activity', insertSql: `INSERT OR IGNORE INTO activity_records(${target}) SELECT 'activity:media:'||id,'media',NULL,owner_type,owner_id,timestamp,${calendar('timestamp')},'Media: '||COALESCE(filename,path),source_path,source_index,archive_part_id FROM media WHERE timestamp IS NOT NULL AND strftime('%Y',timestamp) IS NOT NULL AND rowid>? ORDER BY rowid LIMIT ?` },
    { name: 'profile-facts', table: 'profile_facts', where: "COALESCE(start_date,end_date) IS NOT NULL AND strftime('%Y',COALESCE(start_date,end_date)) IS NOT NULL", countSql: "SELECT COUNT(*) count FROM profile_facts WHERE COALESCE(start_date,end_date) IS NOT NULL AND strftime('%Y',COALESCE(start_date,end_date)) IS NOT NULL", label: 'profile facts activity', insertSql: `INSERT OR IGNORE INTO activity_records(${target}) SELECT 'activity:profile-fact:'||id,'profile',(SELECT person_id FROM profiles LIMIT 1),'profile',(SELECT id FROM profiles LIMIT 1),COALESCE(start_date,end_date),${calendar('COALESCE(start_date,end_date)')},category||CASE WHEN label IS NOT NULL AND label<>'' THEN ' · '||label ELSE '' END||': '||value,source_path,source_index,archive_part_id FROM profile_facts WHERE COALESCE(start_date,end_date) IS NOT NULL AND strftime('%Y',COALESCE(start_date,end_date)) IS NOT NULL AND rowid>? ORDER BY rowid LIMIT ?` },
  ];
};
const waitForWorkerTurn = () => new Promise<void>(resolve => setTimeout(resolve, 0));
const derivedJobRow = (sessionId: string, kind: 'search' | 'activity') => rows('SELECT id,session_id sessionId,kind,status,phase,cursor,rows_processed rowsProcessed,total_rows totalRows,batch_size batchSize,started_at startedAt,updated_at updatedAt,completed_at completedAt,error FROM derived_index_jobs WHERE session_id=? AND kind=? LIMIT 1', [sessionId, kind])[0];
function ensureDerivedJob(sessionId: string, kind: 'search' | 'activity', totalRows: number) {
  const now = new Date().toISOString(); const existing = derivedJobRow(sessionId, kind);
  if (!existing) db.exec({ sql: 'INSERT INTO derived_index_jobs(id,session_id,kind,status,phase,cursor,rows_processed,total_rows,batch_size,started_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)', bind: [`derived:${sessionId}:${kind}`, sessionId, kind, 'pending', 'pending', null, 0, totalRows, DERIVED_BATCH_SIZE, now, now] });
  else if (Number(existing.totalRows ?? 0) !== totalRows && String(existing.status) !== 'complete') db.exec({ sql: 'UPDATE derived_index_jobs SET total_rows=?,updated_at=? WHERE session_id=? AND kind=?', bind: [totalRows, now, sessionId, kind] });
  return derivedJobRow(sessionId, kind)!;
}
function totalForPhases(phases: DerivedPhase[]) { return phases.reduce((sum, phase) => sum + Number(rows(phase.countSql)[0]?.count ?? 0), 0); }
function resetDerivedTarget(sessionId: string, kind: 'search' | 'activity', totalRows: number) {
  const now = new Date().toISOString();
  transaction(() => {
    if (kind === 'search') { db.exec('DELETE FROM search_documents'); if (searchBackend === 'fts5') db.exec('DELETE FROM archive_fts'); }
    else db.exec('DELETE FROM activity_records');
    db.exec({ sql: 'INSERT OR REPLACE INTO derived_index_jobs(id,session_id,kind,status,phase,cursor,rows_processed,total_rows,batch_size,started_at,updated_at,completed_at,error) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)', bind: [`derived:${sessionId}:${kind}`, sessionId, kind, 'pending', 'pending', null, 0, totalRows, DERIVED_BATCH_SIZE, now, now, null, null] });
  });
}
function updateDerivedSession(sessionId: string, kind: 'search' | 'activity', job: DerivedIndexState, status: DerivedIndexStatus, error?: string) {
  const current = currentImportState(sessionId).session; if (!current) return;
  const otherKind = kind === 'search' ? 'activity' : 'search'; const other = derivedJobRow(sessionId, otherKind); const allComplete = status === 'complete' && String(other?.status) === 'complete';
  const now = new Date().toISOString();
  const cancelled = current.status === 'cancelled';
  upsertSession({ ...current, updatedAt: now, status: cancelled ? 'cancelled' : allComplete ? 'complete' : 'indexing', currentStage: cancelled ? 'cancelled' : allComplete ? 'complete' : 'indexing', sourceStatus: current.sourceStatus ?? 'complete', derivedStatus: allComplete ? 'complete' : status, derivedPhase: allComplete ? 'complete' : `${kind}:${job.phase}`, derivedRows: job.rowsProcessed, derivedTotal: job.totalRows, derivedUpdatedAt: now, derivedError: error });
}
async function runDerivedIndex(kind: 'search' | 'activity', requestId: number, force = false): Promise<RebuildResult> {
  const session = currentImportState().session; if (!session) throw new Error('No local import session is available.');
  if (session.sourceStatus && session.sourceStatus !== 'complete') throw new Error('The source import is not complete yet.');
  // FTS5 is optional. On browsers where SQLite cannot create the virtual
  // table, LIKE search remains available and the FTS phase must be omitted
  // entirely (otherwise a resumable job would fail on archive_fts).
  const phases = kind === 'search'
    ? (searchBackend === 'fts5' ? searchPhases() : searchPhases().filter(phase => phase.name !== 'fts'))
    : activityPhases();
  const sourcePhases = kind === 'search' && searchBackend === 'fts5' ? phases.slice(0, -1) : phases;
  const sourceTotal = totalForPhases(sourcePhases);
  const totalRows = kind === 'search' ? sourceTotal * (searchBackend === 'fts5' ? 2 : 1) : sourceTotal;
  let row = ensureDerivedJob(session.id, kind, totalRows); let job = derivedFromRow(row);
  if (force) { resetDerivedTarget(session.id, kind, totalRows); job = derivedFromRow(derivedJobRow(session.id, kind)!); }
  if (job.status === 'complete') return { kind, rows: job.rowsProcessed, completedAt: job.completedAt ?? new Date().toISOString() };
  activeDerivedSession = session.id; derivedCancelRequested = false; derivedBatchesSinceFallback = 0;
  const startedMs = performance.now(); const phaseStart = Math.max(0, phases.findIndex(phase => phase.name === job.phase));
  let batchSize = Math.min(10_000, Math.max(SQLITE_MIN_BATCH_SIZE, job.batchSize || DERIVED_BATCH_SIZE));
  try {
    db.exec({ sql: 'UPDATE derived_index_jobs SET status=?,updated_at=?,error=NULL WHERE session_id=? AND kind=?', bind: ['running', new Date().toISOString(), session.id, kind] });
    job = derivedFromRow(derivedJobRow(session.id, kind)!); updateDerivedSession(session.id, kind, job, 'running');
    sendDerivedProgress(requestId, kind, job.phase, 'running', job.rowsProcessed, job.totalRows, `Preparing local ${kind} index…`);
    for (let phaseIndex = phaseStart; phaseIndex < phases.length; phaseIndex++) {
      const phase = phases[phaseIndex];
      if (phaseIndex < phaseStart) continue;
      let cursor = phase.name === job.phase && job.phase !== 'pending' ? Number(job.cursor ?? 0) : 0;
      if (phase.name !== job.phase) {
        db.exec({ sql: 'UPDATE derived_index_jobs SET phase=?,cursor=NULL,updated_at=? WHERE session_id=? AND kind=?', bind: [phase.name, new Date().toISOString(), session.id, kind] });
        job = derivedFromRow(derivedJobRow(session.id, kind)!); cursor = 0;
      }
      while (true) {
        if (derivedCancelRequested) throw new Error('__SOCIALVAULT_DERIVED_CANCELLED__');
        const selected = rows(`SELECT rowid FROM ${phase.table} ${derivedWhere(phase.where)} ORDER BY rowid LIMIT ?`, [cursor, batchSize]);
        if (!selected.length) break;
        const lastRowId = Number(selected[selected.length - 1].rowid);
        const batchStartedAt = performance.now();
        transaction(() => {
          db.exec({ sql: phase.insertSql, bind: [cursor, batchSize] });
          const nextRows = job.rowsProcessed + selected.length;
          db.exec({ sql: 'UPDATE derived_index_jobs SET status=?,phase=?,cursor=?,rows_processed=?,total_rows=?,batch_size=?,updated_at=?,error=NULL WHERE session_id=? AND kind=?', bind: ['running', phase.name, String(lastRowId), nextRows, totalRows, batchSize, new Date().toISOString(), session.id, kind] });
        });
        cursor = lastRowId;
        const batchDurationMs = performance.now() - batchStartedAt;
        const nextBatchSize = batchDurationMs > 300 ? Math.max(SQLITE_MIN_BATCH_SIZE, Math.floor(batchSize * 0.75)) : batchDurationMs < 60 && selected.length === batchSize ? Math.min(10_000, batchSize + 500) : batchSize;
        if (nextBatchSize !== batchSize) { batchSize = nextBatchSize; db.exec({ sql: 'UPDATE derived_index_jobs SET batch_size=?,updated_at=? WHERE session_id=? AND kind=?', bind: [batchSize, new Date().toISOString(), session.id, kind] }); }
        job = derivedFromRow(derivedJobRow(session.id, kind)!); updateDerivedSession(session.id, kind, job, 'running');
        sendDerivedProgress(requestId, kind, phase.name, 'running', job.rowsProcessed, job.totalRows, `Indexing ${phase.label}…`);
        derivedBatchesSinceFallback++;
        // OPFS commits each SQLite transaction directly. IndexedDB fallback
        // needs periodic serialized snapshots as well, otherwise a browser
        // restart during a long derived pass would lose every checkpoint
        // since the previous completed request.
        if (mode === 'indexeddb' && derivedBatchesSinceFallback >= 16) { derivedBatchesSinceFallback = 0; await persistFallback(true); }
        await waitForWorkerTurn();
      }
      if (phaseIndex + 1 < phases.length) {
        db.exec({ sql: 'UPDATE derived_index_jobs SET phase=?,cursor=NULL,updated_at=? WHERE session_id=? AND kind=?', bind: [phases[phaseIndex + 1].name, new Date().toISOString(), session.id, kind] });
        job = derivedFromRow(derivedJobRow(session.id, kind)!); updateDerivedSession(session.id, kind, job, 'running');
      }
    }
    if (kind === 'search') db.exec('PRAGMA optimize');
    const completedAt = new Date().toISOString(); db.exec({ sql: 'UPDATE derived_index_jobs SET status=?,updated_at=?,completed_at=?,cursor=NULL,error=NULL WHERE session_id=? AND kind=?', bind: ['complete', completedAt, completedAt, session.id, kind] });
    job = derivedFromRow(derivedJobRow(session.id, kind)!); updateDerivedSession(session.id, kind, job, 'complete');
    const elapsed = Math.max(1, performance.now() - startedMs); const current = currentImportState(session.id).session; if (current) upsertSession({ ...current, metrics: { ...(current.metrics ?? {}), derivedDurationsMs: { ...(current.metrics?.derivedDurationsMs ?? {}), [kind]: Math.round(elapsed) }, derivedRows: { ...(current.metrics?.derivedRows ?? {}), [kind]: job.rowsProcessed } } });
    sendDerivedProgress(requestId, kind, 'complete', 'complete', job.rowsProcessed, job.totalRows, `Local ${kind} index ready.`);
    return { kind, rows: job.rowsProcessed, completedAt };
  } catch (error) {
    const cancelled = error instanceof Error && error.message === '__SOCIALVAULT_DERIVED_CANCELLED__'; const status: DerivedIndexStatus = cancelled ? 'interrupted' : 'failed'; const message = cancelled ? 'Derived indexing paused. It can resume from the last checkpoint.' : error instanceof Error ? error.message : String(error); const now = new Date().toISOString();
    db.exec({ sql: 'UPDATE derived_index_jobs SET status=?,updated_at=?,error=? WHERE session_id=? AND kind=?', bind: [status, now, message, session.id, kind] });
    job = derivedFromRow(derivedJobRow(session.id, kind)!); updateDerivedSession(session.id, kind, job, status, message); sendDerivedProgress(requestId, kind, job.phase, status, job.rowsProcessed, job.totalRows, message); throw new Error(message);
  } finally { activeDerivedSession = undefined; derivedCancelRequested = false; derivedBatchesSinceFallback = 0; }
}

function coverageFromDatabase(): ArchiveCoverage {
  const state = currentImportState();
  const sectionStatuses = rows('SELECT section,status,parser_version parserVersion,record_count recordCount,warning_count warningCount FROM import_section_status ORDER BY section').map(row => ({ section: String(row.section), status: String(row.status) as ImportSectionStatus['status'], parserVersion: Number(row.parserVersion), recordCount: Number(row.recordCount ?? 0), warningCount: Number(row.warningCount ?? 0) }));
  if (state.coverage) return { ...state.coverage, sectionStatuses: state.coverage.sectionStatuses ?? sectionStatuses };
  const parts = rows('SELECT sections,status FROM archive_parts').flatMap(row => json<string[]>(row.sections, []));
  const detectedSections = [...new Set(parts)];
  const importedSections = json<string[]>(rows("SELECT value FROM import_metadata WHERE key='sections'")[0]?.value, []);
  return { detectedSections, importedSections, partialSections: [], unsupportedSections: [], malformedSections: [], skippedParts: [], sectionStatuses };
}
function diagnosticsFromDatabase() {
  const state = currentImportState(); const statsValue = stats();
  const warningGroups = rows('SELECT category,message,occurrence_count occurrenceCount,source_paths sourcePaths FROM diagnostic_warning_groups WHERE session_id=? ORDER BY occurrence_count DESC,category', [state.session?.id ?? '']).map(row => ({ category: String(row.category), message: String(row.message), count: Number(row.occurrenceCount ?? 0), sourcePaths: json<string[]>(row.sourcePaths, []) }));
  const diagnostics = statsValue.diagnostics ? { ...statsValue.diagnostics, warningGroups: warningGroups.length ? warningGroups : statsValue.diagnostics.warningGroups } : undefined;
  return createDiagnosticsReport({ parserVersion: state.session?.parserVersion ?? FACEBOOK_PARSER_VERSION, schemaVersion: SCHEMA_VERSION, archiveParts: statsValue.archiveParts, session: state.session, coverage: coverageFromDatabase(), diagnostics, warnings: statsValue.warnings });
}
function requestFallbackSnapshot() {
  if (mode !== 'indexeddb') return;
  // Completed source-part and derived-index checkpoints both request a
  // snapshot. The five-second timer coalesces requests so the producer queue
  // remains bounded, while a reload still has normalized rows to hydrate
  // instead of only a checkpoint that points at data which was never saved.
  // The export itself runs after the current database request yields.
  fallbackSnapshotRequested = true;
  if (fallbackSnapshotTimer || fallbackSnapshotRunning) return;
  // Snapshot export can temporarily require another copy of a large SQLite
  // database. Defer it until the current database request has acknowledged so
  // the producer/consumer queue never stalls behind IndexedDB structured-clone
  // work. Requests coalesce while a snapshot is in flight.
  fallbackSnapshotTimer = setTimeout(() => {
    fallbackSnapshotTimer = undefined;
    if (fallbackSnapshotRunning || mode !== 'indexeddb' || !fallbackSnapshotRequested) return;
    fallbackSnapshotRequested = false;
    fallbackSnapshotRunning = true;
    void (async () => {
      try {
        const snapshot = sqliteRuntime?.capi?.sqlite3_js_db_export && db.pointer ? sqliteRuntime.capi.sqlite3_js_db_export(db.pointer) as Uint8Array : undefined;
        if (snapshot) {
          await putFallbackSnapshot(snapshot);
          const metrics = currentImportState().session?.metrics;
          if (metrics) { const next = { ...metrics, storageSnapshotBytes: snapshot.byteLength }; const state = currentImportState().session; if (state) upsertSession({ ...state, metrics: next }); }
        } else await putFallback(fallbackData);
        await putFallbackImportState(currentImportState());
      } catch { /* the in-memory query layer remains usable if browser storage is unavailable */ }
      finally {
        fallbackSnapshotRunning = false;
        if (fallbackSnapshotRequested) requestFallbackSnapshot();
      }
    })();
  }, 5000);
}
async function persistFallback(snapshot = true) {
  if (mode !== 'indexeddb') return;
  try {
    // Import/session metadata is small and remains a synchronous durability
    // point. The SQLite image itself is coalesced and written asynchronously so
    // a multi-gigabyte export cannot block the next acknowledged batch.
    await putFallbackImportState(currentImportState());
    if (snapshot) requestFallbackSnapshot();
  } catch { /* the in-memory query layer remains usable if browser storage is unavailable */ }
}

function postPage(request: DatabaseRequest): Page<Post> {
  const limit = limitOf(request.limit), sort = request.sort === 'oldest' ? 'oldest' : 'newest', cursor = decode(request.cursor), conditions: string[] = [], bind: unknown[] = [];
  if (request.year) { conditions.push("substr(p.created_at,1,4)=?"); bind.push(String(request.year)); }
  if (request.personId) { conditions.push('author_id=?'); bind.push(request.personId); }
  if (request.postId) { conditions.push('p.id=?'); bind.push(request.postId); }
  if (cursor) { if (sort === 'newest') { conditions.push("(COALESCE(p.created_at,'') < ? OR (COALESCE(p.created_at,'') = ? AND p.id < ?))"); bind.push(cursor.key, cursor.key, cursor.id); } else { conditions.push("(COALESCE(p.created_at,'') > ? OR (COALESCE(p.created_at,'') = ? AND p.id > ?))"); bind.push(cursor.key, cursor.key, cursor.id); } }
  const query = `SELECT p.id,p.author_id authorId,COALESCE((SELECT display_name FROM people WHERE id=p.author_id LIMIT 1),(SELECT display_name FROM profiles WHERE person_id=p.author_id LIMIT 1),(SELECT display_name FROM profiles LIMIT 1)) authorName,COALESCE((SELECT profile_photo_path FROM people WHERE id=p.author_id LIMIT 1),(SELECT profile_photo_path FROM people WHERE is_archive_owner=1 LIMIT 1)) authorPhotoPath,p.title,p.body text,p.created_at createdAt,p.links linksJson,p.source_path sourcePath,p.source_index sourceIndex,p.archive_part_id archivePartId,(SELECT COUNT(*) FROM media m WHERE m.owner_type='post' AND m.owner_id=p.id) mediaCount,(SELECT COUNT(*) FROM comments c WHERE c.post_id=p.id) commentCount,(SELECT COUNT(*) FROM reactions r WHERE r.target_type='post' AND r.target_id=p.id) reactionCount,(SELECT json_group_array(json_object('id',m.id,'path',m.path,'mediaType',m.media_type,'filename',m.filename,'mimeType',m.mime_type,'caption',m.caption,'timestamp',m.timestamp,'ownerType',m.owner_type,'ownerId',m.owner_id,'width',m.width,'height',m.height,'durationMs',m.duration_ms,'sourcePath',m.source_path,'sourceIndex',m.source_index,'archivePartId',m.archive_part_id)) FROM media m WHERE m.owner_type='post' AND m.owner_id=p.id) mediaJson,(SELECT json_group_array(json_object('id',c.id,'postId',c.post_id,'authorId',c.author_id,'authorName',c.author_name,'text',c.body,'createdAt',c.created_at,'source',json_object('platform','facebook','path',c.source_path,'index',c.source_index,'archivePartId',c.archive_part_id))) FROM comments c WHERE c.post_id=p.id ORDER BY COALESCE(c.created_at,'') ASC,c.id) commentsJson,(SELECT json_group_array(json_object('id',r.id,'targetType',r.target_type,'targetId',r.target_id,'personId',r.person_id,'personName',r.person_name,'kind',r.kind,'createdAt',r.created_at,'source',json_object('platform','facebook','path',r.source_path,'index',r.source_index,'archivePartId',r.archive_part_id))) FROM reactions r WHERE r.target_type='post' AND r.target_id=p.id) reactionsJson FROM posts p ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''} ORDER BY COALESCE(p.created_at,'') ${sort === 'oldest' ? 'ASC' : 'DESC'},p.id ${sort === 'oldest' ? 'ASC' : 'DESC'} LIMIT ?`;
  bind.push(limit + 1);
  const result = rows(query, bind), hasMore = result.length > limit, items = result.slice(0, limit).map(mapPost), last = items[items.length - 1];
  return { items, hasMore, nextCursor: hasMore && last ? encode({ key: last.createdAt ?? '', id: last.id }) : undefined };
}
function postById(postId?: string): Post | undefined { return postId ? postPage({ id: 0, type: 'posts', postId, limit: 1 }).items[0] : undefined; }
function activityPage(request: DatabaseRequest): Page<ActivityRecord> {
  const limit = limitOf(request.limit), cursor = decode(request.cursor), conditions: string[] = [], bind: unknown[] = [];
  if (request.activityType) { conditions.push('a.activity_type=?'); bind.push(request.activityType); }
  if (request.year) { conditions.push('a.calendar_year=?'); bind.push(request.year); }
  if (request.query?.trim()) { conditions.push('(a.summary LIKE ? OR a.source_path LIKE ?)'); bind.push(`%${request.query.trim()}%`, `%${request.query.trim()}%`); }
  if (cursor) { conditions.push("(a.occurred_at < ? OR (a.occurred_at = ? AND a.id < ?))"); bind.push(cursor.key, cursor.key, cursor.id); }
  const result = rows(`SELECT a.id,a.activity_type activityType,a.actor_person_id actorPersonId,(SELECT display_name FROM people p WHERE p.id=a.actor_person_id LIMIT 1) actorName,a.target_type targetType,a.target_id targetId,a.occurred_at timestamp,a.summary,a.source_path sourcePath,a.source_index sourceIndex,a.archive_part_id archivePartId FROM activity_records a ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''} ORDER BY a.occurred_at DESC,a.id DESC LIMIT ?`, [...bind, limit + 1]);
  const hasMore = result.length > limit, items = result.slice(0, limit).map(mapActivity), last = items[items.length - 1];
  return { items, hasMore, nextCursor: hasMore && last ? encode({ key: last.timestamp, id: last.id }) : undefined };
}
function memories(month?: number, day?: number, limit?: number): MemoryRecord[] {
  if (!month || !day) return [];
  const currentYear = new Date().getUTCFullYear(), result = rows('SELECT a.id,a.activity_type activityType,a.actor_person_id actorPersonId,(SELECT display_name FROM people p WHERE p.id=a.actor_person_id LIMIT 1) actorName,a.target_type targetType,a.target_id targetId,a.occurred_at timestamp,a.summary,a.source_path sourcePath,a.source_index sourceIndex,a.archive_part_id archivePartId,a.calendar_year calendarYear FROM activity_records a WHERE a.calendar_month=? AND a.calendar_day=? ORDER BY a.calendar_year DESC,a.occurred_at DESC,a.id DESC LIMIT ?', [month, day, Math.min(100, Math.max(1, limit ?? 60))]);
  const seen = new Set<string>();
  return result.map(row => { const item = mapActivity(row); const dedupe = `${item.type}:${item.targetId ?? item.id}`; if (seen.has(dedupe)) return undefined; seen.add(dedupe); return { ...item, calendarYear: Number(row.calendarYear), yearsAgo: Math.max(0, currentYear - Number(row.calendarYear)) }; }).filter((item): item is MemoryRecord => !!item);
}
// Activity rebuilding is now handled exclusively by the checkpointed,
// set-based runDerivedIndex('activity') job above. Keeping a second
// materializing implementation here would make legacy callers accidentally
// allocate the complete normalized archive in JavaScript.

function conversationPage(request: DatabaseRequest): Page<ConversationPreview> {
  const limit = limitOf(request.limit), cursor = decode(request.cursor), filter = request.query?.trim(), conditions: string[] = [], bind: unknown[] = [];
  if (filter) { conditions.push('(c.title LIKE ? OR c.participant_names LIKE ?)'); bind.push(`%${filter}%`, `%${filter}%`); }
  if (cursor) { conditions.push("(COALESCE(ms.latestSentAt,'') < ? OR (COALESCE(ms.latestSentAt,'') = ? AND c.id < ?))"); bind.push(cursor.key, cursor.key, cursor.id); }
  // Aggregate message counts and latest previews once for the page instead of
  // running three correlated scans for every conversation row.
  const query = `WITH message_stats AS (SELECT conversation_id,COUNT(*) messageCount,MAX(COALESCE(sent_at,'')) latestSentAt FROM messages GROUP BY conversation_id), ranked_messages AS (SELECT conversation_id,body latestText,sent_at latestSentAt,ROW_NUMBER() OVER (PARTITION BY conversation_id ORDER BY COALESCE(sent_at,'') DESC,id DESC) rank FROM messages) SELECT c.id,c.title,c.participant_names participantNamesJson,c.participant_ids participantIdsJson,c.source_path sourcePath,c.archive_part_id archivePartId,COALESCE(ms.messageCount,0) messageCount,rm.latestText,rm.latestSentAt,c.is_group isGroup FROM conversations c LEFT JOIN message_stats ms ON ms.conversation_id=c.id LEFT JOIN ranked_messages rm ON rm.conversation_id=c.id AND rm.rank=1 ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''} ORDER BY COALESCE(ms.latestSentAt,'') DESC,c.id DESC LIMIT ?`;
  bind.push(limit + 1);
  const result = rows(query, bind), hasMore = result.length > limit;
  const items = result.slice(0, limit).map(row => ({ id: String(row.id), title: row.title ? String(row.title) : undefined, participantIds: json<string[]>(row.participantIdsJson, []), participantNames: json<string[]>(row.participantNamesJson, []), source: sourceRef(row), messageCount: Number(row.messageCount), latestText: row.latestText ? String(row.latestText) : undefined, latestSentAt: row.latestSentAt ? String(row.latestSentAt) : undefined, isGroup: Number(row.isGroup ?? 0) === 1 }));
  const last = items[items.length - 1];
  return { items, hasMore, nextCursor: hasMore && last ? encode({ key: last.latestSentAt ?? '', id: last.id }) : undefined };
}

function messagePage(request: DatabaseRequest): Page<Message> {
  const limit = limitOf(request.limit), cursor = decode(request.cursor), conditions = ['conversation_id=?'], bind: unknown[] = [request.conversationId];
  if (cursor) { conditions.push("(COALESCE(sent_at,'') < ? OR (COALESCE(sent_at,'') = ? AND id < ?))"); bind.push(cursor.key, cursor.key, cursor.id); }
  const result = rows(`SELECT id,conversation_id conversationId,sender_id senderId,sender_name senderName,body text,sent_at sentAt,source_path sourcePath,source_index sourceIndex,archive_part_id archivePartId,(SELECT COUNT(*) FROM media m WHERE m.owner_type='message' AND m.owner_id=messages.id) mediaCount,(SELECT json_group_array(json_object('id',m.id,'path',m.path,'mediaType',m.media_type,'filename',m.filename,'mimeType',m.mime_type,'caption',m.caption,'timestamp',m.timestamp,'ownerType',m.owner_type,'ownerId',m.owner_id,'width',m.width,'height',m.height,'durationMs',m.duration_ms,'sourcePath',m.source_path,'sourceIndex',m.source_index,'archivePartId',m.archive_part_id)) FROM media m WHERE m.owner_type='message' AND m.owner_id=messages.id) mediaJson FROM messages WHERE ${conditions.join(' AND ')} ORDER BY COALESCE(sent_at,'') DESC,id DESC LIMIT ?`, [...bind, limit + 1]);
  const hasMore = result.length > limit, items = result.slice(0, limit).map(mapMessage), last = items[items.length - 1];
  return { items, hasMore, nextCursor: hasMore && last ? encode({ key: last.sentAt ?? '', id: last.id }) : undefined };
}

function mediaPage(request: DatabaseRequest): Page<Media> {
  const limit = limitOf(request.limit), cursor = decode(request.cursor), bind: unknown[] = [], conditions: string[] = [];
  if (request.mediaType) { conditions.push('media_type=?'); bind.push(request.mediaType); }
  if (cursor) { conditions.push("(COALESCE(timestamp,'') < ? OR (COALESCE(timestamp,'') = ? AND id < ?))"); bind.push(cursor.key, cursor.key, cursor.id); }
  const result = rows(`SELECT id,path,media_type mediaType,filename,mime_type mimeType,caption,timestamp,owner_type ownerType,owner_id ownerId,width,height,duration_ms durationMs,source_path sourcePath,source_index sourceIndex,archive_part_id archivePartId FROM media ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''} ORDER BY COALESCE(timestamp,'') DESC,id DESC LIMIT ?`, [...bind, limit + 1]);
  const hasMore = result.length > limit, items = result.slice(0, limit).map(mapMedia), last = items[items.length - 1];
  return { items, hasMore, nextCursor: hasMore && last ? encode({ key: last.timestamp ?? '', id: last.id }) : undefined };
}

function peoplePage(request: DatabaseRequest): Page<PersonSummary> {
  const limit = limitOf(request.limit), cursor = decode(request.cursor), conditions: string[] = [], bind: unknown[] = [];
  if (request.query?.trim()) { conditions.push('p.display_name LIKE ?'); bind.push(`%${request.query.trim()}%`); }
  if (cursor) { conditions.push('(LOWER(p.display_name)>LOWER(?) OR (LOWER(p.display_name)=LOWER(?) AND p.id>?))'); bind.push(cursor.name, cursor.name, cursor.id); }
  const query = `SELECT p.id,p.facebook_id facebookId,p.display_name displayName,p.username,p.profile_url profileUrl,p.profile_photo_path profilePhotoPath,p.cover_photo_path coverPhotoPath,p.first_seen firstSeen,p.last_seen lastSeen,p.relationship,p.identity_confidence identityConfidence,p.identity_source identitySource,p.source_paths sourcePaths,(SELECT json_group_array(ps.archive_part_id) FROM person_sources ps WHERE ps.person_id=p.id AND ps.archive_part_id IS NOT NULL) sourcePartIds,p.is_archive_owner isArchiveOwner,(SELECT COUNT(*) FROM messages m WHERE m.sender_id=p.id) messageCount,(SELECT COUNT(*) FROM posts po WHERE po.author_id=p.id) postCount,(SELECT COUNT(*) FROM comments co WHERE co.author_id=p.id) commentCount,(SELECT COUNT(*) FROM reactions re WHERE re.person_id=p.id) reactionCount,(SELECT COUNT(*) FROM connections cn WHERE cn.person_id=p.id) connectionCount,(SELECT COUNT(*) FROM albums al WHERE al.owner_id=p.id) albumCount,(SELECT COUNT(*) FROM media me WHERE (me.owner_type='post' AND me.owner_id IN (SELECT id FROM posts WHERE author_id=p.id)) OR (me.owner_type='message' AND me.owner_id IN (SELECT id FROM messages WHERE sender_id=p.id)) OR (me.owner_type='album' AND me.owner_id=p.id)) mediaCount,(SELECT COUNT(*) FROM posts po WHERE po.author_id=p.id) sharedPostCount,(SELECT COUNT(*) FROM media me WHERE me.owner_type='album' AND me.owner_id IN (SELECT id FROM albums WHERE owner_id=p.id)) sharedMediaCount,(SELECT COUNT(*) FROM conversations c WHERE c.participant_ids LIKE '%'||p.id||'%') participationCount,(SELECT MIN(value) FROM (SELECT sent_at value FROM messages WHERE sender_id=p.id UNION ALL SELECT created_at value FROM posts WHERE author_id=p.id UNION ALL SELECT created_at value FROM comments WHERE author_id=p.id UNION ALL SELECT created_at value FROM reactions WHERE person_id=p.id)) firstInteraction,(SELECT MAX(value) FROM (SELECT sent_at value FROM messages WHERE sender_id=p.id UNION ALL SELECT created_at value FROM posts WHERE author_id=p.id UNION ALL SELECT created_at value FROM comments WHERE author_id=p.id UNION ALL SELECT created_at value FROM reactions WHERE person_id=p.id)) lastInteraction FROM people p ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''} ORDER BY LOWER(p.display_name),p.id LIMIT ?`;
  bind.push(limit + 1);
  const result = rows(query, bind), hasMore = result.length > limit, items = result.slice(0, limit).map(mapPerson), last = items[items.length - 1];
  return { items, hasMore, nextCursor: hasMore && last ? encode({ name: last.displayName, id: last.id }) : undefined };
}

function personById(personId?: string): PersonSummary | undefined {
  if (!personId) return undefined;
  return peoplePage({ id: 0, type: 'people', query: undefined, limit: 100 }).items.find(person => person.id === personId) ?? (() => {
     const result = rows(`SELECT p.id,p.facebook_id facebookId,p.display_name displayName,p.username,p.profile_url profileUrl,p.profile_photo_path profilePhotoPath,p.cover_photo_path coverPhotoPath,p.first_seen firstSeen,p.last_seen lastSeen,p.relationship,p.identity_confidence identityConfidence,p.identity_source identitySource,p.source_paths sourcePaths,(SELECT json_group_array(ps.archive_part_id) FROM person_sources ps WHERE ps.person_id=p.id AND ps.archive_part_id IS NOT NULL) sourcePartIds,p.is_archive_owner isArchiveOwner,(SELECT COUNT(*) FROM messages m WHERE m.sender_id=p.id) messageCount,(SELECT COUNT(*) FROM posts po WHERE po.author_id=p.id) postCount,(SELECT COUNT(*) FROM comments co WHERE co.author_id=p.id) commentCount,(SELECT COUNT(*) FROM reactions re WHERE re.person_id=p.id) reactionCount,(SELECT COUNT(*) FROM connections cn WHERE cn.person_id=p.id) connectionCount,(SELECT COUNT(*) FROM albums al WHERE al.owner_id=p.id) albumCount,(SELECT COUNT(*) FROM media me WHERE (me.owner_type='post' AND me.owner_id IN (SELECT id FROM posts WHERE author_id=p.id)) OR (me.owner_type='message' AND me.owner_id IN (SELECT id FROM messages WHERE sender_id=p.id)) OR (me.owner_type='album' AND me.owner_id=p.id)) mediaCount,(SELECT COUNT(*) FROM posts po WHERE po.author_id=p.id) sharedPostCount,(SELECT COUNT(*) FROM media me WHERE me.owner_type='album' AND me.owner_id IN (SELECT id FROM albums WHERE owner_id=p.id)) sharedMediaCount,(SELECT COUNT(*) FROM conversations c WHERE c.participant_ids LIKE '%'||p.id||'%') participationCount,(SELECT MIN(value) FROM (SELECT sent_at value FROM messages WHERE sender_id=p.id UNION ALL SELECT created_at value FROM posts WHERE author_id=p.id UNION ALL SELECT created_at value FROM comments WHERE author_id=p.id UNION ALL SELECT created_at value FROM reactions WHERE person_id=p.id)) firstInteraction,(SELECT MAX(value) FROM (SELECT sent_at value FROM messages WHERE sender_id=p.id UNION ALL SELECT created_at value FROM posts WHERE author_id=p.id UNION ALL SELECT created_at value FROM comments WHERE author_id=p.id UNION ALL SELECT created_at value FROM reactions WHERE person_id=p.id)) lastInteraction FROM people p WHERE p.id=? LIMIT 1`, [personId]);
    return result[0] ? mapPerson(result[0]) : undefined;
  })();
}

function mapConnection(row: Record<string, unknown>): ConnectionSummary {
  return { id: String(row.id), personId: String(row.personId), displayName: String(row.displayName), facebookId: row.facebookId ? String(row.facebookId) : undefined, username: row.username ? String(row.username) : undefined, profileUrl: row.profileUrl ? String(row.profileUrl) : undefined, type: String(row.type) as Connection['type'], startedAt: row.startedAt ? String(row.startedAt) : undefined, endedAt: row.endedAt ? String(row.endedAt) : undefined, source: sourceRef(row) };
}
function mapAlbum(row: Record<string, unknown>): AlbumSummary {
  return { id: String(row.id), title: String(row.title), description: row.description ? String(row.description) : undefined, ownerId: row.ownerId ? String(row.ownerId) : undefined, createdAt: row.createdAt ? String(row.createdAt) : undefined, updatedAt: row.updatedAt ? String(row.updatedAt) : undefined, mediaIds: json<string[]>(row.mediaIdsJson, []), mediaCount: Number(row.mediaCount ?? 0), source: sourceRef(row) };
}
function connectionsPage(request: DatabaseRequest): Page<ConnectionSummary> {
  const limit = limitOf(request.limit), cursor = decode(request.cursor), conditions: string[] = [], bind: unknown[] = [];
  if (request.connectionType) { conditions.push('c.relationship_type=?'); bind.push(request.connectionType); }
  if (request.query?.trim()) { conditions.push('(c.display_name LIKE ? OR c.username LIKE ?)'); bind.push(`%${request.query.trim()}%`, `%${request.query.trim()}%`); }
  if (cursor) { conditions.push('(LOWER(c.display_name)>LOWER(?) OR (LOWER(c.display_name)=LOWER(?) AND c.id>?))'); bind.push(cursor.name, cursor.name, cursor.id); }
  const result = rows(`SELECT c.id,c.person_id personId,c.display_name displayName,c.facebook_id facebookId,c.username,c.profile_url profileUrl,c.relationship_type type,c.started_at startedAt,c.ended_at endedAt,c.source_path sourcePath,c.source_index sourceIndex,c.archive_part_id archivePartId FROM connections c ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''} ORDER BY LOWER(c.display_name),c.id LIMIT ?`, [...bind, limit + 1]);
  const hasMore = result.length > limit, items = result.slice(0, limit).map(mapConnection), last = items[items.length - 1];
  return { items, hasMore, nextCursor: hasMore && last ? encode({ name: last.displayName, id: last.id }) : undefined };
}
function albumsPage(request: DatabaseRequest): Page<AlbumSummary> {
  const limit = limitOf(request.limit), cursor = decode(request.cursor), conditions: string[] = [], bind: unknown[] = [];
  if (request.query?.trim()) { conditions.push('(a.title LIKE ? OR a.description LIKE ?)'); bind.push(`%${request.query.trim()}%`, `%${request.query.trim()}%`); }
  if (cursor) { conditions.push('(COALESCE(a.updated_at,a.created_at,\'\') < ? OR (COALESCE(a.updated_at,a.created_at,\'\') = ? AND a.id < ?))'); bind.push(cursor.key, cursor.key, cursor.id); }
  const result = rows(`SELECT a.id,a.title,a.description,a.owner_id ownerId,a.created_at createdAt,a.updated_at updatedAt,a.source_path sourcePath,a.source_index sourceIndex,a.archive_part_id archivePartId,(SELECT json_group_array(media_id) FROM album_media am WHERE am.album_id=a.id ORDER BY am.position) mediaIdsJson,(SELECT COUNT(*) FROM album_media am WHERE am.album_id=a.id) mediaCount FROM albums a ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''} ORDER BY COALESCE(a.updated_at,a.created_at,'') DESC,a.id DESC LIMIT ?`, [...bind, limit + 1]);
  const hasMore = result.length > limit, items = result.slice(0, limit).map(mapAlbum), last = items[items.length - 1];
  return { items, hasMore, nextCursor: hasMore && last ? encode({ key: last.updatedAt ?? last.createdAt ?? '', id: last.id }) : undefined };
}
function albumById(albumId?: string): { album: AlbumSummary; media: Media[] } | undefined {
  if (!albumId) return undefined;
  const row = rows(`SELECT a.id,a.title,a.description,a.owner_id ownerId,a.created_at createdAt,a.updated_at updatedAt,a.source_path sourcePath,a.source_index sourceIndex,a.archive_part_id archivePartId,(SELECT json_group_array(media_id) FROM album_media am WHERE am.album_id=a.id ORDER BY am.position) mediaIdsJson,(SELECT COUNT(*) FROM album_media am WHERE am.album_id=a.id) mediaCount FROM albums a WHERE a.id=? LIMIT 1`, [albumId])[0];
  if (!row) return undefined;
  const album = mapAlbum(row), media = rows('SELECT m.id,m.path,m.media_type mediaType,m.filename,m.mime_type mimeType,m.caption,m.timestamp,m.owner_type ownerType,m.owner_id ownerId,m.width,m.height,m.duration_ms durationMs,m.source_path sourcePath,m.source_index sourceIndex,m.archive_part_id archivePartId FROM media m JOIN album_media am ON am.media_id=m.id WHERE am.album_id=? ORDER BY am.position', [albumId]).map(mapMedia);
  return { album, media };
}

function safeFtsQuery(query: string) { return query.trim().split(/\s+/).filter(Boolean).map(token => `"${token.replaceAll('"', '""')}"`).join(' AND '); }
function search(request: DatabaseRequest): SearchResponse {
  const query = request.query?.trim() ?? '', limit = limitOf(request.limit), cursor = decode(request.cursor);
  if (!query) return { items: [], counts: {}, hasMore: false, backend: searchBackend };
  const importSession = currentImportState().session;
  const searchJob = importSession ? derivedJobRow(importSession.id, 'search') : undefined;
  if (importSession?.sourceStatus === 'complete' && searchJob && String(searchJob.status) !== 'complete') return { items: [], counts: {}, hasMore: false, backend: searchBackend, preparing: true };
  const fromDate = request.from?.length === 10 ? `${request.from}T00:00:00.000Z` : request.from;
  const toDate = request.to?.length === 10 ? `${request.to}T23:59:59.999Z` : request.to;
  const ftsQuery = safeFtsQuery(query);
  let result: Record<string, unknown>[] = [];
  if (searchBackend === 'fts5') {
    try {
      const rankExpr = 'bm25(archive_fts,0,0,5.0,1.5,1.0,0,0,0)';
      const bind: unknown[] = [ftsQuery]; const conditions = ['archive_fts MATCH ?'];
      if (request.entityType) { conditions.push('entity_type=?'); bind.push(request.entityType); }
      if (request.year) { conditions.push("substr(created_at,1,4)=?"); bind.push(String(request.year)); }
      if (fromDate) { conditions.push('created_at>=?'); bind.push(fromDate); }
      if (toDate) { conditions.push('created_at<=?'); bind.push(toDate); }
      if (cursor) { conditions.push(`(${rankExpr}>? OR (${rankExpr}=? AND (COALESCE(created_at,'')<? OR (COALESCE(created_at,'')=? AND (entity_id>? OR (entity_id=? AND rowid>?))))))`); bind.push(Number(cursor.rank ?? 0), Number(cursor.rank ?? 0), String(cursor.createdAt ?? ''), String(cursor.createdAt ?? ''), String(cursor.entityId ?? ''), String(cursor.entityId ?? ''), Number(cursor.rowid ?? 0)); }
      const sql = `SELECT rowid resultRowid,entity_type entityType,entity_id entityId,title,body,context,snippet(archive_fts,3,'[[H]]','[[/H]]','…',18) snippet,created_at createdAt,conversation_id conversationId,source_path sourcePath,${rankExpr} rank FROM archive_fts WHERE ${conditions.join(' AND ')} ORDER BY ${rankExpr} ASC,COALESCE(created_at,'') DESC,entity_id ASC,rowid ASC LIMIT ?`;
      bind.push(limit + 1); result = rows(sql, bind);
    } catch { searchBackend = 'like'; }
  }
  if (searchBackend === 'like') {
    const pattern = `%${query}%`, bind: unknown[] = [pattern, pattern, pattern]; const conditions = ['(title LIKE ? OR body LIKE ? OR context LIKE ?)'];
    if (request.entityType) { conditions.push('entity_type=?'); bind.push(request.entityType); }
    if (request.year) { conditions.push("substr(created_at,1,4)=?"); bind.push(String(request.year)); }
    if (fromDate) { conditions.push('created_at>=?'); bind.push(fromDate); }
    if (toDate) { conditions.push('created_at<=?'); bind.push(toDate); }
    if (cursor) { conditions.push("(COALESCE(created_at,'')<? OR (COALESCE(created_at,'')=? AND (entity_id>? OR (entity_id=? AND rowid>?)))"); bind.push(String(cursor.createdAt ?? ''), String(cursor.createdAt ?? ''), String(cursor.entityId ?? ''), String(cursor.entityId ?? ''), Number(cursor.rowid ?? 0)); }
    const sql = `SELECT rowid resultRowid,entity_type entityType,entity_id entityId,title,body,context,substr(COALESCE(body,title,context),1,240) snippet,created_at createdAt,conversation_id conversationId,source_path sourcePath FROM search_documents WHERE ${conditions.join(' AND ')} ORDER BY COALESCE(created_at,'') DESC,entity_id ASC,rowid ASC LIMIT ?`; bind.push(limit + 1); result = rows(sql, bind);
  }
  const hasMore = result.length > limit;
  const items = result.slice(0, limit).map(row => ({ entityType: String(row.entityType), entityId: String(row.entityId), title: row.title ? String(row.title) : undefined, body: row.body ? String(row.body) : undefined, context: row.context ? String(row.context) : undefined, snippet: row.snippet ? String(row.snippet) : undefined, createdAt: row.createdAt ? String(row.createdAt) : undefined, conversationId: row.conversationId ? String(row.conversationId) : undefined, sourcePath: row.sourcePath ? String(row.sourcePath) : undefined, rank: row.rank === undefined || row.rank === null ? undefined : Number(row.rank) } satisfies SearchResult));
  const counts = items.reduce<Record<string, number>>((acc, item) => { acc[item.entityType] = (acc[item.entityType] ?? 0) + 1; return acc; }, {});
  const last = result[Math.min(limit, result.length) - 1];
  return { items, counts, hasMore, nextCursor: hasMore && last ? encode({ rank: last.rank === undefined ? 0 : Number(last.rank), createdAt: last.createdAt ? String(last.createdAt) : '', entityId: String(last.entityId), rowid: Number(last.resultRowid ?? 0) }) : undefined, backend: searchBackend };
}

function rebuildSearchFromDatabase() {
  // Legacy databases are rebuilt with the same set-based SQL used by the
  // resumable M10 job; avoid hydrating every message into JavaScript during
  // startup.
  rebuildSearchFromTables();
}

function backfillPeopleFromLegacyTables() {
  if (Number(rows('SELECT COUNT(*) count FROM people')[0]?.count ?? 0) > 0) return;
  const profile = rows('SELECT person_id personId,display_name displayName,username,source_path sourcePath FROM profiles LIMIT 1')[0];
  if (profile) db.exec({ sql: 'INSERT OR IGNORE INTO people(id,display_name,username,identity_confidence,identity_source,source_paths,is_archive_owner) VALUES(?,?,?,?,?,?,1)', bind: [String(profile.personId), String(profile.displayName), profile.username ? String(profile.username) : null, 'exact', String(profile.sourcePath), JSON.stringify([String(profile.sourcePath)])] });
  const conversations = rows('SELECT id,participant_names participantNamesJson FROM conversations');
  for (const conversation of conversations) {
    const ids = json<string[]>(conversation.participantNamesJson, []).map(name => `person:legacy:${String(conversation.id)}:${String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-')}`);
    db.exec({ sql: 'UPDATE conversations SET participant_ids=? WHERE id=?', bind: [JSON.stringify(ids), String(conversation.id)] });
    json<string[]>(conversation.participantNamesJson, []).forEach((name, index) => db.exec({ sql: 'INSERT OR IGNORE INTO people(id,display_name,identity_confidence,identity_source,source_paths) VALUES(?,?,?,?,?)', bind: [ids[index], name, 'ambiguous', 'legacy conversation', JSON.stringify([])] }));
  }
  const messages = rows('SELECT id,conversation_id conversationId,sender_name senderName FROM messages WHERE sender_name IS NOT NULL');
  for (const message of messages) {
    const id = `person:legacy:${String(message.conversationId)}:${String(message.senderName).toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
    db.exec({ sql: 'UPDATE messages SET sender_id=? WHERE id=?', bind: [id, String(message.id)] });
  }
}

function identityFromRow(row?: Record<string, unknown>): ArchiveIdentity | undefined {
  if (!row) return undefined;
  return { filename: String(row.filename), size: Number(row.size), entryCount: Number(row.entryCount), fingerprint: String(row.fingerprint), knownEntries: json<string[]>(row.knownEntries, []) };
}

function archiveSetFromRow(row?: Record<string, unknown>) {
  if (!row) return undefined;
  return { id: String(row.id), platform: 'facebook' as const, createdAt: Number(row.createdAt), partCount: Number(row.partCount), totalSize: Number(row.totalSize), fingerprint: String(row.fingerprint), importedAt: row.importedAt ? String(row.importedAt) : undefined, status: String(row.status) as 'complete' | 'incomplete' | 'failed', sourceFormat: row.sourceFormat ? String(row.sourceFormat) as ArchiveSet['sourceFormat'] : undefined };
}
function archivePartFromRow(row: Record<string, unknown>) {
  return { id: String(row.id), archiveId: String(row.archiveId), partIndex: Number(row.partIndex), filename: String(row.filename), fileSize: Number(row.fileSize), entryCount: Number(row.entryCount), manifestFingerprint: String(row.manifestFingerprint), connected: Number(row.connected ?? 0) === 1, status: String(row.status) as ArchivePart['status'], warningCount: Number(row.warningCount ?? 0), sections: json<string[]>(row.sections, []), sourceFormat: row.sourceFormat ? String(row.sourceFormat) as ArchivePart['sourceFormat'] : undefined };
}
function archiveStatus() {
  const set = archiveSetFromRow(rows('SELECT id,platform,created_at createdAt,part_count partCount,total_size totalSize,fingerprint,imported_at importedAt,status,source_format sourceFormat FROM archive_sets ORDER BY created_at DESC LIMIT 1')[0]);
  const parts = rows('SELECT id,archive_id archiveId,part_index partIndex,filename,file_size fileSize,entry_count entryCount,manifest_fingerprint manifestFingerprint,connected,status,warning_count warningCount,sections,source_format sourceFormat FROM archive_parts ORDER BY part_index,id').map(archivePartFromRow);
  return { archiveSet: set, parts, connectedPartIds: parts.filter(part => part.connected).map(part => part.id), missingPartIds: parts.filter(part => !part.connected).map(part => part.id) };
}

function stats(): ArchiveStats {
  const count = (table: string) => Number(rows(`SELECT COUNT(*) count FROM ${table}`)[0]?.count ?? 0);
  const range = rows("SELECT MIN(occurred_at) earliest,MAX(occurred_at) latest FROM activity_records WHERE occurred_at IS NOT NULL")[0];
  const years = rows("SELECT DISTINCT calendar_year year FROM activity_records WHERE calendar_year IS NOT NULL ORDER BY calendar_year DESC").map(row => Number(row.year));
  const diagnostics = json<NormalizedArchiveData['diagnostics'] | undefined>(rows("SELECT value FROM import_metadata WHERE key='diagnostics'")[0]?.value, undefined);
  const identity = identityFromRow(rows('SELECT filename,size,entry_count entryCount,fingerprint,known_entries knownEntries FROM archive_identity WHERE id=1')[0]);
  const source = archiveStatus();
  const state = currentImportState();
  return { profiles: count('profiles'), people: count('people'), posts: count('posts'), comments: count('comments'), reactions: count('reactions'), connections: count('connections'), albums: count('albums'), activities: count('activity_records'), conversations: count('conversations'), messages: count('messages'), media: count('media'), earliest: range?.earliest ? String(range.earliest) : undefined, latest: range?.latest ? String(range.latest) : undefined, warnings: Number(rows("SELECT value FROM import_metadata WHERE key='warning_count'")[0]?.value ?? 0), sections: Number(rows("SELECT value FROM import_metadata WHERE key='section_count'")[0]?.value ?? 0), years, diagnostics, archiveIdentity: identity, archiveSet: source.archiveSet, archiveParts: source.parts, importSession: state.session, coverage: state.coverage, derivedIndexes: state.derivedIndexes };
}

async function init() {
  const sqlite3 = await sqlite3InitModule(); sqliteRuntime = sqlite3;
  let savedSnapshot: Uint8Array | undefined; let savedLegacy: NormalizedArchiveData | undefined; let savedState: ImportState | undefined;
  if (sqlite3.oo1.OpfsDb) {
    try { const OpfsDb = sqlite3.oo1.OpfsDb as unknown as new (filename: string, flags: string) => DB; db = new OpfsDb('/socialvault.sqlite3', 'c'); mode = 'opfs'; }
    catch { db = new sqlite3.oo1.DB(':memory:', 'c') as unknown as DB; mode = 'indexeddb'; }
  } else db = new sqlite3.oo1.DB(':memory:', 'c') as unknown as DB;
  if (mode === 'indexeddb') { try { savedSnapshot = await getFallbackSnapshot(); if (!savedSnapshot) savedLegacy = await getFallback(); savedState = await getFallbackImportState(); } catch { /* in-memory SQLite remains usable when IndexedDB is unavailable or corrupt */ } }
  if (savedSnapshot && sqliteRuntime?.capi?.sqlite3_deserialize && db.pointer) {
    try { const pointer = sqliteRuntime.wasm.allocFromTypedArray(savedSnapshot); const flags = sqliteRuntime.capi.SQLITE_DESERIALIZE_RESIZEABLE | sqliteRuntime.capi.SQLITE_DESERIALIZE_FREEONCLOSE; const rc = sqliteRuntime.capi.sqlite3_deserialize(db.pointer, 'main', pointer, savedSnapshot.byteLength, savedSnapshot.byteLength, flags); if (rc !== 0) savedSnapshot = undefined; } catch { savedSnapshot = undefined; }
  }
  applyMigrations(); backfillArchiveSet(); backfillPeopleFromLegacyTables(); setupSearch();
  if (savedLegacy) { fallbackData = metadataSnapshot(savedLegacy); replace(savedLegacy); }
  if (savedState) restoreImportState(savedState);
  ensureLegacyImportSession();
  // Existing pre-M10 databases may have base rows but no derived job state.
  // Rebuild only that legacy case; active import sessions are resumed through
  // the explicit incremental jobs below and are never materialized here.
  const legacySession = currentImportState().session;
  const legacySourceRows = ['people', 'posts', 'comments', 'reactions', 'connections', 'albums', 'conversations', 'messages', 'media', 'profile_facts'].reduce((total, table) => total + Number(rows(`SELECT COUNT(*) count FROM ${table}`)[0]?.count ?? 0), 0);
  if (legacySession?.sourceStatus === 'complete' && legacySession.derivedStatus !== 'complete' && legacySourceRows > 0 && !rows('SELECT 1 FROM derived_index_jobs LIMIT 1').length) {
    try { rebuildSearchFromDatabase(); rebuildActivityIndex(); updateImportSession(legacySession.id, { sourceStatus: 'complete', derivedStatus: 'complete', derivedPhase: 'complete', derivedRows: Number(rows('SELECT COUNT(*) count FROM activity_records')[0]?.count ?? 0), derivedTotal: Number(rows('SELECT COUNT(*) count FROM activity_records')[0]?.count ?? 0), currentStage: 'complete', status: 'complete' }); } catch { /* old data remains browsable even if a legacy rebuild is not possible */ }
  }
  return { mode, searchBackend };
}

self.onmessage = async (event: MessageEvent<DatabaseRequest>) => {
  const request = event.data;
  try {
    if (request.type === 'init') { send({ id: request.id, ok: true, data: await init() }); return; }
    if (request.type === 'storage-status') { send({ id: request.id, ok: true, data: { mode, searchBackend } }); return; }
    if (request.type === 'replace' && request.data) { await withStorageFallback(() => replace(request.data!)); await persistFallback(); send({ id: request.id, ok: true }); return; }
    if (request.type === 'import-state') { send({ id: request.id, ok: true, data: currentImportState(request.sessionId) }); return; }
    if (request.type === 'begin-import') { preferIndexedDbForArchive(request.data?.archiveSet); const state = await withStorageFallback(() => beginImportSession(request.session, request.data?.archiveParts ?? [], request.data?.archiveSet, request.data?.archiveIdentity)); await persistFallback(); send({ id: request.id, ok: true, data: state }); return; }
    if (request.type === 'import-batch' && request.data && request.part && request.sessionId) { const checkpoint = await withStorageFallback(() => importBatchData(request.data!, request.part!, request.sessionId!)); batchesSinceFallback++; if (batchesSinceFallback >= 256) { batchesSinceFallback = 0; await persistFallback(false); } send({ id: request.id, ok: true, data: checkpoint }); return; }
    if (request.type === 'import-part' && request.data && request.part && request.sessionId) { const checkpoint = await withStorageFallback(() => importPartData(request.data!, request.part!, request.sessionId!)); batchesSinceFallback = 0; await persistFallback(true); send({ id: request.id, ok: true, data: checkpoint }); return; }
    if (request.type === 'update-media-sources' && request.data) { await withStorageFallback(() => transaction(() => request.data!.media.forEach(item => db.exec({ sql: 'UPDATE media SET archive_part_id=? WHERE id=?', bind: [item.source.archivePartId ?? null, item.id] })))); await persistFallback(false); send({ id: request.id, ok: true }); return; }
    if (request.type === 'update-import' && request.sessionId) { const patch = request.session ?? ({ status: request.status, lastError: request.errorMessage } as Partial<ImportSession>); const session = await withStorageFallback(() => updateImportSession(request.sessionId!, patch as Partial<ImportSession>)); await persistFallback(patch.status === 'complete'); send({ id: request.id, ok: true, data: session }); return; }
    if (request.type === 'cancel-import' && request.sessionId) { if (activeDerivedSession === request.sessionId) derivedCancelRequested = true; const session = await withStorageFallback(() => updateImportSession(request.sessionId!, { status: 'cancelled', currentStage: 'cancelled', derivedStatus: activeDerivedSession === request.sessionId ? 'interrupted' : undefined })); await persistFallback(); send({ id: request.id, ok: true, data: session }); return; }
    if (request.type === 'interrupt-import' && request.sessionId) { const session = await withStorageFallback(() => updateImportSession(request.sessionId!, { status: 'interrupted', currentStage: 'interrupted', lastError: request.errorMessage })); await persistFallback(); send({ id: request.id, ok: true, data: session }); return; }
    if (request.type === 'skip-import-part' && request.sessionId && request.part) { const checkpoint = await withStorageFallback(() => checkpointPart(request.sessionId!, request.part!, 'skipped', request.errorMessage)); await persistFallback(); send({ id: request.id, ok: true, data: checkpoint }); return; }
    if (request.type === 'fail-import-part' && request.sessionId && request.part) { const checkpoint = await withStorageFallback(() => checkpointPart(request.sessionId!, request.part!, 'failed', request.errorMessage)); await persistFallback(); send({ id: request.id, ok: true, data: checkpoint }); return; }
    if (request.type === 'retry-import-part' && request.sessionId && request.part) {
      await withStorageFallback(() => {
        const now = new Date().toISOString();
        db.exec({ sql: 'INSERT OR REPLACE INTO import_part_checkpoints(session_id,archive_part_id,part_index,manifest_fingerprint,status,updated_at,parser_version,record_counts,warnings_count,error,sections) VALUES(?,?,?,?,?,?,?,?,?,?,?)', bind: [request.sessionId, request.part!.id, request.part!.partIndex, request.part!.manifestFingerprint, 'pending', now, FACEBOOK_PARSER_VERSION, JSON.stringify({}), 0, null, JSON.stringify(request.part!.sections ?? [])] });
        db.exec({ sql: 'UPDATE archive_parts SET status=?,connected=? WHERE id=?', bind: ['pending', request.part!.connected ? 1 : 0, request.part!.id] });
        const current = currentImportState(request.sessionId!);
        if (current.session) updateImportSession(request.sessionId!, { status: 'importing', currentStage: 'parsing', failedPartIds: (current.session.failedPartIds ?? []).filter(id => id !== request.part!.id), skippedPartIds: (current.session.skippedPartIds ?? []).filter(id => id !== request.part!.id), failedPartCount: current.checkpoints.filter(item => item.status === 'failed').length, skippedPartCount: current.checkpoints.filter(item => item.status === 'skipped').length });
        return currentImportState(request.sessionId!);
      });
      await persistFallback(); send({ id: request.id, ok: true, data: currentImportState(request.sessionId) }); return;
    }
    if (request.type === 'restart-import') { await withStorageFallback(() => clearArchiveData()); if (mode === 'indexeddb') { await putFallback(); await clearFallbackImportState(); } send({ id: request.id, ok: true }); return; }
    if (request.type === 'rebuild-search') { const result = await withStorageFallback(() => runDerivedIndex('search', request.id, request.force)); await persistFallback(); send({ id: request.id, ok: true, data: result }); return; }
    if (request.type === 'rebuild-activity') { const result = await withStorageFallback(() => runDerivedIndex('activity', request.id, request.force)); await persistFallback(); send({ id: request.id, ok: true, data: result }); return; }
    if (request.type === 'coverage') { send({ id: request.id, ok: true, data: coverageFromDatabase() }); return; }
    if (request.type === 'diagnostics') { send({ id: request.id, ok: true, data: diagnosticsFromDatabase() }); return; }
    if (request.type === 'profile') { const row = rows("SELECT pr.id,pr.person_id personId,pr.display_name displayName,pr.username,pr.bio,pr.joined_at joinedAt,pr.source_path sourcePath,(SELECT archive_part_id FROM source_records sr WHERE sr.entity_type='profile' AND sr.entity_id=pr.id LIMIT 1) archivePartId,p.facebook_id facebookId,p.profile_url profileUrl,p.relationship,p.profile_photo_path profilePhotoPath,p.cover_photo_path coverPhotoPath,(SELECT json_group_array(json_object('id',f.id,'category',f.category,'label',f.label,'value',f.value,'startDate',f.start_date,'endDate',f.end_date,'source',json_object('platform','facebook','path',f.source_path,'index',f.source_index,'archivePartId',f.archive_part_id))) FROM profile_facts f WHERE f.profile_id=pr.id) factsJson FROM profiles pr LEFT JOIN people p ON p.id=pr.person_id LIMIT 1")[0]; send({ id: request.id, ok: true, data: mapProfile(row) }); return; }
    if (request.type === 'people') { send({ id: request.id, ok: true, data: peoplePage(request) }); return; }
    if (request.type === 'person') { send({ id: request.id, ok: true, data: personById(request.personId) }); return; }
    if (request.type === 'posts') { send({ id: request.id, ok: true, data: postPage(request) }); return; }
    if (request.type === 'post') { send({ id: request.id, ok: true, data: postById(request.postId) }); return; }
    if (request.type === 'conversations') { send({ id: request.id, ok: true, data: conversationPage(request) }); return; }
    if (request.type === 'messages') { send({ id: request.id, ok: true, data: messagePage(request) }); return; }
    if (request.type === 'media') { send({ id: request.id, ok: true, data: mediaPage(request) }); return; }
    if (request.type === 'connections') { send({ id: request.id, ok: true, data: connectionsPage(request) }); return; }
    if (request.type === 'albums') { send({ id: request.id, ok: true, data: albumsPage(request) }); return; }
    if (request.type === 'album') { send({ id: request.id, ok: true, data: albumById(request.albumId) }); return; }
    if (request.type === 'memories') { send({ id: request.id, ok: true, data: memories(request.month, request.day, request.limit) }); return; }
    if (request.type === 'activity') { send({ id: request.id, ok: true, data: activityPage(request) }); return; }
    if (request.type === 'search') { send({ id: request.id, ok: true, data: search(request) }); return; }
    if (request.type === 'stats') { send({ id: request.id, ok: true, data: stats() }); return; }
    if (request.type === 'archive-identity') { send({ id: request.id, ok: true, data: identityFromRow(rows('SELECT filename,size,entry_count entryCount,fingerprint,known_entries knownEntries FROM archive_identity WHERE id=1')[0]) }); return; }
    if (request.type === 'archive-status') { send({ id: request.id, ok: true, data: archiveStatus() }); return; }
    if (request.type === 'media-cache' && request.mediaPath) { await withStorageFallback(() => db.exec({ sql: 'INSERT OR REPLACE INTO media_cache(path,last_accessed,byte_size) VALUES(?,?,?)', bind: [request.mediaPath, new Date().toISOString(), request.byteSize ?? null] })); send({ id: request.id, ok: true }); return; }
  } catch (error) { send({ id: request.id, ok: false, error: error instanceof Error ? error.message : String(error) }); }
};
