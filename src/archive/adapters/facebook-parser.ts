import { z } from 'zod';
import { isSuspiciousPath } from '../security';
import type { Album, Comment, Connection, ConnectionType, Conversation, Media, Message, NormalizedArchiveData, Person, Post, Profile, ProfileFact, Reaction } from '../schemas/models';

const record = z.record(z.unknown());
const asRecord = (value: unknown) => record.safeParse(value).success ? value as Record<string, unknown> : {};
const text = (...values: unknown[]) => values.find(value => typeof value === 'string' && value.trim()) as string | undefined;
const numberText = (...values: unknown[]) => {
  const value = values.find(candidate => typeof candidate === 'number' || (typeof candidate === 'string' && candidate.trim()));
  if (value === undefined) return undefined;
  const normalized = String(value).trim();
  return /^\d+$/.test(normalized) ? normalized : undefined;
};
/** Parse timestamps observed in Meta exports without guessing human dates. */
export const parseFacebookTimestamp = (value: unknown) => {
  if (typeof value !== 'number' && typeof value !== 'string') return undefined;
  const candidate = typeof value === 'string' ? value.trim() : value;
  if (candidate === '') return undefined;
  if (typeof candidate === 'string' && /^\d{4}$/.test(candidate)) return `${candidate}-01-01T00:00:00.000Z`;
  const parsedNumber = typeof candidate === 'number' ? candidate : /^\d+(?:\.\d+)?$/.test(candidate) ? Number(candidate) : Number.NaN;
  if (typeof parsedNumber === 'number' && !Number.isFinite(parsedNumber)) {
    // Only ISO/date-only strings are accepted here; ambiguous human-formatted
    // dates are intentionally rejected instead of being guessed.
    if (typeof candidate !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:[T ][0-9:.+\-Z]+)?$/.test(candidate)) return undefined;
  }
  const numeric = Number.isFinite(parsedNumber) ? (parsedNumber < 1e12 ? parsedNumber * 1000 : parsedNumber) : parsedNumber;
  const parsed = new Date(Number.isFinite(numeric) ? numeric : candidate as string);
  return Number.isNaN(parsed.valueOf()) ? undefined : parsed.toISOString();
};
const date = parseFacebookTimestamp;
const idPart = (path: string) => path.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
export const normalizeFacebookMediaPath = (value: string) => {
  let decoded = value;
  try { decoded = decodeURIComponent(value); } catch { /* keep the original path when it is not valid URI encoding */ }
  return decoded.replaceAll('\\', '/').replace(/^\.\//, '').replace(/^\//, '');
};
const normalizedPath = normalizeFacebookMediaPath;
const mediaType = (path: string, hint?: string): Media['mediaType'] => {
  const value = `${hint ?? ''} ${path}`.toLowerCase();
  if (value.includes('video') || /\.(mp4|mov|webm|m4v)$/.test(value)) return 'video';
  if (value.includes('audio') || /\.(mp3|m4a|wav|ogg|oga)$/.test(value)) return 'audio';
  if (value.includes('image') || /\.(jpe?g|png|gif|webp|heic|avif)$/.test(value)) return 'photo';
  if (value.includes('file') || /\.(pdf|docx?|xlsx?|txt|zip)$/.test(value)) return 'file';
  return 'unknown';
};
const profileUrl = (...values: unknown[]) => {
  const value = text(...values);
  return value && /^https?:\/\//i.test(value) ? value : undefined;
};

/** Return a privacy-safe structural signature for diagnostics. Values are never included. */
export function shapeSignature(value: unknown, depth = 0): string {
  if (depth > 3) return '…';
  if (Array.isArray(value)) return `array[${value.length ? shapeSignature(value[0], depth + 1) : 'empty'}]`;
  if (value === null) return 'null';
  if (typeof value !== 'object') return typeof value;
  const object = asRecord(value);
  // Keys in Facebook's object-keyed exports can themselves be private names
  // or IDs. Keep only a small vocabulary of structural field names and
  // redact everything else while preserving the observed shape.
  const structuralKeys = new Set(['about_me', 'account', 'account_information', 'albums', 'attachments', 'author', 'basic_information', 'body', 'content', 'conversation', 'created_at', 'data', 'display_name', 'entries', 'file_name', 'full_name', 'id', 'items', 'message', 'message_data', 'messages', 'messages_data', 'name', 'participants', 'path', 'personal_information', 'post', 'posts', 'posts_v2', 'profile', 'profile_information', 'profile_v2', 'sender', 'sender_name', 'text', 'thread', 'timestamp', 'title', 'uri', 'user_id', 'username']);
  return `object{${Object.keys(object).sort().slice(0, 12).map(key => `${structuralKeys.has(key.toLowerCase()) ? key.toLowerCase() : '<key>'}:${shapeSignature(object[key], depth + 1)}`).join(',')}}`;
}

export function diagnosticWarningCategory(message: string) {
  const normalized = message.replace(/^.*?·\s*/, '').replace(/\([^)]*\)/g, '(path)').replace(/\d+/g, '#').trim();
  if (/unsupported|unrecognized/i.test(normalized)) return 'unsupported-shape';
  if (/malformed|JSON|parse/i.test(normalized)) return 'malformed-json';
  if (/suspicious|unsafe/i.test(normalized)) return 'unsafe-path';
  if (/media reference not found/i.test(normalized)) return 'missing-media';
  if (/duplicate/i.test(normalized)) return 'duplicate-part';
  return normalized.slice(0, 120) || 'import-warning';
}

function collectMedia(value: unknown, ownerType: 'post' | 'message' | 'album', ownerId: string, sourcePath: string, sourceIndex: number) {
  const found: Media[] = [];
  const seen = new Set<string>();
  const walk = (node: unknown, depth: number) => {
    if (depth > 6 || node === null || node === undefined) return;
    if (Array.isArray(node)) { node.forEach(item => walk(item, depth + 1)); return; }
    const object = asRecord(node);
    const reference = text(object.uri, object.path, object.filename, object.file_name, object.fileName, object.local_path, object.localPath);
    const hint = text(object.mime_type, object.mimeType, object.type, object.media_type, object.mediaType);
    if (reference && !/^https?:\/\//i.test(reference) && !/^data:/i.test(reference) && !isSuspiciousPath(reference)) {
      const path = normalizedPath(reference);
      if (!isSuspiciousPath(path) && (/[-_./]/.test(path) || hint)) {
        const key = `${path}|${hint ?? ''}`;
        if (!seen.has(key)) {
          seen.add(key);
          const metadata = asRecord(object.media_metadata ?? object.metadata ?? object.dimensions);
          found.push({
            id: `media:${ownerType}:${idPart(ownerId)}:${found.length}`,
            path,
            filename: path.split('/').pop(),
            mediaType: mediaType(path, hint),
            mimeType: hint?.includes('/') ? hint.toLowerCase() : undefined,
            caption: text(object.description, object.caption, object.title, object.name),
            timestamp: date(object.creation_timestamp ?? object.timestamp ?? object.creation_time),
            ownerType,
            ownerId,
            width: typeof metadata.width === 'number' ? metadata.width : undefined,
            height: typeof metadata.height === 'number' ? metadata.height : undefined,
            durationMs: typeof metadata.duration_ms === 'number' ? metadata.duration_ms : (typeof metadata.duration === 'number' ? metadata.duration * 1000 : undefined),
            source: { platform: 'facebook', path: sourcePath, index: sourceIndex },
          });
        }
      }
    }
    Object.values(object).forEach(child => walk(child, depth + 1));
  };
  walk(value, 0);
  return found;
}

export function findUnsafeMediaReferences(value: unknown): string[] {
  const unsafe = new Set<string>();
  const walk = (node: unknown, depth: number) => {
    if (depth > 7 || node === null || node === undefined) return;
    if (Array.isArray(node)) { node.forEach(item => walk(item, depth + 1)); return; }
    const object = asRecord(node);
    for (const key of ['uri', 'path', 'filename', 'file_name', 'fileName', 'local_path', 'localPath']) {
      const candidate = object[key];
      if (typeof candidate === 'string' && (isSuspiciousPath(candidate) || isSuspiciousPath(normalizeFacebookMediaPath(candidate)))) unsafe.add(candidate);
    }
    Object.values(object).forEach(child => walk(child, depth + 1));
  };
  walk(value, 0);
  return [...unsafe];
}

function profileRoot(raw: unknown) {
  const root = asRecord(raw);
  const candidates: unknown[] = [root.profile_information, root.profile_v2, root.personal_information, root.profile, root.account, root.account_information, root.user_profile, root.accounts, Array.isArray(raw) ? raw : undefined, root];
  const queue = [...candidates];
  for (let depth = 0; depth < 5 && queue.length; depth++) {
    const current = queue.splice(0, queue.length);
    for (const candidate of current) {
      if (Array.isArray(candidate)) {
        const first = candidate.find(item => Object.keys(asRecord(item)).length);
        if (first) queue.push(first);
        continue;
      }
      const value = asRecord(candidate);
      if (!Object.keys(value).length) continue;
      if (text(value.name, value.full_name, value.display_name, value.username, value.user_name, value.id, value.user_id)) return { root, value };
      for (const key of ['profile_information', 'profile_v2', 'personal_information', 'basic_information', 'account_information', 'profile', 'account', 'data', 'user']) if (value[key]) queue.push(value[key]);
    }
  }
  return { root, value: {} };
}

const FACT_KEYS: Record<string, string> = {
  work: 'Work', jobs: 'Work', education: 'Education', schools: 'Education',
  places_lived: 'Places lived', placesLived: 'Places lived', hometown: 'Hometown',
  current_city: 'Places lived', currentCity: 'Places lived', relationship_status: 'Relationship',
  relationship: 'Relationship', username_history: 'Username history', usernameHistory: 'Username history',
  languages: 'Languages', family: 'Family', websites: 'Websites', other_names: 'Other names',
};
function factValues(value: unknown, label?: string, depth = 0): { label?: string; value: string; startDate?: string; endDate?: string }[] {
  if (depth > 4 || value === undefined || value === null) return [];
  if (typeof value === 'string' || typeof value === 'number') {
    const result = String(value).trim(); return result ? [{ label, value: result }] : [];
  }
  if (Array.isArray(value)) return value.flatMap(item => factValues(item, label, depth + 1));
  const object = asRecord(value);
  const direct = text(object.value, object.name, object.title, object.text, object.description, object.school, object.company, object.position, object.city, object.location, object.username);
  const result = direct ? [{ label: text(object.label, object.type, object.category) ?? label, value: direct, startDate: date(object.start_timestamp ?? object.start_date ?? object.from), endDate: date(object.end_timestamp ?? object.end_date ?? object.to) }] : [];
  if (result.length) return result;
  return Object.entries(object).flatMap(([key, child]) => key === 'timestamp' ? [] : factValues(child, label ?? key, depth + 1));
}
function parseProfileFacts(profile: Record<string, unknown>, root: Record<string, unknown>, path: string): ProfileFact[] {
  const facts: ProfileFact[] = [];
  const seen = new Set<string>();
  for (const [key, category] of Object.entries(FACT_KEYS)) {
    const value = profile[key] ?? root[key]; if (value === undefined) continue;
    factValues(value).forEach((fact, index) => {
      const id = `fact:${idPart(path)}:${key}:${index}:${idPart(fact.value)}`;
      if (seen.has(id)) return; seen.add(id);
      facts.push({ id, category, label: fact.label, value: fact.value, startDate: fact.startDate, endDate: fact.endDate, source: { platform: 'facebook', path, index } });
    });
  }
  return facts;
}

export function parseFacebookProfile(raw: unknown, path: string): Profile | undefined {
  const { root, value: profile } = profileRoot(raw);
  const nested = asRecord(profile.profile ?? profile.basic_information ?? profile.account_information);
  const displayName = text(profile.name, profile.full_name, profile.display_name, root.name, nested.name);
  if (!displayName) return;
  const facebookId = numberText(profile.id, profile.user_id, profile.facebook_id, root.id);
  const username = text(profile.username, profile.user_name, profile.handle, nested.username);
  const exactProfileUrl = profileUrl(profile.profile_url, profile.profileUrl, profile.url, nested.profile_url);
  const photo = text(profile.profile_picture, profile.profile_photo, profile.profile_photo_uri, profile.profile_picture_uri, nested.profile_picture);
  const cover = text(profile.cover_photo, profile.cover_photo_uri, profile.cover_picture, nested.cover_photo);
  const facts = parseProfileFacts(profile, root, path);
  return {
    id: 'owner',
    personId: 'owner',
    displayName,
    facebookId,
    username,
    profileUrl: exactProfileUrl,
    bio: text(profile.bio, profile.about_me, profile.intro_bio, profile.about, nested.bio),
    joinedAt: date(profile.registration_timestamp ?? profile.account_creation_time ?? profile.joined_at ?? profile.joinedAt),
    relationship: text(profile.relationship_status, profile.relationship, nested.relationship),
    profilePhotoPath: photo && !isSuspiciousPath(photo) && !/^https?:\/\//i.test(photo) ? normalizedPath(photo) : undefined,
    coverPhotoPath: cover && !isSuspiciousPath(cover) && !/^https?:\/\//i.test(cover) ? normalizedPath(cover) : undefined, facts,
    source: { platform: 'facebook', path },
  };
}

function listValue(value: unknown, keys: string[] = []) {
  if (Array.isArray(value)) return value;
  const object = asRecord(value);
  for (const key of keys) if (Array.isArray(object[key])) return object[key] as unknown[];
  if (Object.keys(object).length && !Object.values(object).some(item => typeof item === 'object' && item !== null)) return [value];
  return Object.values(object).filter(item => item && typeof item === 'object');
}
function actorFrom(value: unknown, fallback: string, path: string): { id?: string; name?: string; facebookId?: string; person?: Person } {
  const object = asRecord(value);
  const nested = asRecord(object.actor ?? object.author ?? object.from ?? object.user ?? object.profile ?? object.reacter);
  const source = Object.keys(nested).length ? nested : object;
  const name = text(source.name, source.display_name, source.displayName, source.full_name, source.username, object.actor_name, object.author_name);
  const facebookId = numberText(source.id, source.user_id, source.facebook_id, object.actor_id, object.author_id);
  const id = facebookId ? `person:facebook:${facebookId}` : name ? `person:social:${idPart(path)}:${idPart(name)}` : undefined;
  if (!id && !name) return {};
  return { id, name, facebookId, person: id && name ? { id, displayName: name, facebookId, username: text(source.username, source.user_name), profileUrl: profileUrl(source.profile_url, source.profileUrl, source.url), identityConfidence: facebookId ? 'exact' : 'inferred', identitySource: path, sourcePaths: [path] } : undefined };
}
function parseComments(value: unknown, postId: string, path: string, postIndex: number): { comments: Comment[]; people: Person[] } {
  const comments: Comment[] = [], people: Person[] = [];
  const candidates = listValue(value, ['comments', 'comments_v2', 'comment_data', 'comment', 'data']);
  candidates.forEach((item, index) => {
    const object = asRecord(item);
    const nestedItems = Array.isArray(object.data) ? object.data : [];
    const source = [object, ...nestedItems.map(asRecord)].find(candidate => !!text(candidate.comment, candidate.text, candidate.content, candidate.body, candidate.message, asRecord(candidate.comment).text, asRecord(candidate.comment).comment));
    const body = source ? text(source.comment, source.text, source.content, source.body, source.message, asRecord(source.comment).text, asRecord(source.comment).comment) : undefined;
    if (!body) return;
    const actor = actorFrom({ ...object, ...(source ?? {}) }, `comment:${postId}:${index}`, path);
    const id = `comment:${idPart(path)}:${postIndex}:${index}`;
    const createdAt = date(source?.timestamp ?? source?.timestamp_ms ?? source?.creation_timestamp ?? source?.created_at ?? object.timestamp ?? object.timestamp_ms);
    comments.push({ id, postId, authorId: actor.id, authorName: actor.name, text: body, createdAt, source: { platform: 'facebook', path, index } });
    if (actor.person) people.push({ ...actor.person, firstSeen: createdAt, lastSeen: createdAt });
  });
  return { comments, people };
}
function parseReactions(value: unknown, targetType: Reaction['targetType'], targetId: string, path: string, targetIndex: number): { reactions: Reaction[]; people: Person[] } {
  const reactions: Reaction[] = [], people: Person[] = [];
  const candidates = listValue(value, ['reactions', 'reactions_v2', 'likes', 'data']);
  candidates.forEach((item, index) => {
    const object = asRecord(item);
    const nestedItems = Array.isArray(object.data) ? object.data : [];
    const source = [object, ...nestedItems.map(asRecord)].find(candidate => !!text(candidate.reaction, candidate.type, candidate.kind, candidate.name, candidate.label, candidate.reaction_type));
    const kind = text(source?.reaction, source?.type, source?.kind, source?.name, source?.label, source?.reaction_type) ?? (typeof item === 'string' ? item : undefined) ?? 'Like';
    const actor = actorFrom({ ...object, ...(source ?? {}) }, `reaction:${targetId}:${index}`, path);
    const timestamp = date(source?.timestamp ?? source?.timestamp_ms ?? source?.creation_timestamp ?? source?.created_at ?? object.timestamp ?? object.timestamp_ms);
    const id = `reaction:${targetType}:${idPart(targetId)}:${index}`;
    reactions.push({ id, targetType, targetId, personId: actor.id, personName: actor.name, kind, createdAt: timestamp, source: { platform: 'facebook', path, index } });
    if (actor.person) people.push({ ...actor.person, firstSeen: timestamp, lastSeen: timestamp });
  });
  return { reactions, people };
}
export function parseFacebookComments(raw: unknown, path: string): { comments: Comment[]; people: Person[] } {
  const root = asRecord(raw), sourceItems = Array.isArray(raw) ? raw : listValue(root, ['comments', 'comments_v2', 'comment_data', 'data']);
  const comments: Comment[] = [], people: Person[] = [];
  sourceItems.forEach((item, index) => { const object = asRecord(item), target = text(object.post_id, object.postId, object.target_id, object.targetId, asRecord(object.post).id) ?? `post:${idPart(path)}:${index}`; const parsed = parseComments([item], target, path, index); comments.push(...parsed.comments); people.push(...parsed.people); });
  return { comments, people };
}
export function parseFacebookReactions(raw: unknown, path: string): { reactions: Reaction[]; people: Person[] } {
  const root = asRecord(raw), sourceItems = Array.isArray(raw) ? raw : listValue(root, ['reactions', 'reactions_v2', 'likes', 'data']);
  const reactions: Reaction[] = [], people: Person[] = [];
  sourceItems.forEach((item, index) => { const object = asRecord(item), target = text(object.post_id, object.postId, object.target_id, object.targetId, asRecord(object.post).id) ?? `post:${idPart(path)}:${index}`; const parsed = parseReactions([item], 'post', target, path, index); reactions.push(...parsed.reactions); people.push(...parsed.people); });
  return { reactions, people };
}

function postItems(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  const root = asRecord(raw);
  for (const key of ['posts', 'posts_v2', 'your_posts', 'entries', 'items', 'data']) {
    const value = root[key];
    if (Array.isArray(value)) return value;
    const nested = asRecord(value);
    for (const nestedKey of ['posts', 'entries', 'items', 'data']) if (Array.isArray(nested[nestedKey])) return nested[nestedKey] as unknown[];
  }
  // Some exports wrap one post in an object keyed by an opaque ID. Keep this
  // bounded and structural rather than scraping arbitrary values.
  const values = Object.values(root).filter(value => {
    const object = asRecord(value);
    return !!text(object.post, object.text, object.message, object.title) || Array.isArray(object.data);
  });
  return values.length ? values : [];
}

export function parseFacebookPostsWithMedia(raw: unknown, path: string): { posts: Post[]; media: Media[]; comments: Comment[]; reactions: Reaction[]; people: Person[] } {
  const list = postItems(raw);
  const posts: Post[] = [];
  const media: Media[] = [], comments: Comment[] = [], reactions: Reaction[] = [], people: Person[] = [];
  list.forEach((item, index) => {
    const post = asRecord(item);
    const data = Array.isArray(post.data) ? post.data.map(asRecord) : [];
    const body = text(post.post, post.text, post.content, post.message, post.story, ...data.map(entry => entry.post ?? entry.text ?? entry.content ?? entry.message));
    const attachments = collectMedia(post, 'post', `post:${idPart(path)}:${index}`, path, index);
    const postId = `post:${idPart(path)}:${index}`;
    const parsedComments = parseComments(post.comments ?? post.comments_v2 ?? post.comment_data ?? post.comment, postId, path, index);
    const parsedReactions = parseReactions(post.reactions ?? post.reactions_v2 ?? post.likes, 'post', postId, path, index);
    if (!body && !text(post.title, post.name) && !attachments.length) return;
    const normalized = {
      id: postId,
      authorId: numberText(post.author_id, post.actor_id, asRecord(post.author).id) ? `person:facebook:${numberText(post.author_id, post.actor_id, asRecord(post.author).id)}` : 'owner',
      authorName: text(asRecord(post.author).name, asRecord(post.author).display_name, post.author_name),
      text: body,
      title: text(post.title, post.name),
      createdAt: date(post.timestamp ?? post.timestamp_ms ?? post.creation_timestamp ?? post.created_timestamp ?? post.created_time),
      commentCount: parsedComments.comments.length || Number(post.comment_count ?? post.comments_count ?? 0) || undefined,
      reactionCount: parsedReactions.reactions.length || Number(post.reaction_count ?? post.reactions_count ?? post.likes_count ?? 0) || undefined,
      comments: parsedComments.comments, reactions: parsedReactions.reactions, source: { platform: 'facebook', path, index },
    } satisfies Post;
    posts.push(normalized);
    media.push(...attachments);
    comments.push(...parsedComments.comments); reactions.push(...parsedReactions.reactions); people.push(...parsedComments.people, ...parsedReactions.people);
  });
  return { posts, media, comments, reactions, people };
}
export function parseFacebookPosts(raw: unknown, path: string): Post[] { return parseFacebookPostsWithMedia(raw, path).posts; }

function connectionTypeFor(path: string, raw: Record<string, unknown>): ConnectionType {
  const value = `${path} ${text(raw.type, raw.relationship, raw.status, raw.direction, raw.__relationship_key) ?? ''}`.toLowerCase();
  if (value.includes('removed') || value.includes('unfriend')) return 'removed_friend';
  if (value.includes('follower')) return 'follower';
  if (value.includes('following')) return 'following';
  if (value.includes('blocked')) return 'blocked';
  if (value.includes('incoming') || value.includes('received')) return 'incoming_request';
  if (value.includes('outgoing') || value.includes('sent')) return 'outgoing_request';
  if (value.includes('friend')) return 'friend';
  return 'unknown';
}
export function parseFacebookConnections(raw: unknown, path: string): { connections: Connection[]; people: Person[] } {
  const root = asRecord(raw);
  const sourceItems = Array.isArray(raw) ? raw : Object.entries(root).flatMap(([key, value]) => Array.isArray(value) ? value.map(item => ({ ...asRecord(item), __relationship_key: key })) : []);
  const connections: Connection[] = [], people: Person[] = [];
  sourceItems.forEach((item, index) => {
    const object = asRecord(item), actor = actorFrom(object, `connection:${path}:${index}`, path);
    const displayName = actor.name ?? text(object.name, object.display_name, object.full_name, object.username);
    if (!displayName) return;
    const facebookId = actor.facebookId ?? numberText(object.id, object.user_id, object.facebook_id);
    const personId = actor.id ?? (facebookId ? `person:facebook:${facebookId}` : `person:connection:${idPart(path)}:${index}`);
    const startedAt = date(object.timestamp ?? object.timestamp_ms ?? object.created_at ?? object.friendship_date ?? object.added_timestamp);
    const endedAt = date(object.removed_timestamp ?? object.removed_at ?? object.unfriended_at);
    const connection: Connection = { id: `connection:${idPart(path)}:${index}`, personId, displayName, facebookId, username: text(object.username, object.user_name), profileUrl: profileUrl(object.profile_url, object.profileUrl, object.url), type: connectionTypeFor(path, object), startedAt, endedAt, source: { platform: 'facebook', path, index } };
    connections.push(connection);
    people.push({ id: personId, displayName, facebookId, username: connection.username, profileUrl: connection.profileUrl, firstSeen: startedAt, lastSeen: endedAt ?? startedAt, identityConfidence: facebookId ? 'exact' : 'inferred', identitySource: path, sourcePaths: [path] });
  });
  return { connections, people };
}

export function parseFacebookAlbumsWithMedia(raw: unknown, path: string): { albums: Album[]; media: Media[] } {
  const root = asRecord(raw), sourceItems = Array.isArray(raw) ? raw : listValue(root, ['albums', 'data']);
  const albums: Album[] = [], media: Media[] = [];
  sourceItems.forEach((item, index) => {
    const object = asRecord(item), title = text(object.title, object.name, object.album_name);
    if (!title) return;
    const albumId = `album:${idPart(path)}:${index}`;
    const children = object.media ?? object.photos ?? object.videos ?? object.items ?? object.contents ?? [];
    const albumMedia = collectMedia(children, 'album', albumId, path, index);
    albums.push({ id: albumId, title, description: text(object.description, object.caption), ownerId: numberText(object.owner_id, object.user_id) ? `person:facebook:${numberText(object.owner_id, object.user_id)}` : 'owner', createdAt: date(object.creation_timestamp ?? object.created_at ?? object.timestamp), updatedAt: date(object.update_timestamp ?? object.updated_at), mediaIds: albumMedia.map(item => item.id), source: { platform: 'facebook', path, index } });
    media.push(...albumMedia);
  });
  return { albums, media };
}

const participantIdentity = (conversationId: string, name: string, facebookId?: string) => `person:messenger:${idPart(conversationId)}:${idPart(facebookId ?? name)}`;

/** Numeric ordering for message_2.json/message_10.json style chunks. */
export function compareFacebookChunkPaths(a: string, b: string) {
  const chunk = (value: string) => Number(value.match(/(?:message|chunk)[_-]?(\d+)/i)?.[1] ?? 0);
  const numberDiff = chunk(a) - chunk(b);
  return numberDiff || a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

function messageItems(raw: unknown, depth = 0): unknown[] {
  if (depth > 4) return [];
  if (Array.isArray(raw)) return raw;
  const root = asRecord(raw);
  for (const key of ['messages', 'message', 'messages_data', 'message_data', 'entries', 'items', 'data']) {
    const candidate = root[key];
    if (Array.isArray(candidate)) return candidate;
    const nested = asRecord(candidate);
    for (const nestedKey of ['messages', 'messages_data', 'entries', 'items', 'data']) if (Array.isArray(nested[nestedKey])) return nested[nestedKey] as unknown[];
  }
  for (const key of ['thread', 'conversation', 'thread_data']) {
    const nested = asRecord(root[key]);
    const messages = messageItems(nested, depth + 1);
    if (messages.length) return messages;
  }
  return [];
}

export function parseFacebookConversationWithMedia(raw: unknown, path: string): { conversation?: Conversation; messages: Message[]; media: Media[]; people: Person[] } {
  const root = asRecord(raw);
  const rawMessages = messageItems(raw);
  const rawParticipants = root.participants ?? asRecord(root.thread).participants ?? asRecord(root.conversation).participants;
  const participantObjects = Array.isArray(rawParticipants) ? rawParticipants.map(asRecord) : Object.values(asRecord(rawParticipants)).map(asRecord);
  const participants = participantObjects.map(item => text(item.name, item.display_name, item.full_name)).filter((value): value is string => !!value);
  if (!rawMessages.length && !root.title && !participants.length) return { messages: [], media: [], people: [] };
  const folder = path.replaceAll('\\', '/').split('/').slice(-2, -1)[0] || idPart(path);
  const conversationId = `conversation:${idPart(String(root.thread_path ?? root.thread_id ?? folder))}`;
  const participantIds = participantObjects.map(item => participantIdentity(conversationId, text(item.name, item.display_name, item.full_name) ?? 'unknown', numberText(item.id, item.user_id)));
  const conversation = { id: conversationId, title: text(root.title, root.thread_name, root.name) ?? (participants.join(', ') || 'Conversation'), participantIds: [...new Set(participantIds)], participantNames: participants, source: { platform: 'facebook', path } } satisfies Conversation;
  const messages: Message[] = [];
  const media: Media[] = [];
  const people: Person[] = participantObjects.map(item => { const name = text(item.name, item.display_name, item.full_name) ?? 'Unknown participant'; return { id: participantIdentity(conversationId, name, numberText(item.id, item.user_id)), displayName: name, facebookId: numberText(item.id, item.user_id), profileUrl: profileUrl(item.profile_url, item.profileUrl, item.url), identityConfidence: numberText(item.id, item.user_id) ? 'exact' : 'inferred', identitySource: path, sourcePaths: [path] }; });
  rawMessages.forEach((item, index) => {
    const message = asRecord(item);
    const senderObject = asRecord(message.sender_info ?? message.sender ?? message.from);
    const senderName = text(message.sender_name, typeof message.sender === 'string' ? message.sender : undefined, typeof message.from === 'string' ? message.from : undefined, senderObject.name, senderObject.display_name, senderObject.full_name);
    const senderId = participantIdentity(conversationId, senderName ?? 'unknown', numberText(message.sender_id, message.user_id, asRecord(message.sender_info).id));
    const messageMedia = collectMedia(message, 'message', `message:${idPart(path)}:${index}`, path, index);
    const body = text(message.content, message.text, message.body, message.message);
    if (!body && !messageMedia.length) return;
    const normalized = {
      id: `message:${idPart(path)}:${index}`,
      conversationId,
      senderId,
      senderName,
      text: body,
      sentAt: date(message.timestamp_ms ?? message.timestamp ?? message.creation_timestamp ?? message.created_at),
      source: { platform: 'facebook', path, index },
    } satisfies Message;
    messages.push(normalized);
    media.push(...messageMedia);
    if (senderName) people.push({ id: senderId, displayName: senderName, facebookId: numberText(message.sender_id, message.user_id, asRecord(message.sender_info).id), firstSeen: normalized.sentAt, lastSeen: normalized.sentAt, identityConfidence: numberText(message.sender_id, message.user_id, asRecord(message.sender_info).id) ? 'exact' : 'inferred', identitySource: path, sourcePaths: [path] });
    if (senderName && !conversation.participantNames.includes(senderName)) conversation.participantNames.push(senderName);
    if (!conversation.participantIds.includes(senderId)) conversation.participantIds.push(senderId);
  });
  // Older exports omit participant arrays; infer the names/IDs from messages.
  for (const person of people) {
    if (person.displayName && !conversation.participantNames.includes(person.displayName)) conversation.participantNames.push(person.displayName);
    if (!conversation.participantIds.includes(person.id)) conversation.participantIds.push(person.id);
  }
  return { conversation, messages, media, people };
}
export function parseFacebookConversation(raw: unknown, path: string): { conversation?: Conversation; messages: Message[] } { const parsed = parseFacebookConversationWithMedia(raw, path); return { conversation: parsed.conversation, messages: parsed.messages }; }

export function personFromProfile(profile: Profile): Person {
  return { id: profile.personId, displayName: profile.displayName, facebookId: profile.facebookId, username: profile.username, profileUrl: profile.profileUrl, profilePhotoPath: profile.profilePhotoPath, coverPhotoPath: profile.coverPhotoPath, relationship: profile.relationship, identityConfidence: 'exact', identitySource: profile.source.path, sourcePaths: [profile.source.path], isArchiveOwner: true };
}

export function emptyNormalizedData(): NormalizedArchiveData { return { people: [], profileFacts: [], posts: [], comments: [], reactions: [], connections: [], albums: [], conversations: [], messages: [], media: [], warnings: [] }; }
