/// <reference lib="webworker" />
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { getFallback, putFallback } from './indexeddb-fallback';
import { FTS5_SCHEMA, MIGRATIONS } from './schema';
import type { AlbumSummary, ArchiveStats, ConnectionSummary, ConversationPreview, DatabaseRequest, DatabaseResponse, Page, PersonSummary, SearchBackend, SearchResponse, SearchResult, StorageMode } from './types';
import type { Album, ArchiveIdentity, Comment, Connection, Conversation, Media, Message, NormalizedArchiveData, Person, Post, Profile, ProfileFact, Reaction } from '../archive/schemas/models';

type DB = { exec: (options: string | Record<string, unknown>) => unknown; transaction: (fn: () => void) => void };
let db: DB;
let mode: StorageMode = 'indexeddb';
let searchBackend: SearchBackend = 'like';

const send = (message: DatabaseResponse) => postMessage(message);
const rows = (sql: string, bind: unknown[] = []): Record<string, unknown>[] => db.exec({ sql, bind, returnValue: 'resultRows', rowMode: 'object' } as Record<string, unknown>) as Record<string, unknown>[];
const limitOf = (value?: number) => Math.min(100, Math.max(1, value ?? 20));
const encode = (value: unknown) => encodeURIComponent(JSON.stringify(value));
const decode = (value?: string) => {
  if (!value) return undefined;
  try { return JSON.parse(decodeURIComponent(value)) as Record<string, unknown>; } catch { return undefined; }
};
const json = <T>(value: unknown, fallback: T): T => { try { return JSON.parse(String(value ?? '')) as T; } catch { return fallback; } };

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

function setupSearch() {
  try { db.exec(FTS5_SCHEMA); searchBackend = 'fts5'; } catch { searchBackend = 'like'; }
}

function normalizedData(data: NormalizedArchiveData): NormalizedArchiveData {
  return { ...data, people: data.people ?? [], profileFacts: data.profileFacts ?? data.profile?.facts ?? [], posts: data.posts ?? [], comments: data.comments ?? [], reactions: data.reactions ?? [], connections: data.connections ?? [], albums: data.albums ?? [], conversations: data.conversations ?? [], messages: data.messages ?? [], media: data.media ?? [], warnings: data.warnings ?? [] };
}

function mapMedia(row: Record<string, unknown>): Media {
  return {
    id: String(row.id), path: String(row.path), mediaType: String(row.mediaType) as Media['mediaType'],
    filename: row.filename ? String(row.filename) : undefined, mimeType: row.mimeType ? String(row.mimeType) : undefined,
    caption: row.caption ? String(row.caption) : undefined, timestamp: row.timestamp ? String(row.timestamp) : undefined,
    ownerType: String(row.ownerType) as Media['ownerType'], ownerId: String(row.ownerId),
    width: row.width === null || row.width === undefined ? undefined : Number(row.width), height: row.height === null || row.height === undefined ? undefined : Number(row.height),
    durationMs: row.durationMs === null || row.durationMs === undefined ? undefined : Number(row.durationMs),
    source: { platform: 'facebook', path: String(row.sourcePath), index: row.sourceIndex === null || row.sourceIndex === undefined ? undefined : Number(row.sourceIndex) },
  };
}

function mediaForJson(value: unknown): Media[] { return json<Record<string, unknown>[]>(value, []).map(item => item.source ? item as unknown as Media : mapMedia(item)); }

function mapProfile(row?: Record<string, unknown>): Profile | undefined {
  return row ? {
    id: String(row.id), personId: String(row.personId), displayName: String(row.displayName),
    facebookId: row.facebookId ? String(row.facebookId) : undefined, username: row.username ? String(row.username) : undefined,
    profileUrl: row.profileUrl ? String(row.profileUrl) : undefined, bio: row.bio ? String(row.bio) : undefined,
    joinedAt: row.joinedAt ? String(row.joinedAt) : undefined, relationship: row.relationship ? String(row.relationship) : undefined, profilePhotoPath: row.profilePhotoPath ? String(row.profilePhotoPath) : undefined,
    coverPhotoPath: row.coverPhotoPath ? String(row.coverPhotoPath) : undefined, facts: json<ProfileFact[]>(row.factsJson, []), source: { platform: 'facebook', path: String(row.sourcePath) },
  } : undefined;
}

function mapPost(row: Record<string, unknown>): Post {
  return {
    id: String(row.id), authorId: row.authorId ? String(row.authorId) : undefined, title: row.title ? String(row.title) : undefined,
    text: row.text ? String(row.text) : undefined, createdAt: row.createdAt ? String(row.createdAt) : undefined,
    mediaCount: Number(row.mediaCount ?? 0), commentCount: Number(row.commentCount ?? 0), reactionCount: Number(row.reactionCount ?? 0), media: mediaForJson(row.mediaJson), comments: json<Comment[]>(row.commentsJson, []), reactions: json<Reaction[]>(row.reactionsJson, []),
    source: { platform: 'facebook', path: String(row.sourcePath), index: row.sourceIndex === null || row.sourceIndex === undefined ? undefined : Number(row.sourceIndex) },
  };
}

function mapMessage(row: Record<string, unknown>): Message {
  return {
    id: String(row.id), conversationId: String(row.conversationId), senderId: row.senderId ? String(row.senderId) : undefined,
    senderName: row.senderName ? String(row.senderName) : undefined, text: row.text ? String(row.text) : undefined,
    sentAt: row.sentAt ? String(row.sentAt) : undefined, mediaCount: Number(row.mediaCount ?? 0), media: mediaForJson(row.mediaJson),
    source: { platform: 'facebook', path: String(row.sourcePath), index: row.sourceIndex === null || row.sourceIndex === undefined ? undefined : Number(row.sourceIndex) },
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
    sourcePaths: json<string[]>(row.sourcePaths, []), isArchiveOwner: Number(row.isArchiveOwner ?? 0) === 1,
    participationCount: Number(row.participationCount ?? 0), messageCount: Number(row.messageCount ?? 0), postCount: Number(row.postCount ?? 0), mediaCount: Number(row.mediaCount ?? 0), commentCount: Number(row.commentCount ?? 0), reactionCount: Number(row.reactionCount ?? 0), connectionCount: Number(row.connectionCount ?? 0), albumCount: Number(row.albumCount ?? 0), sharedPostCount: Number(row.sharedPostCount ?? 0), sharedMediaCount: Number(row.sharedMediaCount ?? 0),
    firstInteraction: row.firstInteraction ? String(row.firstInteraction) : undefined, lastInteraction: row.lastInteraction ? String(row.lastInteraction) : undefined,
  };
}

function mediaJson(ownerType: 'post' | 'message' | 'album', ownerId: string) {
  const records = rows('SELECT id,path,media_type mediaType,filename,mime_type mimeType,caption,timestamp,owner_type ownerType,owner_id ownerId,width,height,duration_ms durationMs,source_path sourcePath,source_index sourceIndex FROM media WHERE owner_type=? AND owner_id=? ORDER BY id', [ownerType, ownerId]);
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
  for (const post of data.posts) documents.push({ type: 'post', id: post.id, title: post.title, body: post.text, context: post.createdAt, createdAt: post.createdAt, source: post.source.path });
  for (const comment of data.comments ?? []) documents.push({ type: 'comment', id: comment.id, title: comment.authorName, body: comment.text, context: comment.createdAt, createdAt: comment.createdAt, source: comment.source.path });
  for (const reaction of data.reactions ?? []) documents.push({ type: 'reaction', id: reaction.id, title: reaction.kind, body: reaction.personName, context: reaction.targetId, createdAt: reaction.createdAt, source: reaction.source.path });
  for (const connection of data.connections ?? []) documents.push({ type: 'connection', id: connection.id, title: connection.displayName, body: [connection.type, connection.username].filter(Boolean).join(' '), context: connection.startedAt ?? connection.endedAt, createdAt: connection.startedAt ?? connection.endedAt, source: connection.source.path });
  for (const album of data.albums ?? []) documents.push({ type: 'album', id: album.id, title: album.title, body: album.description, context: album.createdAt, createdAt: album.updatedAt ?? album.createdAt, source: album.source.path });
  const titles = new Map(data.conversations.map(conversation => [conversation.id, conversation.title ?? 'Conversation']));
  for (const conversation of data.conversations) documents.push({ type: 'conversation', id: conversation.id, title: conversation.title, body: conversation.participantNames.join(' '), context: conversation.participantNames.join(', '), source: conversation.source.path });
  for (const message of data.messages) documents.push({ type: 'message', id: message.id, title: titles.get(message.conversationId), body: message.text, context: [message.senderName, message.sentAt].filter(Boolean).join(' '), createdAt: message.sentAt, conversationId: message.conversationId, source: message.source.path });
  for (const document of documents) {
    db.exec({ sql: 'INSERT INTO search_documents(entity_type,entity_id,title,body,context,created_at,conversation_id,source_path) VALUES(?,?,?,?,?,?,?,?)', bind: [document.type, document.id, document.title ?? null, document.body ?? null, document.context ?? null, document.createdAt ?? null, document.conversationId ?? null, document.source ?? null] });
    if (searchBackend === 'fts5') db.exec({ sql: 'INSERT INTO archive_fts(entity_type,entity_id,title,body,context,created_at,conversation_id,source_path) VALUES(?,?,?,?,?,?,?,?)', bind: [document.type, document.id, document.title ?? '', document.body ?? '', document.context ?? '', document.createdAt ?? '', document.conversationId ?? '', document.source ?? ''] });
  }
}

function replace(input: NormalizedArchiveData) {
  const data = normalizedData(input);
  db.transaction(() => {
    ['comments', 'reactions', 'album_media', 'albums', 'profile_facts', 'messages', 'conversations', 'posts', 'profiles', 'media', 'people', 'person_sources', 'import_metadata', 'archive_identity'].forEach(table => db.exec(`DELETE FROM ${table}`));
    if (data.profile) db.exec({ sql: 'INSERT INTO profiles(id,person_id,display_name,username,bio,joined_at,source_path) VALUES(?,?,?,?,?,?,?)', bind: [data.profile.id, data.profile.personId, data.profile.displayName, data.profile.username ?? null, data.profile.bio ?? null, data.profile.joinedAt ?? null, data.profile.source.path] });
    for (const person of data.people) {
      db.exec({ sql: 'INSERT OR REPLACE INTO people(id,facebook_id,display_name,username,profile_url,profile_photo_path,cover_photo_path,first_seen,last_seen,relationship,identity_confidence,identity_source,source_paths,is_archive_owner) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)', bind: [person.id, person.facebookId ?? null, person.displayName, person.username ?? null, person.profileUrl ?? null, person.profilePhotoPath ?? null, person.coverPhotoPath ?? null, person.firstSeen ?? null, person.lastSeen ?? null, person.relationship ?? null, person.identityConfidence ?? null, person.identitySource ?? null, JSON.stringify(person.sourcePaths ?? []), person.isArchiveOwner ? 1 : 0] });
      for (const path of person.sourcePaths ?? []) db.exec({ sql: 'INSERT OR IGNORE INTO person_sources(person_id,source_path,source_index) VALUES(?,?,?)', bind: [person.id, path, null] });
    }
    for (const post of data.posts) db.exec({ sql: 'INSERT INTO posts(id,author_id,title,body,created_at,source_path,source_index) VALUES(?,?,?,?,?,?,?)', bind: [post.id, post.authorId ?? null, post.title ?? null, post.text ?? null, post.createdAt ?? null, post.source.path, post.source.index ?? null] });
    for (const comment of data.comments) db.exec({ sql: 'INSERT INTO comments(id,post_id,author_id,author_name,body,created_at,source_path,source_index) VALUES(?,?,?,?,?,?,?,?)', bind: [comment.id, comment.postId, comment.authorId ?? null, comment.authorName ?? null, comment.text, comment.createdAt ?? null, comment.source.path, comment.source.index ?? null] });
    for (const reaction of data.reactions) db.exec({ sql: 'INSERT INTO reactions(id,target_type,target_id,person_id,person_name,kind,created_at,source_path,source_index) VALUES(?,?,?,?,?,?,?,?,?)', bind: [reaction.id, reaction.targetType, reaction.targetId, reaction.personId ?? null, reaction.personName ?? null, reaction.kind, reaction.createdAt ?? null, reaction.source.path, reaction.source.index ?? null] });
    for (const connection of data.connections) db.exec({ sql: 'INSERT INTO connections(id,person_id,display_name,facebook_id,username,profile_url,relationship_type,started_at,ended_at,source_path,source_index) VALUES(?,?,?,?,?,?,?,?,?,?,?)', bind: [connection.id, connection.personId, connection.displayName, connection.facebookId ?? null, connection.username ?? null, connection.profileUrl ?? null, connection.type, connection.startedAt ?? null, connection.endedAt ?? null, connection.source.path, connection.source.index ?? null] });
    for (const album of data.albums) {
      db.exec({ sql: 'INSERT INTO albums(id,title,description,owner_id,created_at,updated_at,source_path,source_index) VALUES(?,?,?,?,?,?,?,?)', bind: [album.id, album.title, album.description ?? null, album.ownerId ?? null, album.createdAt ?? null, album.updatedAt ?? null, album.source.path, album.source.index ?? null] });
      album.mediaIds.forEach((mediaId, position) => db.exec({ sql: 'INSERT OR IGNORE INTO album_media(album_id,media_id,position) VALUES(?,?,?)', bind: [album.id, mediaId, position] }));
    }
    for (const fact of data.profileFacts) db.exec({ sql: 'INSERT INTO profile_facts(id,profile_id,category,label,value,start_date,end_date,source_path,source_index) VALUES(?,?,?,?,?,?,?,?,?)', bind: [fact.id, data.profile?.id ?? 'owner', fact.category, fact.label ?? null, fact.value, fact.startDate ?? null, fact.endDate ?? null, fact.source.path, fact.source.index ?? null] });
    for (const conversation of data.conversations) db.exec({ sql: 'INSERT INTO conversations(id,title,participant_names,source_path,is_group,participant_ids) VALUES(?,?,?,?,?,?)', bind: [conversation.id, conversation.title ?? null, JSON.stringify(conversation.participantNames), conversation.source.path, conversation.participantNames.length > 2 ? 1 : 0, JSON.stringify(conversation.participantIds)] });
    for (const message of data.messages) db.exec({ sql: 'INSERT INTO messages(id,conversation_id,sender_name,body,sent_at,source_path,source_index,sender_id) VALUES(?,?,?,?,?,?,?,?)', bind: [message.id, message.conversationId, message.senderName ?? null, message.text ?? null, message.sentAt ?? null, message.source.path, message.source.index ?? null, message.senderId ?? null] });
    for (const item of data.media) db.exec({ sql: 'INSERT INTO media(id,path,media_type,filename,mime_type,caption,timestamp,owner_type,owner_id,width,height,duration_ms,source_path,source_index) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)', bind: [item.id, item.path, item.mediaType, item.filename ?? null, item.mimeType ?? null, item.caption ?? null, item.timestamp ?? null, item.ownerType, item.ownerId, item.width ?? null, item.height ?? null, item.durationMs ?? null, item.source.path, item.source.index ?? null] });
    const metadata: [string, string][] = [['warning_count', String(data.warnings.length)], ['section_count', String(data.importedSections?.length ?? 0)], ['sections', JSON.stringify(data.importedSections ?? [])], ['diagnostics', JSON.stringify(data.diagnostics ?? null)]];
    for (const [key, value] of metadata) db.exec({ sql: 'INSERT INTO import_metadata(key,value) VALUES(?,?)', bind: [key, value] });
    if (data.archiveIdentity) db.exec({ sql: 'INSERT INTO archive_identity(id,filename,size,entry_count,fingerprint,known_entries) VALUES(1,?,?,?,?,?)', bind: [data.archiveIdentity.filename, data.archiveIdentity.size, data.archiveIdentity.entryCount, data.archiveIdentity.fingerprint, JSON.stringify(data.archiveIdentity.knownEntries)] });
  });
  rebuildSearch(data);
  db.exec('PRAGMA optimize');
}

function postPage(request: DatabaseRequest): Page<Post> {
  const limit = limitOf(request.limit), sort = request.sort === 'oldest' ? 'oldest' : 'newest', cursor = decode(request.cursor), conditions: string[] = [], bind: unknown[] = [];
  if (request.year) { conditions.push("substr(created_at,1,4)=?"); bind.push(String(request.year)); }
  if (request.personId) { conditions.push('author_id=?'); bind.push(request.personId); }
  if (cursor) { if (sort === 'newest') { conditions.push("(COALESCE(created_at,'') < ? OR (COALESCE(created_at,'') = ? AND id < ?))"); bind.push(cursor.key, cursor.key, cursor.id); } else { conditions.push("(COALESCE(created_at,'') > ? OR (COALESCE(created_at,'') = ? AND id > ?))"); bind.push(cursor.key, cursor.key, cursor.id); } }
  const query = `SELECT p.id,p.author_id authorId,p.title,p.body text,p.created_at createdAt,p.source_path sourcePath,p.source_index sourceIndex,(SELECT COUNT(*) FROM media m WHERE m.owner_type='post' AND m.owner_id=p.id) mediaCount,(SELECT COUNT(*) FROM comments c WHERE c.post_id=p.id) commentCount,(SELECT COUNT(*) FROM reactions r WHERE r.target_type='post' AND r.target_id=p.id) reactionCount,(SELECT json_group_array(json_object('id',m.id,'path',m.path,'mediaType',m.media_type,'filename',m.filename,'mimeType',m.mime_type,'caption',m.caption,'timestamp',m.timestamp,'ownerType',m.owner_type,'ownerId',m.owner_id,'width',m.width,'height',m.height,'durationMs',m.duration_ms,'sourcePath',m.source_path,'sourceIndex',m.source_index)) FROM media m WHERE m.owner_type='post' AND m.owner_id=p.id) mediaJson,(SELECT json_group_array(json_object('id',c.id,'postId',c.post_id,'authorId',c.author_id,'authorName',c.author_name,'text',c.body,'createdAt',c.created_at,'source',json_object('platform','facebook','path',c.source_path,'index',c.source_index))) FROM comments c WHERE c.post_id=p.id ORDER BY COALESCE(c.created_at,'') ASC,c.id) commentsJson,(SELECT json_group_array(json_object('id',r.id,'targetType',r.target_type,'targetId',r.target_id,'personId',r.person_id,'personName',r.person_name,'kind',r.kind,'createdAt',r.created_at,'source',json_object('platform','facebook','path',r.source_path,'index',r.source_index))) FROM reactions r WHERE r.target_type='post' AND r.target_id=p.id) reactionsJson FROM posts p ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''} ORDER BY COALESCE(created_at,'') ${sort === 'oldest' ? 'ASC' : 'DESC'},id ${sort === 'oldest' ? 'ASC' : 'DESC'} LIMIT ?`;
  bind.push(limit + 1);
  const result = rows(query, bind), hasMore = result.length > limit, items = result.slice(0, limit).map(mapPost), last = items[items.length - 1];
  return { items, hasMore, nextCursor: hasMore && last ? encode({ key: last.createdAt ?? '', id: last.id }) : undefined };
}

function conversationPage(request: DatabaseRequest): Page<ConversationPreview> {
  const limit = limitOf(request.limit), cursor = decode(request.cursor), filter = request.query?.trim(), conditions: string[] = [], bind: unknown[] = [];
  if (filter) { conditions.push('(c.title LIKE ? OR c.participant_names LIKE ?)'); bind.push(`%${filter}%`, `%${filter}%`); }
  if (cursor) { conditions.push("(COALESCE((SELECT MAX(sent_at) FROM messages lm WHERE lm.conversation_id=c.id),'') < ? OR (COALESCE((SELECT MAX(sent_at) FROM messages lm WHERE lm.conversation_id=c.id),'') = ? AND c.id < ?))"); bind.push(cursor.key, cursor.key, cursor.id); }
  const query = `SELECT c.id,c.title,c.participant_names participantNamesJson,c.participant_ids participantIdsJson,c.source_path sourcePath,(SELECT COUNT(*) FROM messages m WHERE m.conversation_id=c.id) messageCount,(SELECT body FROM messages lm WHERE lm.conversation_id=c.id ORDER BY COALESCE(lm.sent_at,'') DESC,lm.id DESC LIMIT 1) latestText,(SELECT sent_at FROM messages lm WHERE lm.conversation_id=c.id ORDER BY COALESCE(lm.sent_at,'') DESC,lm.id DESC LIMIT 1) latestSentAt,c.is_group isGroup FROM conversations c ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''} ORDER BY COALESCE((SELECT MAX(sent_at) FROM messages lm WHERE lm.conversation_id=c.id),'') DESC,c.id DESC LIMIT ?`;
  bind.push(limit + 1);
  const result = rows(query, bind), hasMore = result.length > limit;
  const items = result.slice(0, limit).map(row => ({ id: String(row.id), title: row.title ? String(row.title) : undefined, participantIds: json<string[]>(row.participantIdsJson, []), participantNames: json<string[]>(row.participantNamesJson, []), source: { platform: 'facebook', path: String(row.sourcePath) }, messageCount: Number(row.messageCount), latestText: row.latestText ? String(row.latestText) : undefined, latestSentAt: row.latestSentAt ? String(row.latestSentAt) : undefined, isGroup: Number(row.isGroup ?? 0) === 1 }));
  const last = items[items.length - 1];
  return { items, hasMore, nextCursor: hasMore && last ? encode({ key: last.latestSentAt ?? '', id: last.id }) : undefined };
}

function messagePage(request: DatabaseRequest): Page<Message> {
  const limit = limitOf(request.limit), cursor = decode(request.cursor), conditions = ['conversation_id=?'], bind: unknown[] = [request.conversationId];
  if (cursor) { conditions.push("(COALESCE(sent_at,'') < ? OR (COALESCE(sent_at,'') = ? AND id < ?))"); bind.push(cursor.key, cursor.key, cursor.id); }
  const result = rows(`SELECT id,conversation_id conversationId,sender_id senderId,sender_name senderName,body text,sent_at sentAt,source_path sourcePath,source_index sourceIndex,(SELECT COUNT(*) FROM media m WHERE m.owner_type='message' AND m.owner_id=messages.id) mediaCount,(SELECT json_group_array(json_object('id',m.id,'path',m.path,'mediaType',m.media_type,'filename',m.filename,'mimeType',m.mime_type,'caption',m.caption,'timestamp',m.timestamp,'ownerType',m.owner_type,'ownerId',m.owner_id,'width',m.width,'height',m.height,'durationMs',m.duration_ms,'sourcePath',m.source_path,'sourceIndex',m.source_index)) FROM media m WHERE m.owner_type='message' AND m.owner_id=messages.id) mediaJson FROM messages WHERE ${conditions.join(' AND ')} ORDER BY COALESCE(sent_at,'') DESC,id DESC LIMIT ?`, [...bind, limit + 1]);
  const hasMore = result.length > limit, items = result.slice(0, limit).map(mapMessage), last = items[items.length - 1];
  return { items, hasMore, nextCursor: hasMore && last ? encode({ key: last.sentAt ?? '', id: last.id }) : undefined };
}

function mediaPage(request: DatabaseRequest): Page<Media> {
  const limit = limitOf(request.limit), cursor = decode(request.cursor), bind: unknown[] = [], conditions: string[] = [];
  if (request.mediaType) { conditions.push('media_type=?'); bind.push(request.mediaType); }
  if (cursor) { conditions.push("(COALESCE(timestamp,'') < ? OR (COALESCE(timestamp,'') = ? AND id < ?))"); bind.push(cursor.key, cursor.key, cursor.id); }
  const result = rows(`SELECT id,path,media_type mediaType,filename,mime_type mimeType,caption,timestamp,owner_type ownerType,owner_id ownerId,width,height,duration_ms durationMs,source_path sourcePath,source_index sourceIndex FROM media ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''} ORDER BY COALESCE(timestamp,'') DESC,id DESC LIMIT ?`, [...bind, limit + 1]);
  const hasMore = result.length > limit, items = result.slice(0, limit).map(mapMedia), last = items[items.length - 1];
  return { items, hasMore, nextCursor: hasMore && last ? encode({ key: last.timestamp ?? '', id: last.id }) : undefined };
}

function peoplePage(request: DatabaseRequest): Page<PersonSummary> {
  const limit = limitOf(request.limit), cursor = decode(request.cursor), conditions: string[] = [], bind: unknown[] = [];
  if (request.query?.trim()) { conditions.push('p.display_name LIKE ?'); bind.push(`%${request.query.trim()}%`); }
  if (cursor) { conditions.push('(LOWER(p.display_name)>LOWER(?) OR (LOWER(p.display_name)=LOWER(?) AND p.id>?))'); bind.push(cursor.name, cursor.name, cursor.id); }
  const query = `SELECT p.id,p.facebook_id facebookId,p.display_name displayName,p.username,p.profile_url profileUrl,p.profile_photo_path profilePhotoPath,p.cover_photo_path coverPhotoPath,p.first_seen firstSeen,p.last_seen lastSeen,p.relationship,p.identity_confidence identityConfidence,p.identity_source identitySource,p.source_paths sourcePaths,p.is_archive_owner isArchiveOwner,(SELECT COUNT(*) FROM messages m WHERE m.sender_id=p.id) messageCount,(SELECT COUNT(*) FROM posts po WHERE po.author_id=p.id) postCount,(SELECT COUNT(*) FROM comments co WHERE co.author_id=p.id) commentCount,(SELECT COUNT(*) FROM reactions re WHERE re.person_id=p.id) reactionCount,(SELECT COUNT(*) FROM connections cn WHERE cn.person_id=p.id) connectionCount,(SELECT COUNT(*) FROM albums al WHERE al.owner_id=p.id) albumCount,(SELECT COUNT(*) FROM media me WHERE (me.owner_type='post' AND me.owner_id IN (SELECT id FROM posts WHERE author_id=p.id)) OR (me.owner_type='message' AND me.owner_id IN (SELECT id FROM messages WHERE sender_id=p.id)) OR (me.owner_type='album' AND me.owner_id=p.id)) mediaCount,(SELECT COUNT(*) FROM posts po WHERE po.author_id=p.id) sharedPostCount,(SELECT COUNT(*) FROM media me WHERE me.owner_type='album' AND me.owner_id IN (SELECT id FROM albums WHERE owner_id=p.id)) sharedMediaCount,(SELECT COUNT(*) FROM conversations c WHERE c.participant_ids LIKE '%'||p.id||'%') participationCount,(SELECT MIN(value) FROM (SELECT sent_at value FROM messages WHERE sender_id=p.id UNION ALL SELECT created_at value FROM posts WHERE author_id=p.id UNION ALL SELECT created_at value FROM comments WHERE author_id=p.id UNION ALL SELECT created_at value FROM reactions WHERE person_id=p.id)) firstInteraction,(SELECT MAX(value) FROM (SELECT sent_at value FROM messages WHERE sender_id=p.id UNION ALL SELECT created_at value FROM posts WHERE author_id=p.id UNION ALL SELECT created_at value FROM comments WHERE author_id=p.id UNION ALL SELECT created_at value FROM reactions WHERE person_id=p.id)) lastInteraction FROM people p ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''} ORDER BY LOWER(p.display_name),p.id LIMIT ?`;
  bind.push(limit + 1);
  const result = rows(query, bind), hasMore = result.length > limit, items = result.slice(0, limit).map(mapPerson), last = items[items.length - 1];
  return { items, hasMore, nextCursor: hasMore && last ? encode({ name: last.displayName, id: last.id }) : undefined };
}

function personById(personId?: string): PersonSummary | undefined {
  if (!personId) return undefined;
  return peoplePage({ id: 0, type: 'people', query: undefined, limit: 100 }).items.find(person => person.id === personId) ?? (() => {
    const result = rows(`SELECT p.id,p.facebook_id facebookId,p.display_name displayName,p.username,p.profile_url profileUrl,p.profile_photo_path profilePhotoPath,p.cover_photo_path coverPhotoPath,p.first_seen firstSeen,p.last_seen lastSeen,p.relationship,p.identity_confidence identityConfidence,p.identity_source identitySource,p.source_paths sourcePaths,p.is_archive_owner isArchiveOwner,(SELECT COUNT(*) FROM messages m WHERE m.sender_id=p.id) messageCount,(SELECT COUNT(*) FROM posts po WHERE po.author_id=p.id) postCount,(SELECT COUNT(*) FROM comments co WHERE co.author_id=p.id) commentCount,(SELECT COUNT(*) FROM reactions re WHERE re.person_id=p.id) reactionCount,(SELECT COUNT(*) FROM connections cn WHERE cn.person_id=p.id) connectionCount,(SELECT COUNT(*) FROM albums al WHERE al.owner_id=p.id) albumCount,(SELECT COUNT(*) FROM media me WHERE (me.owner_type='post' AND me.owner_id IN (SELECT id FROM posts WHERE author_id=p.id)) OR (me.owner_type='message' AND me.owner_id IN (SELECT id FROM messages WHERE sender_id=p.id)) OR (me.owner_type='album' AND me.owner_id=p.id)) mediaCount,(SELECT COUNT(*) FROM posts po WHERE po.author_id=p.id) sharedPostCount,(SELECT COUNT(*) FROM media me WHERE me.owner_type='album' AND me.owner_id IN (SELECT id FROM albums WHERE owner_id=p.id)) sharedMediaCount,(SELECT COUNT(*) FROM conversations c WHERE c.participant_ids LIKE '%'||p.id||'%') participationCount,(SELECT MIN(value) FROM (SELECT sent_at value FROM messages WHERE sender_id=p.id UNION ALL SELECT created_at value FROM posts WHERE author_id=p.id UNION ALL SELECT created_at value FROM comments WHERE author_id=p.id UNION ALL SELECT created_at value FROM reactions WHERE person_id=p.id)) firstInteraction,(SELECT MAX(value) FROM (SELECT sent_at value FROM messages WHERE sender_id=p.id UNION ALL SELECT created_at value FROM posts WHERE author_id=p.id UNION ALL SELECT created_at value FROM comments WHERE author_id=p.id UNION ALL SELECT created_at value FROM reactions WHERE person_id=p.id)) lastInteraction FROM people p WHERE p.id=? LIMIT 1`, [personId]);
    return result[0] ? mapPerson(result[0]) : undefined;
  })();
}

function mapConnection(row: Record<string, unknown>): ConnectionSummary {
  return { id: String(row.id), personId: String(row.personId), displayName: String(row.displayName), facebookId: row.facebookId ? String(row.facebookId) : undefined, username: row.username ? String(row.username) : undefined, profileUrl: row.profileUrl ? String(row.profileUrl) : undefined, type: String(row.type) as Connection['type'], startedAt: row.startedAt ? String(row.startedAt) : undefined, endedAt: row.endedAt ? String(row.endedAt) : undefined, source: { platform: 'facebook', path: String(row.sourcePath), index: row.sourceIndex === null || row.sourceIndex === undefined ? undefined : Number(row.sourceIndex) } };
}
function mapAlbum(row: Record<string, unknown>): AlbumSummary {
  return { id: String(row.id), title: String(row.title), description: row.description ? String(row.description) : undefined, ownerId: row.ownerId ? String(row.ownerId) : undefined, createdAt: row.createdAt ? String(row.createdAt) : undefined, updatedAt: row.updatedAt ? String(row.updatedAt) : undefined, mediaIds: json<string[]>(row.mediaIdsJson, []), mediaCount: Number(row.mediaCount ?? 0), source: { platform: 'facebook', path: String(row.sourcePath), index: row.sourceIndex === null || row.sourceIndex === undefined ? undefined : Number(row.sourceIndex) } };
}
function connectionsPage(request: DatabaseRequest): Page<ConnectionSummary> {
  const limit = limitOf(request.limit), cursor = decode(request.cursor), conditions: string[] = [], bind: unknown[] = [];
  if (request.connectionType) { conditions.push('c.relationship_type=?'); bind.push(request.connectionType); }
  if (request.query?.trim()) { conditions.push('(c.display_name LIKE ? OR c.username LIKE ?)'); bind.push(`%${request.query.trim()}%`, `%${request.query.trim()}%`); }
  if (cursor) { conditions.push('(LOWER(c.display_name)>LOWER(?) OR (LOWER(c.display_name)=LOWER(?) AND c.id>?))'); bind.push(cursor.name, cursor.name, cursor.id); }
  const result = rows(`SELECT c.id,c.person_id personId,c.display_name displayName,c.facebook_id facebookId,c.username,c.profile_url profileUrl,c.relationship_type type,c.started_at startedAt,c.ended_at endedAt,c.source_path sourcePath,c.source_index sourceIndex FROM connections c ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''} ORDER BY LOWER(c.display_name),c.id LIMIT ?`, [...bind, limit + 1]);
  const hasMore = result.length > limit, items = result.slice(0, limit).map(mapConnection), last = items[items.length - 1];
  return { items, hasMore, nextCursor: hasMore && last ? encode({ name: last.displayName, id: last.id }) : undefined };
}
function albumsPage(request: DatabaseRequest): Page<AlbumSummary> {
  const limit = limitOf(request.limit), cursor = decode(request.cursor), conditions: string[] = [], bind: unknown[] = [];
  if (request.query?.trim()) { conditions.push('(a.title LIKE ? OR a.description LIKE ?)'); bind.push(`%${request.query.trim()}%`, `%${request.query.trim()}%`); }
  if (cursor) { conditions.push('(COALESCE(a.updated_at,a.created_at,\'\') < ? OR (COALESCE(a.updated_at,a.created_at,\'\') = ? AND a.id < ?))'); bind.push(cursor.key, cursor.key, cursor.id); }
  const result = rows(`SELECT a.id,a.title,a.description,a.owner_id ownerId,a.created_at createdAt,a.updated_at updatedAt,a.source_path sourcePath,a.source_index sourceIndex,(SELECT json_group_array(media_id) FROM album_media am WHERE am.album_id=a.id ORDER BY am.position) mediaIdsJson,(SELECT COUNT(*) FROM album_media am WHERE am.album_id=a.id) mediaCount FROM albums a ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''} ORDER BY COALESCE(a.updated_at,a.created_at,'') DESC,a.id DESC LIMIT ?`, [...bind, limit + 1]);
  const hasMore = result.length > limit, items = result.slice(0, limit).map(mapAlbum), last = items[items.length - 1];
  return { items, hasMore, nextCursor: hasMore && last ? encode({ key: last.updatedAt ?? last.createdAt ?? '', id: last.id }) : undefined };
}
function albumById(albumId?: string): { album: AlbumSummary; media: Media[] } | undefined {
  if (!albumId) return undefined;
  const row = rows(`SELECT a.id,a.title,a.description,a.owner_id ownerId,a.created_at createdAt,a.updated_at updatedAt,a.source_path sourcePath,a.source_index sourceIndex,(SELECT json_group_array(media_id) FROM album_media am WHERE am.album_id=a.id ORDER BY am.position) mediaIdsJson,(SELECT COUNT(*) FROM album_media am WHERE am.album_id=a.id) mediaCount FROM albums a WHERE a.id=? LIMIT 1`, [albumId])[0];
  if (!row) return undefined;
  const album = mapAlbum(row), media = rows('SELECT m.id,m.path,m.media_type mediaType,m.filename,m.mime_type mimeType,m.caption,m.timestamp,m.owner_type ownerType,m.owner_id ownerId,m.width,m.height,m.duration_ms durationMs,m.source_path sourcePath,m.source_index sourceIndex FROM media m JOIN album_media am ON am.media_id=m.id WHERE am.album_id=? ORDER BY am.position', [albumId]).map(mapMedia);
  return { album, media };
}

function safeFtsQuery(query: string) { return query.trim().split(/\s+/).filter(Boolean).map(token => `"${token.replaceAll('"', '""')}"`).join(' AND '); }
function search(request: DatabaseRequest): SearchResponse {
  const query = request.query?.trim() ?? '', limit = limitOf(request.limit), cursor = decode(request.cursor);
  if (!query) return { items: [], counts: {}, hasMore: false, backend: searchBackend };
  const ftsQuery = safeFtsQuery(query);
  let result: Record<string, unknown>[] = [];
  if (searchBackend === 'fts5') {
    try {
      const bind: unknown[] = [ftsQuery]; let sql = "SELECT rowid resultRowid,entity_type entityType,entity_id entityId,title,body,context,snippet(archive_fts,3,'[[H]]','[[/H]]','…',18) snippet,created_at createdAt,conversation_id conversationId,source_path sourcePath FROM archive_fts WHERE archive_fts MATCH ?";
      if (cursor) { sql += ' AND rowid > ?'; bind.push(Number(cursor.rowid)); }
      sql += ' ORDER BY rank,rowid LIMIT ?'; bind.push(limit + 1); result = rows(sql, bind);
    } catch { searchBackend = 'like'; }
  }
  if (searchBackend === 'like') {
    const pattern = `%${query}%`, bind: unknown[] = [pattern, pattern, pattern]; let sql = "SELECT rowid resultRowid,entity_type entityType,entity_id entityId,title,body,context,substr(COALESCE(body,title,context),1,240) snippet,created_at createdAt,conversation_id conversationId,source_path sourcePath FROM search_documents WHERE title LIKE ? OR body LIKE ? OR context LIKE ?";
    if (cursor) { sql += ' AND rowid > ?'; bind.push(Number(cursor.rowid)); }
    sql += ' ORDER BY rowid LIMIT ?'; bind.push(limit + 1); result = rows(sql, bind);
  }
  const hasMore = result.length > limit;
  const items = result.slice(0, limit).map(row => ({ entityType: String(row.entityType), entityId: String(row.entityId), title: row.title ? String(row.title) : undefined, body: row.body ? String(row.body) : undefined, context: row.context ? String(row.context) : undefined, snippet: row.snippet ? String(row.snippet) : undefined, createdAt: row.createdAt ? String(row.createdAt) : undefined, conversationId: row.conversationId ? String(row.conversationId) : undefined, sourcePath: row.sourcePath ? String(row.sourcePath) : undefined } satisfies SearchResult));
  const counts = items.reduce<Record<string, number>>((acc, item) => { acc[item.entityType] = (acc[item.entityType] ?? 0) + 1; return acc; }, {});
  return { items, counts, hasMore, nextCursor: hasMore ? encode({ rowid: result[limit].resultRowid ?? limit }) : undefined, backend: searchBackend };
}

function rebuildSearchFromDatabase() {
  const profileRow = rows("SELECT id,person_id personId,display_name displayName,username,bio,joined_at joinedAt,source_path sourcePath,(SELECT json_group_array(json_object('id',f.id,'category',f.category,'label',f.label,'value',f.value,'startDate',f.start_date,'endDate',f.end_date,'source',json_object('platform','facebook','path',f.source_path,'index',f.source_index))) FROM profile_facts f WHERE f.profile_id=profiles.id) factsJson FROM profiles LIMIT 1")[0];
  const people = rows('SELECT id,display_name displayName,facebook_id facebookId,username,profile_url profileUrl,profile_photo_path profilePhotoPath,cover_photo_path coverPhotoPath,first_seen firstSeen,last_seen lastSeen,relationship,identity_confidence identityConfidence,identity_source identitySource,source_paths sourcePaths,is_archive_owner isArchiveOwner FROM people').map(row => ({ ...mapPerson({ ...row, participationCount: 0, messageCount: 0, postCount: 0, mediaCount: 0 }), id: String(row.id) }));
  const posts = rows('SELECT id,author_id authorId,title,body text,created_at createdAt,source_path sourcePath,source_index sourceIndex,0 mediaCount FROM posts').map(mapPost);
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

function stats(): ArchiveStats {
  const count = (table: string) => Number(rows(`SELECT COUNT(*) count FROM ${table}`)[0]?.count ?? 0);
  const range = rows("SELECT MIN(value) earliest,MAX(value) latest FROM (SELECT created_at value FROM posts WHERE created_at IS NOT NULL UNION ALL SELECT sent_at value FROM messages WHERE sent_at IS NOT NULL UNION ALL SELECT created_at value FROM comments WHERE created_at IS NOT NULL UNION ALL SELECT created_at value FROM reactions WHERE created_at IS NOT NULL)")[0];
  const years = rows("SELECT DISTINCT CAST(substr(value,1,4) AS INTEGER) year FROM (SELECT created_at value FROM posts WHERE created_at IS NOT NULL UNION ALL SELECT sent_at value FROM messages WHERE sent_at IS NOT NULL UNION ALL SELECT created_at value FROM comments WHERE created_at IS NOT NULL UNION ALL SELECT created_at value FROM reactions WHERE created_at IS NOT NULL) WHERE year IS NOT NULL ORDER BY year DESC").map(row => Number(row.year));
  const diagnostics = json<NormalizedArchiveData['diagnostics'] | undefined>(rows("SELECT value FROM import_metadata WHERE key='diagnostics'")[0]?.value, undefined);
  const identity = identityFromRow(rows('SELECT filename,size,entry_count entryCount,fingerprint,known_entries knownEntries FROM archive_identity WHERE id=1')[0]);
  return { profiles: count('profiles'), people: count('people'), posts: count('posts'), comments: count('comments'), reactions: count('reactions'), connections: count('connections'), albums: count('albums'), conversations: count('conversations'), messages: count('messages'), media: count('media'), earliest: range?.earliest ? String(range.earliest) : undefined, latest: range?.latest ? String(range.latest) : undefined, warnings: Number(rows("SELECT value FROM import_metadata WHERE key='warning_count'")[0]?.value ?? 0), sections: Number(rows("SELECT value FROM import_metadata WHERE key='section_count'")[0]?.value ?? 0), years, diagnostics, archiveIdentity: identity };
}

async function init() {
  const sqlite3 = await sqlite3InitModule();
  if (sqlite3.oo1.OpfsDb) {
    try { const OpfsDb = sqlite3.oo1.OpfsDb as unknown as new (filename: string, flags: string) => DB; db = new OpfsDb('/socialvault.sqlite3', 'c'); mode = 'opfs'; }
    catch { db = new sqlite3.oo1.DB(':memory:', 'c') as unknown as DB; }
  } else db = new sqlite3.oo1.DB(':memory:', 'c') as unknown as DB;
  applyMigrations(); backfillPeopleFromLegacyTables(); setupSearch();
  if (mode === 'indexeddb') { const saved = await getFallback(); if (saved) replace(saved); }
  else if (Number(rows('SELECT COUNT(*) count FROM search_documents')[0]?.count ?? 0) === 0 && Number(rows('SELECT COUNT(*) count FROM posts')[0]?.count ?? 0) > 0) rebuildSearchFromDatabase();
  return { mode, searchBackend };
}

self.onmessage = async (event: MessageEvent<DatabaseRequest>) => {
  const request = event.data;
  try {
    if (request.type === 'init') { send({ id: request.id, ok: true, data: await init() }); return; }
    if (request.type === 'replace' && request.data) { replace(request.data); if (mode === 'indexeddb') await putFallback(normalizedData(request.data)); send({ id: request.id, ok: true }); return; }
    if (request.type === 'profile') { const row = rows("SELECT pr.id,pr.person_id personId,pr.display_name displayName,pr.username,pr.bio,pr.joined_at joinedAt,pr.source_path sourcePath,p.facebook_id facebookId,p.profile_url profileUrl,p.relationship,p.profile_photo_path profilePhotoPath,p.cover_photo_path coverPhotoPath,(SELECT json_group_array(json_object('id',f.id,'category',f.category,'label',f.label,'value',f.value,'startDate',f.start_date,'endDate',f.end_date,'source',json_object('platform','facebook','path',f.source_path,'index',f.source_index))) FROM profile_facts f WHERE f.profile_id=pr.id) factsJson FROM profiles pr LEFT JOIN people p ON p.id=pr.person_id LIMIT 1")[0]; send({ id: request.id, ok: true, data: mapProfile(row) }); return; }
    if (request.type === 'people') { send({ id: request.id, ok: true, data: peoplePage(request) }); return; }
    if (request.type === 'person') { send({ id: request.id, ok: true, data: personById(request.personId) }); return; }
    if (request.type === 'posts') { send({ id: request.id, ok: true, data: postPage(request) }); return; }
    if (request.type === 'conversations') { send({ id: request.id, ok: true, data: conversationPage(request) }); return; }
    if (request.type === 'messages') { send({ id: request.id, ok: true, data: messagePage(request) }); return; }
    if (request.type === 'media') { send({ id: request.id, ok: true, data: mediaPage(request) }); return; }
    if (request.type === 'connections') { send({ id: request.id, ok: true, data: connectionsPage(request) }); return; }
    if (request.type === 'albums') { send({ id: request.id, ok: true, data: albumsPage(request) }); return; }
    if (request.type === 'album') { send({ id: request.id, ok: true, data: albumById(request.albumId) }); return; }
    if (request.type === 'search') { send({ id: request.id, ok: true, data: search(request) }); return; }
    if (request.type === 'stats') { send({ id: request.id, ok: true, data: stats() }); return; }
    if (request.type === 'archive-identity') { send({ id: request.id, ok: true, data: identityFromRow(rows('SELECT filename,size,entry_count entryCount,fingerprint,known_entries knownEntries FROM archive_identity WHERE id=1')[0]) }); return; }
    if (request.type === 'media-cache' && request.mediaPath) { db.exec({ sql: 'INSERT OR REPLACE INTO media_cache(path,last_accessed,byte_size) VALUES(?,?,?)', bind: [request.mediaPath, new Date().toISOString(), request.byteSize ?? null] }); send({ id: request.id, ok: true }); return; }
  } catch (error) { send({ id: request.id, ok: false, error: error instanceof Error ? error.message : String(error) }); }
};
