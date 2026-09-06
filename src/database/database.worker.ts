/// <reference lib="webworker" />
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { clearFallbackImportState, getFallback, getFallbackImportState, putFallback, putFallbackImportState } from './indexeddb-fallback';
import { FTS5_SCHEMA, MIGRATIONS, SCHEMA_VERSION } from './schema';
import { archivePartId, archiveSetFingerprint, archiveSetId, mergeNormalizedData } from '../archive/archive-set';
import type { AlbumSummary, ArchiveStats, ConnectionSummary, ConversationPreview, DatabaseRequest, DatabaseResponse, ImportState, MemoryRecord, Page, PersonSummary, RebuildResult, SearchBackend, SearchResponse, SearchResult, StorageMode } from './types';
import type { ActivityRecord, ActivityType, Album, ArchiveCoverage, ArchiveIdentity, ArchivePart, ArchiveSet, Comment, Connection, Conversation, ImportCounts, ImportDiagnostics, ImportPartCheckpoint, ImportSectionStatus, ImportSession, Media, Message, NormalizedArchiveData, Person, Post, Profile, ProfileFact, Reaction, SourceRef } from '../archive/schemas/models';
import { FACEBOOK_PARSER_VERSION } from '../archive/adapters/version';
import { createDiagnosticsReport } from './diagnostics';

type DB = { exec: (options: string | Record<string, unknown>) => unknown; transaction: (fn: () => void) => void };
let db: DB;
let mode: StorageMode = 'indexeddb';
let searchBackend: SearchBackend = 'like';
let fallbackData: NormalizedArchiveData | undefined;
let batchesSinceFallback = 0;

const send = (message: DatabaseResponse) => postMessage(message);
const rows = (sql: string, bind: unknown[] = []): Record<string, unknown>[] => db.exec({ sql, bind, returnValue: 'resultRows', rowMode: 'object' } as Record<string, unknown>) as Record<string, unknown>[];
const limitOf = (value?: number) => Math.min(100, Math.max(1, value ?? 20));
const SQLITE_BATCH_SIZE = 2000;
/** Keep SQLite writes bounded while avoiding one worker round-trip per record.
 * 2000 rows stays below SQLite's default variable limit even for the widest
 * normalized table (15 columns) while making large HTML imports materially
 * faster. */
function batchInsert(table: string, columns: string[], values: unknown[][], conflict = '') {
  if (!values.length) return;
  const placeholders = `(${columns.map(() => '?').join(',')})`;
  for (let offset = 0; offset < values.length; offset += SQLITE_BATCH_SIZE) {
    const chunk = values.slice(offset, offset + SQLITE_BATCH_SIZE);
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
    db.transaction(() => migration.statements.forEach(statement => db.exec(statement)));
    db.exec({ sql: 'INSERT INTO schema_migrations(version,applied_at) VALUES(?,?)', bind: [migration.version, new Date().toISOString()] });
  }
  db.exec('PRAGMA optimize');
}

/** Upgrade a v5 single-ZIP database in place: the old identity becomes part 1. */
function backfillArchiveSet() {
  const legacy = rows('SELECT filename,size,entry_count entryCount,fingerprint,known_entries knownEntries FROM archive_identity WHERE id=1')[0];
  if (!legacy || Number(rows('SELECT COUNT(*) count FROM archive_sets')[0]?.count ?? 0) > 0) return;
  const fingerprint = String(legacy.fingerprint); const archiveId = archiveSetId(fingerprint); const partId = archivePartId(fingerprint);
  db.transaction(() => {
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
    currentStage: String(row.currentStage) as ImportSession['currentStage'], status: String(row.status) as ImportSession['status'], normalizedCounts: countsFrom(row.normalizedCounts), warningsCount: Number(row.warningsCount ?? 0), failedPartIds: json<string[]>(row.failedPartIds, []), skippedPartIds: json<string[]>(row.skippedPartIds, []), detectedSections: json<string[]>(row.detectedSections, []), importedSections: json<string[]>(row.importedSections, []), coverage: json<ArchiveCoverage | undefined>(row.coverage, undefined), lastError: row.lastError ? String(row.lastError) : undefined, metrics: json<ImportSession['metrics']>(row.metrics, undefined),
  };
}
function checkpointFromRow(row: Record<string, unknown>): ImportPartCheckpoint {
  return { sessionId: String(row.sessionId), archivePartId: String(row.archivePartId), partIndex: Number(row.partIndex), manifestFingerprint: String(row.manifestFingerprint), status: String(row.status) as ImportPartCheckpoint['status'], startedAt: row.startedAt ? String(row.startedAt) : undefined, updatedAt: String(row.updatedAt), completedAt: row.completedAt ? String(row.completedAt) : undefined, parserVersion: Number(row.parserVersion), recordCounts: json<Partial<ImportCounts>>(row.recordCounts, {}), warningsCount: Number(row.warningsCount ?? 0), error: row.error ? String(row.error) : undefined, sections: json<string[]>(row.sections, []) };
}
function currentImportState(sessionId?: string): ImportState {
  const row = rows(`SELECT id,archive_set_id archiveSetId,started_at startedAt,updated_at updatedAt,parser_version parserVersion,schema_version schemaVersion,expected_part_count expectedPartCount,inspected_part_count inspectedPartCount,imported_part_count importedPartCount,failed_part_count failedPartCount,skipped_part_count skippedPartCount,current_stage currentStage,status,normalized_counts normalizedCounts,warnings_count warningsCount,failed_part_ids failedPartIds,skipped_part_ids skippedPartIds,detected_sections detectedSections,imported_sections importedSections,coverage,last_error lastError,metrics FROM import_sessions ${sessionId ? 'WHERE id=?' : 'ORDER BY updated_at DESC'} LIMIT 1`, sessionId ? [sessionId] : []);
  const session = sessionFromRow(row[0]);
  const checkpoints = session ? rows('SELECT session_id sessionId,archive_part_id archivePartId,part_index partIndex,manifest_fingerprint manifestFingerprint,status,started_at startedAt,updated_at updatedAt,completed_at completedAt,parser_version parserVersion,record_counts recordCounts,warnings_count warningsCount,error,sections FROM import_part_checkpoints WHERE session_id=? ORDER BY part_index,archive_part_id', [session.id]).map(checkpointFromRow) : [];
  return { session, checkpoints, coverage: session?.coverage };
}
function upsertSession(session: ImportSession) {
  db.exec({ sql: 'INSERT OR REPLACE INTO import_sessions(id,archive_set_id,started_at,updated_at,parser_version,schema_version,expected_part_count,inspected_part_count,imported_part_count,failed_part_count,skipped_part_count,current_stage,status,normalized_counts,warnings_count,failed_part_ids,skipped_part_ids,detected_sections,imported_sections,coverage,last_error,metrics) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', bind: [session.id, session.archiveSetId, session.startedAt, session.updatedAt, session.parserVersion, session.schemaVersion, session.expectedPartCount, session.inspectedPartCount, session.importedPartCount, session.failedPartCount, session.skippedPartCount, session.currentStage, session.status, JSON.stringify(session.normalizedCounts), session.warningsCount, JSON.stringify(session.failedPartIds ?? []), JSON.stringify(session.skippedPartIds ?? []), JSON.stringify(session.detectedSections ?? []), JSON.stringify(session.importedSections ?? []), session.coverage ? JSON.stringify(session.coverage) : null, session.lastError ?? null, session.metrics ? JSON.stringify(session.metrics) : null] });
}
function ensureLegacyImportSession() {
  const archive = rows('SELECT id,part_count partCount,status FROM archive_sets ORDER BY created_at DESC LIMIT 1')[0];
  if (!archive || rows('SELECT 1 FROM import_sessions LIMIT 1').length) return;
  const now = new Date().toISOString(); const archiveId = String(archive.id); const counts = emptyCounts();
  for (const [key, table] of Object.entries({ profiles: 'profiles', people: 'people', posts: 'posts', comments: 'comments', reactions: 'reactions', connections: 'connections', albums: 'albums', conversations: 'conversations', messages: 'messages', media: 'media', activities: 'activity_records' })) counts[key as keyof ImportCounts] = Number(rows(`SELECT COUNT(*) count FROM ${table}`)[0]?.count ?? 0);
  const sections = json<string[]>(rows("SELECT value FROM import_metadata WHERE key='sections'")[0]?.value, []);
  const session: ImportSession = { id: sessionIdForArchive(archiveId), archiveSetId: archiveId, startedAt: now, updatedAt: now, parserVersion: FACEBOOK_PARSER_VERSION, schemaVersion: SCHEMA_VERSION, expectedPartCount: Number(archive.partCount ?? 0), inspectedPartCount: Number(archive.partCount ?? 0), importedPartCount: Number(archive.partCount ?? 0), failedPartCount: 0, skippedPartCount: 0, currentStage: 'complete', status: archive.status === 'complete' ? 'complete' : 'interrupted', normalizedCounts: counts, warningsCount: Number(rows("SELECT value FROM import_metadata WHERE key='warning_count'")[0]?.value ?? 0), detectedSections: sections, importedSections: sections, coverage: { detectedSections: sections, importedSections: sections, partialSections: [], unsupportedSections: [], malformedSections: [], skippedParts: [] } };
  db.transaction(() => { upsertSession(session); rows('SELECT id,part_index partIndex,manifest_fingerprint manifestFingerprint,status FROM archive_parts WHERE archive_id=? ORDER BY part_index', [archiveId]).forEach(row => db.exec({ sql: 'INSERT OR REPLACE INTO import_part_checkpoints(session_id,archive_part_id,part_index,manifest_fingerprint,status,updated_at,completed_at,parser_version,record_counts,warnings_count,sections) VALUES(?,?,?,?,?,?,?,?,?,?,?)', bind: [session.id, String(row.id), Number(row.partIndex), String(row.manifestFingerprint), 'complete', now, now, FACEBOOK_PARSER_VERSION, JSON.stringify(counts), 0, JSON.stringify(sections)] })); });
}
function restoreImportState(state?: ImportState) {
  if (!state?.session) return;
  db.transaction(() => {
    upsertSession(state.session!);
    db.exec({ sql: 'DELETE FROM import_part_checkpoints WHERE session_id=?', bind: [state.session!.id] });
    for (const checkpoint of state.checkpoints) db.exec({ sql: 'INSERT OR REPLACE INTO import_part_checkpoints(session_id,archive_part_id,part_index,manifest_fingerprint,status,started_at,updated_at,completed_at,parser_version,record_counts,warnings_count,error,sections) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)', bind: [checkpoint.sessionId, checkpoint.archivePartId, checkpoint.partIndex, checkpoint.manifestFingerprint, checkpoint.status, checkpoint.startedAt ?? null, checkpoint.updatedAt, checkpoint.completedAt ?? null, checkpoint.parserVersion, JSON.stringify(checkpoint.recordCounts ?? {}), checkpoint.warningsCount, checkpoint.error ?? null, JSON.stringify(checkpoint.sections ?? [])] });
  });
}

function setupSearch() {
  try { db.exec(FTS5_SCHEMA); searchBackend = 'fts5'; } catch { searchBackend = 'like'; }
}

function normalizedData(data: Partial<NormalizedArchiveData>): NormalizedArchiveData {
  return { ...data, people: data.people ?? [], profileFacts: data.profileFacts ?? data.profile?.facts ?? [], posts: data.posts ?? [], comments: data.comments ?? [], reactions: data.reactions ?? [], connections: data.connections ?? [], albums: data.albums ?? [], conversations: data.conversations ?? [], messages: data.messages ?? [], media: data.media ?? [], warnings: data.warnings ?? [] };
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

function rebuildSearch(data: NormalizedArchiveData) {
  db.exec('DELETE FROM search_documents');
  if (searchBackend === 'fts5') db.exec('DELETE FROM archive_fts');
  const documents: { type: string; id: string; title?: string; body?: string; context?: string; createdAt?: string; conversationId?: string; source?: string }[] = [];
  const personIds = new Set<string>();
  for (const person of data.people ?? []) { personIds.add(person.id); documents.push({ type: 'person', id: person.id, title: person.displayName, body: [person.username, person.relationship].filter(Boolean).join(' '), context: person.facebookId, source: person.identitySource ?? person.sourcePaths?.[0] }); }
  if (data.profile && !personIds.has(data.profile.id)) documents.push({ type: 'person', id: data.profile.id, title: data.profile.displayName, body: [data.profile.username, data.profile.bio].filter(Boolean).join(' '), source: data.profile.source.path });
  for (const fact of data.profileFacts ?? []) documents.push({ type: 'profile-fact', id: `fact:${fact.id}`, title: fact.category, body: [fact.label, fact.value].filter(Boolean).join(' '), context: `${fact.startDate ?? ''} ${fact.endDate ?? ''}`, source: fact.source.path });
  for (const post of data.posts) documents.push({ type: 'post', id: post.id, title: post.title, body: post.text, context: [post.createdAt, ...(post.links ?? [])].filter(Boolean).join(' '), createdAt: post.createdAt, source: post.source.path });
  for (const comment of data.comments ?? []) documents.push({ type: 'comment', id: comment.id, title: comment.authorName, body: comment.text, context: comment.postId, createdAt: comment.createdAt, source: comment.source.path });
  for (const reaction of data.reactions ?? []) documents.push({ type: 'reaction', id: reaction.id, title: reaction.kind, body: reaction.personName, context: reaction.targetId, createdAt: reaction.createdAt, source: reaction.source.path });
  for (const connection of data.connections ?? []) documents.push({ type: 'connection', id: connection.id, title: connection.displayName, body: [connection.type, connection.username].filter(Boolean).join(' '), context: connection.startedAt ?? connection.endedAt, createdAt: connection.startedAt ?? connection.endedAt, source: connection.source.path });
  for (const album of data.albums ?? []) documents.push({ type: 'album', id: album.id, title: album.title, body: album.description, context: album.createdAt, createdAt: album.updatedAt ?? album.createdAt, source: album.source.path });
  for (const item of data.media ?? []) documents.push({ type: 'media', id: item.id, title: item.filename ?? item.path.split('/').pop(), body: item.caption, context: item.path, createdAt: item.timestamp, source: item.source.path });
  const titles = new Map(data.conversations.map(conversation => [conversation.id, conversation.title ?? 'Conversation']));
  for (const conversation of data.conversations) documents.push({ type: 'conversation', id: conversation.id, title: conversation.title, body: conversation.participantNames.join(' '), context: conversation.participantNames.join(', '), source: conversation.source.path });
  for (const message of data.messages) documents.push({ type: 'message', id: message.id, title: titles.get(message.conversationId), body: message.text, context: [message.senderName, message.sentAt].filter(Boolean).join(' '), createdAt: message.sentAt, conversationId: message.conversationId, source: message.source.path });
  batchInsert('search_documents', ['entity_type', 'entity_id', 'title', 'body', 'context', 'created_at', 'conversation_id', 'source_path'], documents.map(document => [document.type, document.id, document.title ?? null, document.body ?? null, document.context ?? null, document.createdAt ?? null, document.conversationId ?? null, document.source ?? null]));
  if (searchBackend === 'fts5') batchInsert('archive_fts', ['entity_type', 'entity_id', 'title', 'body', 'context', 'created_at', 'conversation_id', 'source_path'], documents.map(document => [document.type, document.id, document.title ?? '', document.body ?? '', document.context ?? '', document.createdAt ?? '', document.conversationId ?? '', document.source ?? '']));
}

const calendarParts = (timestamp: string) => { const value = new Date(timestamp); return { month: value.getUTCMonth() + 1, day: value.getUTCDate(), year: value.getUTCFullYear() }; };
const compact = (value?: string) => value?.replace(/\s+/g, ' ').trim().slice(0, 160);
function activityForData(data: NormalizedArchiveData): ActivityRecord[] {
  const records: ActivityRecord[] = [];
  const add = (id: string, type: ActivityType, timestamp: string | undefined, summary: string, source: SourceRef, actorPersonId?: string, targetType?: string, targetId?: string) => {
    if (!timestamp || !Number.isFinite(new Date(timestamp).getTime())) return;
    records.push({ id, type, actorPersonId, targetType, targetId, timestamp, summary, source: { ...source, platform: 'facebook' } });
  };
  if (data.profile) add(`activity:profile:${data.profile.id}`, 'profile', data.profile.joinedAt, `Profile: ${data.profile.displayName}`, data.profile.source, data.profile.personId, 'profile', data.profile.id);
  for (const post of data.posts) add(`activity:post:${post.id}`, 'post', post.createdAt, `Posted${post.title ? ` “${post.title}”` : post.text ? ` “${compact(post.text)}”` : ''}`, post.source, post.authorId === 'owner' ? data.profile?.personId : post.authorId, 'post', post.id);
  for (const comment of data.comments) add(`activity:comment:${comment.id}`, 'comment', comment.createdAt, `Commented${comment.authorName ? ` as ${comment.authorName}` : ''}: “${compact(comment.text) ?? ''}”`, comment.source, comment.authorId, 'post', comment.postId);
  for (const reaction of data.reactions) add(`activity:reaction:${reaction.id}`, 'reaction', reaction.createdAt, `Reacted ${reaction.kind}${reaction.personName ? ` as ${reaction.personName}` : ''}`, reaction.source, reaction.personId, reaction.targetType, reaction.targetId);
  for (const message of data.messages) add(`activity:message:${message.id}`, 'message', message.sentAt, `Message${message.senderName ? ` from ${message.senderName}` : ''}${message.text ? `: “${compact(message.text)}”` : ''}`, message.source, message.senderId, 'conversation', message.conversationId);
  for (const connection of data.connections) add(`activity:connection:${connection.id}`, 'connection', connection.startedAt ?? connection.endedAt, `${connection.type.replaceAll('_', ' ')}: ${connection.displayName}`, connection.source, connection.personId, 'person', connection.personId);
  for (const album of data.albums) add(`activity:album:${album.id}`, 'album', album.createdAt ?? album.updatedAt, `Album: ${album.title}`, album.source, album.ownerId, 'album', album.id);
  for (const item of data.media) add(`activity:media:${item.id}`, 'media', item.timestamp, `Media: ${item.filename ?? item.path.split('/').pop() ?? 'unnamed'}`, item.source, undefined, item.ownerType, item.ownerId);
  for (const fact of data.profileFacts) add(`activity:profile-fact:${fact.id}`, 'profile', fact.startDate ?? fact.endDate, `${fact.category}${fact.label ? ` · ${fact.label}` : ''}: ${fact.value}`, fact.source, data.profile?.personId, 'profile', data.profile?.id);
  return [...new Map(records.map(record => [record.id, record])).values()];
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
  const partIdFor = (source: { archivePartId?: string }) => source.archivePartId ?? parts[0]?.id ?? null;
  db.transaction(() => {
    ['activity_records', 'comments', 'reactions', 'album_media', 'albums', 'profile_facts', 'messages', 'conversations', 'posts', 'profiles', 'media', 'people', 'person_sources', 'source_records', 'import_metadata', 'archive_identity', 'archive_parts', 'archive_sets', 'import_part_checkpoints', 'import_section_status', 'diagnostic_warning_groups', 'import_sessions', 'rebuild_jobs'].forEach(table => db.exec(`DELETE FROM ${table}`));
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
    const activities = activityForData(data);
    batchInsert('activity_records', ['id', 'activity_type', 'actor_person_id', 'target_type', 'target_id', 'occurred_at', 'calendar_month', 'calendar_day', 'calendar_year', 'summary', 'source_path', 'source_index', 'archive_part_id'], activities.map(activity => { const calendar = calendarParts(activity.timestamp); return [activity.id, activity.type, activity.actorPersonId ?? null, activity.targetType ?? null, activity.targetId ?? null, activity.timestamp, calendar.month, calendar.day, calendar.year, activity.summary, activity.source.path, activity.source.index ?? null, partIdFor(activity.source)]; }));
    const metadata: [string, string][] = [['warning_count', String(data.warnings.length)], ['section_count', String(data.importedSections?.length ?? 0)], ['sections', JSON.stringify(data.importedSections ?? [])], ['diagnostics', JSON.stringify(data.diagnostics ?? null)]];
    for (const [key, value] of metadata) db.exec({ sql: 'INSERT INTO import_metadata(key,value) VALUES(?,?)', bind: [key, value] });
    if (data.archiveIdentity) db.exec({ sql: 'INSERT INTO archive_identity(id,filename,size,entry_count,fingerprint,known_entries) VALUES(1,?,?,?,?,?)', bind: [data.archiveIdentity.filename, data.archiveIdentity.size, data.archiveIdentity.entryCount, data.archiveIdentity.fingerprint, JSON.stringify(data.archiveIdentity.knownEntries)] });
  });
  rebuildSearch(data);
  fallbackData = data;
  const archive = archiveSet;
  if (archive) {
    const now = new Date().toISOString(); const counts = countData(data); counts.activities = activityForData(data).length;
    const session: ImportSession = { id: sessionIdForArchive(archive.id), archiveSetId: archive.id, startedAt: now, updatedAt: now, parserVersion: FACEBOOK_PARSER_VERSION, schemaVersion: SCHEMA_VERSION, expectedPartCount: parts.length, inspectedPartCount: parts.length, importedPartCount: parts.length, failedPartCount: 0, skippedPartCount: 0, currentStage: 'complete', status: archive.status === 'complete' ? 'complete' : 'interrupted', normalizedCounts: counts, warningsCount: data.warnings.length, detectedSections: data.coverage?.detectedSections ?? data.importedSections ?? [], importedSections: data.coverage?.importedSections ?? data.importedSections ?? [], coverage: data.coverage };
    db.transaction(() => { upsertSession(session); for (const part of parts) db.exec({ sql: 'INSERT OR REPLACE INTO import_part_checkpoints(session_id,archive_part_id,part_index,manifest_fingerprint,status,updated_at,completed_at,parser_version,record_counts,warnings_count,sections) VALUES(?,?,?,?,?,?,?,?,?,?,?)', bind: [session.id, part.id, part.partIndex, part.manifestFingerprint, part.status === 'failed' ? 'failed' : 'complete', now, part.status === 'failed' ? null : now, FACEBOOK_PARSER_VERSION, JSON.stringify(counts), 0, JSON.stringify(part.sections ?? [])] }); });
  }
  db.exec('PRAGMA optimize');
}

const ARCHIVE_DATA_TABLES = ['activity_records', 'comments', 'reactions', 'album_media', 'albums', 'profile_facts', 'messages', 'conversations', 'posts', 'profiles', 'media', 'people', 'person_sources', 'source_records', 'import_metadata', 'archive_identity', 'archive_parts', 'archive_sets', 'import_part_checkpoints', 'import_section_status', 'diagnostic_warning_groups', 'import_sessions'];
function clearArchiveData() {
  db.transaction(() => ARCHIVE_DATA_TABLES.forEach(table => db.exec(`DELETE FROM ${table}`)));
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
  if (!fallbackData) { fallbackData = normalizedData(data); return; }
  if (data.profile && !fallbackData.profile) fallbackData.profile = data.profile;
  fallbackData.people.push(...data.people); fallbackData.profileFacts.push(...data.profileFacts); fallbackData.posts.push(...data.posts); fallbackData.comments.push(...data.comments); fallbackData.reactions.push(...data.reactions); fallbackData.connections.push(...data.connections); fallbackData.albums.push(...data.albums); fallbackData.conversations.push(...data.conversations); fallbackData.messages.push(...data.messages); fallbackData.media.push(...data.media); fallbackData.warnings.push(...data.warnings);
  fallbackData.importedSections = [...new Set([...(fallbackData.importedSections ?? []), ...(data.importedSections ?? [])])];
  fallbackData.diagnostics = mergeDiagnostics(fallbackData.diagnostics, data.diagnostics);
  fallbackData.archiveSet = fallbackData.archiveSet ?? data.archiveSet; fallbackData.archiveIdentity = fallbackData.archiveIdentity ?? data.archiveIdentity;
  fallbackData.sourceFormat = fallbackData.sourceFormat ?? data.sourceFormat;
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
  const activities = finalize ? activityForData(data) : []; recordCounts.activities = activities.length;
  db.transaction(() => {
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
      batchInsert('activity_records', ['id', 'activity_type', 'actor_person_id', 'target_type', 'target_id', 'occurred_at', 'calendar_month', 'calendar_day', 'calendar_year', 'summary', 'source_path', 'source_index', 'archive_part_id'], activities.map(activity => { const calendar = calendarParts(activity.timestamp); return [activity.id, activity.type, activity.actorPersonId ?? null, activity.targetType ?? null, activity.targetId ?? null, activity.timestamp, calendar.month, calendar.day, calendar.year, activity.summary, activity.source.path, activity.source.index ?? null, part.id]; }), 'OR IGNORE');
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
  const state = finalize ? currentImportState(sessionId) : undefined; if (finalize && state?.session) {
    const counts = { ...emptyCounts() }; for (const [key, table] of Object.entries({ profiles: 'profiles', people: 'people', posts: 'posts', comments: 'comments', reactions: 'reactions', connections: 'connections', albums: 'albums', conversations: 'conversations', messages: 'messages', media: 'media', activities: 'activity_records' })) counts[key as keyof ImportCounts] = Number(rows(`SELECT COUNT(*) count FROM ${table}`)[0]?.count ?? 0);
    const checkpoints = state.checkpoints; const failed = checkpoints.filter(item => item.status === 'failed'); const skipped = checkpoints.filter(item => item.status === 'skipped');
    const previousMetrics = state.session.metrics ?? {}; const partDuration = data.performance?.totalDurationMs ?? data.diagnostics?.performance?.totalDurationMs; const sectionCounts = { ...(previousMetrics.sectionCounts ?? {}) }; for (const [section, value] of Object.entries(data.performance?.sectionCounts ?? {})) sectionCounts[section] = (sectionCounts[section] ?? 0) + value;
    upsertSession({ ...state.session, updatedAt: now, currentStage: 'parsing', status: 'importing', importedPartCount: checkpoints.filter(item => item.status === 'complete').length, failedPartCount: failed.length, skippedPartCount: skipped.length, normalizedCounts: counts, warningsCount: Number(rows("SELECT value FROM import_metadata WHERE key='warning_count'")[0]?.value ?? 0), failedPartIds: failed.map(item => item.archivePartId), skippedPartIds: skipped.map(item => item.archivePartId), metrics: { ...previousMetrics, totalDurationMs: (previousMetrics.totalDurationMs ?? 0) + (partDuration ?? 0), partDurationsMs: { ...(previousMetrics.partDurationsMs ?? {}), [part.id]: partDuration ?? 0 }, sectionCounts } });
  }
  if (collectFallback) {
    if (finalize) {
      const merged = mergeNormalizedData([...(fallbackData ? [fallbackData] : []), data]);
      const persistedSet = archiveSetFromRow(rows('SELECT id,platform,created_at createdAt,part_count partCount,total_size totalSize,fingerprint,imported_at importedAt,status,source_format sourceFormat FROM archive_sets ORDER BY created_at DESC LIMIT 1')[0]);
      const persistedParts = rows('SELECT id,archive_id archiveId,part_index partIndex,filename,file_size fileSize,entry_count entryCount,manifest_fingerprint manifestFingerprint,connected,status,warning_count warningCount,sections,source_format sourceFormat FROM archive_parts ORDER BY part_index,id').map(archivePartFromRow);
      const persistedIdentity = identityFromRow(rows('SELECT filename,size,entry_count entryCount,fingerprint,known_entries knownEntries FROM archive_identity WHERE id=1')[0]);
      fallbackData = { ...merged, archiveSet: persistedSet as ArchiveSet | undefined, archiveParts: persistedParts, archiveIdentity: persistedIdentity ?? merged.archiveIdentity ?? data.archiveIdentity };
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
  const session: ImportSession = sessionInput ?? { id: sessionIdForArchive(set.id), archiveSetId: set.id, startedAt: now, updatedAt: now, parserVersion: FACEBOOK_PARSER_VERSION, schemaVersion: SCHEMA_VERSION, expectedPartCount: parts.length || set.partCount, inspectedPartCount: 0, importedPartCount: 0, failedPartCount: 0, skippedPartCount: 0, currentStage: 'inspection', status: 'new', normalizedCounts: emptyCounts(), warningsCount: 0, detectedSections: [], importedSections: [] };
  const existingIdentity = identityFromRow(rows('SELECT filename,size,entry_count entryCount,fingerprint,known_entries knownEntries FROM archive_identity WHERE id=1')[0]);
  const identity: ArchiveIdentity | undefined = archiveIdentity ?? (existingIdentity?.fingerprint === set.fingerprint ? existingIdentity : parts.length ? {
    filename: parts.length === 1 ? parts[0].filename : `${parts.length} Facebook ZIP parts`,
    size: set.totalSize,
    entryCount: parts.reduce((sum, part) => sum + part.entryCount, 0),
    fingerprint: set.fingerprint,
    knownEntries: [...new Set(parts.flatMap(part => part.sections ?? []))].slice(0, 80),
  } : undefined);
  db.transaction(() => {
    upsertSession({ ...session, archiveSetId: set.id, expectedPartCount: parts.length || session.expectedPartCount, updatedAt: now, currentStage: session.status === 'complete' ? 'complete' : session.currentStage, status: session.status });
    for (const part of parts) db.exec({ sql: 'INSERT OR IGNORE INTO import_part_checkpoints(session_id,archive_part_id,part_index,manifest_fingerprint,status,updated_at,parser_version,record_counts,warnings_count,sections) VALUES(?,?,?,?,?,?,?,?,?,?)', bind: [session.id, part.id, part.partIndex, part.manifestFingerprint, 'pending', now, FACEBOOK_PARSER_VERSION, JSON.stringify({}), 0, JSON.stringify(part.sections ?? [])] });
    db.exec({ sql: 'INSERT OR IGNORE INTO archive_sets(id,platform,created_at,part_count,total_size,fingerprint,imported_at,status,source_format) VALUES(?,?,?,?,?,?,?,?,?)', bind: [set.id, set.platform, set.createdAt, set.partCount, set.totalSize, set.fingerprint, null, 'incomplete', set.sourceFormat ?? null] });
    if (identity) db.exec({ sql: 'INSERT OR REPLACE INTO archive_identity(id,filename,size,entry_count,fingerprint,known_entries) VALUES(1,?,?,?,?,?)', bind: [identity.filename, identity.size, identity.entryCount, identity.fingerprint, JSON.stringify(identity.knownEntries)] });
    for (const part of parts) db.exec({ sql: 'INSERT OR REPLACE INTO archive_parts(id,archive_id,part_index,filename,file_size,entry_count,manifest_fingerprint,connected,status,warning_count,sections,source_format) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)', bind: [part.id, set.id, part.partIndex, part.filename, part.fileSize, part.entryCount, part.manifestFingerprint, part.connected ? 1 : 0, part.status ?? 'pending', part.warningCount ?? 0, JSON.stringify(part.sections ?? []), part.sourceFormat ?? set.sourceFormat ?? null] });
  });
  // Keep archive identity and part metadata in the IndexedDB snapshot even if
  // cancellation happens before the first normalized batch is acknowledged.
  // Without this seed, a reload could restore records but lose the resumable
  // archive-set shell that tells the UI which ZIP parts are still needed.
  if (mode === 'indexeddb') {
    const base = fallbackData ?? normalizedData({});
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
  db.transaction(() => {
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
  db.transaction(() => { db.exec('DELETE FROM activity_records'); statements.forEach(statement => db.exec(statement)); });
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
async function persistFallback() {
  if (mode !== 'indexeddb') return;
  try { await putFallback(fallbackData); await putFallbackImportState(currentImportState()); } catch { /* the in-memory query layer remains usable if browser storage is unavailable */ }
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
function rebuildActivityFromDatabase() {
  if (Number(rows('SELECT COUNT(*) count FROM activity_records')[0]?.count ?? 0) > 0) return;
  const source = { platform: 'facebook', path: 'database' };
  const data = normalizedData({ people: [], profileFacts: [], posts: rows('SELECT id,author_id authorId,body text,created_at createdAt,source_path sourcePath FROM posts').map(row => ({ id: String(row.id), authorId: row.authorId ? String(row.authorId) : undefined, text: row.text ? String(row.text) : undefined, createdAt: row.createdAt ? String(row.createdAt) : undefined, source: { ...source, path: String(row.sourcePath) } } as Post)), comments: rows('SELECT id,post_id postId,author_id authorId,author_name authorName,body text,created_at createdAt,source_path sourcePath FROM comments').map(row => ({ id: String(row.id), postId: String(row.postId), authorId: row.authorId ? String(row.authorId) : undefined, authorName: row.authorName ? String(row.authorName) : undefined, text: String(row.text), createdAt: row.createdAt ? String(row.createdAt) : undefined, source: { ...source, path: String(row.sourcePath) } } as Comment)), reactions: rows('SELECT id,target_type targetType,target_id targetId,person_id personId,person_name personName,kind,created_at createdAt,source_path sourcePath FROM reactions').map(row => ({ id: String(row.id), targetType: String(row.targetType) as Reaction['targetType'], targetId: String(row.targetId), personId: row.personId ? String(row.personId) : undefined, personName: row.personName ? String(row.personName) : undefined, kind: String(row.kind), createdAt: row.createdAt ? String(row.createdAt) : undefined, source: { ...source, path: String(row.sourcePath) } } as Reaction)), connections: rows('SELECT id,person_id personId,display_name displayName,relationship_type type,started_at startedAt,ended_at endedAt,source_path sourcePath FROM connections').map(row => ({ id: String(row.id), personId: String(row.personId), displayName: String(row.displayName), type: String(row.type) as Connection['type'], startedAt: row.startedAt ? String(row.startedAt) : undefined, endedAt: row.endedAt ? String(row.endedAt) : undefined, source: { ...source, path: String(row.sourcePath) } } as Connection)), albums: rows('SELECT id,title,created_at createdAt,updated_at updatedAt,source_path sourcePath FROM albums').map(row => ({ id: String(row.id), title: String(row.title), createdAt: row.createdAt ? String(row.createdAt) : undefined, updatedAt: row.updatedAt ? String(row.updatedAt) : undefined, mediaIds: [], source: { ...source, path: String(row.sourcePath) } } as Album)), media: rows('SELECT id,filename,path,timestamp,owner_type ownerType,owner_id ownerId,source_path sourcePath FROM media').map(row => ({ id: String(row.id), filename: row.filename ? String(row.filename) : undefined, path: String(row.path), timestamp: row.timestamp ? String(row.timestamp) : undefined, ownerType: String(row.ownerType) as Media['ownerType'], ownerId: String(row.ownerId), mediaType: 'unknown', source: { ...source, path: String(row.sourcePath) } } as Media)), warnings: [] });
  data.conversations = rows('SELECT id,title,participant_names participantNamesJson,participant_ids participantIdsJson,source_path sourcePath FROM conversations').map(row => ({ id: String(row.id), title: row.title ? String(row.title) : undefined, participantIds: json<string[]>(row.participantIdsJson, []), participantNames: json<string[]>(row.participantNamesJson, []), source: { platform: 'facebook', path: String(row.sourcePath) } } as Conversation));
  data.messages = rows('SELECT id,conversation_id conversationId,sender_id senderId,sender_name senderName,body text,sent_at sentAt,source_path sourcePath,source_index sourceIndex FROM messages').map(row => ({ id: String(row.id), conversationId: String(row.conversationId), senderId: row.senderId ? String(row.senderId) : undefined, senderName: row.senderName ? String(row.senderName) : undefined, text: row.text ? String(row.text) : undefined, sentAt: row.sentAt ? String(row.sentAt) : undefined, source: { platform: 'facebook', path: String(row.sourcePath), index: row.sourceIndex === null || row.sourceIndex === undefined ? undefined : Number(row.sourceIndex) } } as Message));
  const profileRow = rows('SELECT pr.id,pr.person_id personId,pr.display_name displayName,pr.username,pr.bio,pr.joined_at joinedAt,pr.source_path sourcePath FROM profiles pr LIMIT 1')[0];
  data.profile = mapProfile(profileRow);
  data.profileFacts = rows('SELECT id,category,label,value,start_date startDate,end_date endDate,source_path sourcePath,source_index sourceIndex FROM profile_facts').map(row => ({ id: String(row.id), category: String(row.category), label: row.label ? String(row.label) : undefined, value: String(row.value), startDate: row.startDate ? String(row.startDate) : undefined, endDate: row.endDate ? String(row.endDate) : undefined, source: { platform: 'facebook', path: String(row.sourcePath), index: row.sourceIndex === null || row.sourceIndex === undefined ? undefined : Number(row.sourceIndex) } } as ProfileFact));
  const records = activityForData(data);
  db.transaction(() => records.forEach(activity => { const parts = calendarParts(activity.timestamp); db.exec({ sql: 'INSERT OR IGNORE INTO activity_records(id,activity_type,actor_person_id,target_type,target_id,occurred_at,calendar_month,calendar_day,calendar_year,summary,source_path,source_index) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)', bind: [activity.id, activity.type, activity.actorPersonId ?? null, activity.targetType ?? null, activity.targetId ?? null, activity.timestamp, parts.month, parts.day, parts.year, activity.summary, activity.source.path, activity.source.index ?? null] }); }));
}

function conversationPage(request: DatabaseRequest): Page<ConversationPreview> {
  const limit = limitOf(request.limit), cursor = decode(request.cursor), filter = request.query?.trim(), conditions: string[] = [], bind: unknown[] = [];
  if (filter) { conditions.push('(c.title LIKE ? OR c.participant_names LIKE ?)'); bind.push(`%${filter}%`, `%${filter}%`); }
  if (cursor) { conditions.push("(COALESCE((SELECT MAX(sent_at) FROM messages lm WHERE lm.conversation_id=c.id),'') < ? OR (COALESCE((SELECT MAX(sent_at) FROM messages lm WHERE lm.conversation_id=c.id),'') = ? AND c.id < ?))"); bind.push(cursor.key, cursor.key, cursor.id); }
  const query = `SELECT c.id,c.title,c.participant_names participantNamesJson,c.participant_ids participantIdsJson,c.source_path sourcePath,c.archive_part_id archivePartId,(SELECT COUNT(*) FROM messages m WHERE m.conversation_id=c.id) messageCount,(SELECT body FROM messages lm WHERE lm.conversation_id=c.id ORDER BY COALESCE(lm.sent_at,'') DESC,lm.id DESC LIMIT 1) latestText,(SELECT sent_at FROM messages lm WHERE lm.conversation_id=c.id ORDER BY COALESCE(lm.sent_at,'') DESC,lm.id DESC LIMIT 1) latestSentAt,c.is_group isGroup FROM conversations c ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''} ORDER BY COALESCE((SELECT MAX(sent_at) FROM messages lm WHERE lm.conversation_id=c.id),'') DESC,c.id DESC LIMIT ?`;
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
  const profileRow = rows("SELECT id,person_id personId,display_name displayName,username,bio,joined_at joinedAt,source_path sourcePath,(SELECT json_group_array(json_object('id',f.id,'category',f.category,'label',f.label,'value',f.value,'startDate',f.start_date,'endDate',f.end_date,'source',json_object('platform','facebook','path',f.source_path,'index',f.source_index))) FROM profile_facts f WHERE f.profile_id=profiles.id) factsJson FROM profiles LIMIT 1")[0];
  const people = rows('SELECT id,display_name displayName,facebook_id facebookId,username,profile_url profileUrl,profile_photo_path profilePhotoPath,cover_photo_path coverPhotoPath,first_seen firstSeen,last_seen lastSeen,relationship,identity_confidence identityConfidence,identity_source identitySource,source_paths sourcePaths,is_archive_owner isArchiveOwner FROM people').map(row => ({ ...mapPerson({ ...row, participationCount: 0, messageCount: 0, postCount: 0, mediaCount: 0 }), id: String(row.id) }));
  const posts = rows('SELECT id,author_id authorId,title,body text,created_at createdAt,links linksJson,source_path sourcePath,source_index sourceIndex,0 mediaCount FROM posts').map(mapPost);
  const conversations = rows('SELECT id,title,participant_names participantNamesJson,participant_ids participantIdsJson,source_path sourcePath FROM conversations').map(row => ({ id: String(row.id), title: row.title ? String(row.title) : undefined, participantIds: json<string[]>(row.participantIdsJson, []), participantNames: json<string[]>(row.participantNamesJson, []), source: { platform: 'facebook', path: String(row.sourcePath) } } as Conversation));
  const messages = rows('SELECT id,conversation_id conversationId,sender_id senderId,sender_name senderName,body text,sent_at sentAt,source_path sourcePath,source_index sourceIndex,0 mediaCount FROM messages').map(mapMessage);
  rebuildSearch({ profile: mapProfile(profileRow), people, profileFacts: json<ProfileFact[]>(profileRow?.factsJson, []), posts, comments: [], reactions: [], connections: [], albums: [], conversations, messages, media: [], warnings: [] });
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
  return { profiles: count('profiles'), people: count('people'), posts: count('posts'), comments: count('comments'), reactions: count('reactions'), connections: count('connections'), albums: count('albums'), activities: count('activity_records'), conversations: count('conversations'), messages: count('messages'), media: count('media'), earliest: range?.earliest ? String(range.earliest) : undefined, latest: range?.latest ? String(range.latest) : undefined, warnings: Number(rows("SELECT value FROM import_metadata WHERE key='warning_count'")[0]?.value ?? 0), sections: Number(rows("SELECT value FROM import_metadata WHERE key='section_count'")[0]?.value ?? 0), years, diagnostics, archiveIdentity: identity, archiveSet: source.archiveSet, archiveParts: source.parts, importSession: state.session, coverage: state.coverage };
}

async function init() {
  const sqlite3 = await sqlite3InitModule();
  if (sqlite3.oo1.OpfsDb) {
    try { const OpfsDb = sqlite3.oo1.OpfsDb as unknown as new (filename: string, flags: string) => DB; db = new OpfsDb('/socialvault.sqlite3', 'c'); mode = 'opfs'; }
    catch { db = new sqlite3.oo1.DB(':memory:', 'c') as unknown as DB; mode = 'indexeddb'; }
  } else db = new sqlite3.oo1.DB(':memory:', 'c') as unknown as DB;
  applyMigrations(); backfillArchiveSet(); backfillPeopleFromLegacyTables(); rebuildActivityFromDatabase(); setupSearch();
  if (mode === 'indexeddb') { try { const saved = await getFallback(); if (saved) { fallbackData = saved; replace(saved); const savedState = await getFallbackImportState(); if (savedState) restoreImportState(savedState); } } catch { /* in-memory SQLite remains usable when IndexedDB is unavailable or corrupt */ } }
  else if (Number(rows('SELECT COUNT(*) count FROM search_documents')[0]?.count ?? 0) === 0 && Number(rows('SELECT COUNT(*) count FROM posts')[0]?.count ?? 0) > 0) rebuildSearchFromDatabase();
  ensureLegacyImportSession();
  return { mode, searchBackend };
}

self.onmessage = async (event: MessageEvent<DatabaseRequest>) => {
  const request = event.data;
  try {
    if (request.type === 'init') { send({ id: request.id, ok: true, data: await init() }); return; }
    if (request.type === 'replace' && request.data) { replace(request.data); await persistFallback(); send({ id: request.id, ok: true }); return; }
    if (request.type === 'import-state') { send({ id: request.id, ok: true, data: currentImportState(request.sessionId) }); return; }
    if (request.type === 'begin-import') { const state = beginImportSession(request.session, request.data?.archiveParts ?? [], request.data?.archiveSet, request.data?.archiveIdentity); await persistFallback(); send({ id: request.id, ok: true, data: state }); return; }
    if (request.type === 'import-batch' && request.data && request.part && request.sessionId) { const checkpoint = importBatchData(request.data, request.part, request.sessionId); batchesSinceFallback++; if (batchesSinceFallback >= 256) { batchesSinceFallback = 0; await persistFallback(); } send({ id: request.id, ok: true, data: checkpoint }); return; }
    if (request.type === 'import-part' && request.data && request.part && request.sessionId) { const checkpoint = importPartData(request.data, request.part, request.sessionId); batchesSinceFallback = 0; await persistFallback(); send({ id: request.id, ok: true, data: checkpoint }); return; }
    if (request.type === 'update-media-sources' && request.data) { db.transaction(() => request.data!.media.forEach(item => db.exec({ sql: 'UPDATE media SET archive_part_id=? WHERE id=?', bind: [item.source.archivePartId ?? null, item.id] }))); await persistFallback(); send({ id: request.id, ok: true }); return; }
    if (request.type === 'update-import' && request.sessionId) { const patch = request.session ?? ({ status: request.status, lastError: request.errorMessage } as Partial<ImportSession>); const session = updateImportSession(request.sessionId, patch as Partial<ImportSession>); await persistFallback(); send({ id: request.id, ok: true, data: session }); return; }
    if (request.type === 'cancel-import' && request.sessionId) { const session = updateImportSession(request.sessionId, { status: 'cancelled', currentStage: 'cancelled' }); await persistFallback(); send({ id: request.id, ok: true, data: session }); return; }
    if (request.type === 'interrupt-import' && request.sessionId) { const session = updateImportSession(request.sessionId, { status: 'interrupted', currentStage: 'interrupted', lastError: request.errorMessage }); await persistFallback(); send({ id: request.id, ok: true, data: session }); return; }
    if (request.type === 'skip-import-part' && request.sessionId && request.part) { const checkpoint = checkpointPart(request.sessionId, request.part, 'skipped', request.errorMessage); await persistFallback(); send({ id: request.id, ok: true, data: checkpoint }); return; }
    if (request.type === 'fail-import-part' && request.sessionId && request.part) { const checkpoint = checkpointPart(request.sessionId, request.part, 'failed', request.errorMessage); await persistFallback(); send({ id: request.id, ok: true, data: checkpoint }); return; }
    if (request.type === 'retry-import-part' && request.sessionId && request.part) {
      const now = new Date().toISOString();
      db.exec({ sql: 'INSERT OR REPLACE INTO import_part_checkpoints(session_id,archive_part_id,part_index,manifest_fingerprint,status,updated_at,parser_version,record_counts,warnings_count,error,sections) VALUES(?,?,?,?,?,?,?,?,?,?,?)', bind: [request.sessionId, request.part.id, request.part.partIndex, request.part.manifestFingerprint, 'pending', now, FACEBOOK_PARSER_VERSION, JSON.stringify({}), 0, null, JSON.stringify(request.part.sections ?? [])] });
      db.exec({ sql: 'UPDATE archive_parts SET status=?,connected=? WHERE id=?', bind: ['pending', request.part.connected ? 1 : 0, request.part.id] });
      const state = currentImportState(request.sessionId);
      if (state.session) updateImportSession(request.sessionId, { status: 'importing', currentStage: 'parsing', failedPartIds: (state.session.failedPartIds ?? []).filter(id => id !== request.part!.id), skippedPartIds: (state.session.skippedPartIds ?? []).filter(id => id !== request.part!.id), failedPartCount: state.checkpoints.filter(item => item.status === 'failed').length, skippedPartCount: state.checkpoints.filter(item => item.status === 'skipped').length });
      await persistFallback(); send({ id: request.id, ok: true, data: currentImportState(request.sessionId) }); return;
    }
    if (request.type === 'restart-import') { clearArchiveData(); if (mode === 'indexeddb') { await putFallback(); await clearFallbackImportState(); } send({ id: request.id, ok: true }); return; }
    if (request.type === 'rebuild-search') { const result = runRebuildJob('search', rebuildSearchFromTables); await persistFallback(); send({ id: request.id, ok: true, data: result }); return; }
    if (request.type === 'rebuild-activity') { const result = runRebuildJob('activity', rebuildActivityIndex); await persistFallback(); send({ id: request.id, ok: true, data: result }); return; }
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
    if (request.type === 'media-cache' && request.mediaPath) { db.exec({ sql: 'INSERT OR REPLACE INTO media_cache(path,last_accessed,byte_size) VALUES(?,?,?)', bind: [request.mediaPath, new Date().toISOString(), request.byteSize ?? null] }); send({ id: request.id, ok: true }); return; }
  } catch (error) { send({ id: request.id, ok: false, error: error instanceof Error ? error.message : String(error) }); }
};
