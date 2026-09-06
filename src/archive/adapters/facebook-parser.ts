import { z } from 'zod';
import { isSuspiciousPath } from '../security';
import type { Conversation, Media, Message, NormalizedArchiveData, Person, Post, Profile } from '../schemas/models';

const record = z.record(z.unknown());
const asRecord = (value: unknown) => record.safeParse(value).success ? value as Record<string, unknown> : {};
const text = (...values: unknown[]) => values.find(value => typeof value === 'string' && value.trim()) as string | undefined;
const numberText = (...values: unknown[]) => {
  const value = values.find(candidate => typeof candidate === 'number' || (typeof candidate === 'string' && candidate.trim()));
  if (value === undefined) return undefined;
  const normalized = String(value).trim();
  return /^\d+$/.test(normalized) ? normalized : undefined;
};
const date = (value: unknown) => {
  if (typeof value !== 'number' && typeof value !== 'string') return undefined;
  const numeric = typeof value === 'number' && value < 1e12 ? value * 1000 : Number(value);
  const parsed = new Date(Number.isFinite(numeric) ? numeric : value as string);
  return Number.isNaN(parsed.valueOf()) ? undefined : parsed.toISOString();
};
const idPart = (path: string) => path.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const normalizedPath = (value: string) => value.replaceAll('\\', '/').replace(/^\.\//, '').replace(/^\//, '');
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

function collectMedia(value: unknown, ownerType: 'post' | 'message', ownerId: string, sourcePath: string, sourceIndex: number) {
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
      if (typeof candidate === 'string' && isSuspiciousPath(candidate)) unsafe.add(candidate);
    }
    Object.values(object).forEach(child => walk(child, depth + 1));
  };
  walk(value, 0);
  return [...unsafe];
}

function profileRoot(raw: unknown) {
  const root = asRecord(raw);
  const candidates = [root.profile_information, root.profile_v2, root.profile, root];
  for (const candidate of candidates) {
    const value = asRecord(candidate);
    if (Object.keys(value).length) return { root, value };
  }
  return { root, value: {} };
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
    coverPhotoPath: cover && !isSuspiciousPath(cover) && !/^https?:\/\//i.test(cover) ? normalizedPath(cover) : undefined,
    source: { platform: 'facebook', path },
  };
}

export function parseFacebookPostsWithMedia(raw: unknown, path: string): { posts: Post[]; media: Media[] } {
  const root = asRecord(raw);
  const list = Array.isArray(raw) ? raw : Array.isArray(root.posts) ? root.posts : Array.isArray(root.data) ? root.data : [];
  const posts: Post[] = [];
  const media: Media[] = [];
  list.forEach((item, index) => {
    const post = asRecord(item);
    const data = Array.isArray(post.data) ? post.data.map(asRecord) : [];
    const body = text(post.post, post.text, post.content, post.message, ...data.map(entry => entry.post ?? entry.text ?? entry.content));
    const attachments = collectMedia(post, 'post', `post:${idPart(path)}:${index}`, path, index);
    if (!body && !text(post.title, post.name) && !attachments.length) return;
    const normalized = {
      id: `post:${idPart(path)}:${index}`,
      authorId: 'owner',
      text: body,
      title: text(post.title, post.name),
      createdAt: date(post.timestamp ?? post.timestamp_ms ?? post.creation_timestamp ?? post.created_timestamp ?? post.created_time),
      source: { platform: 'facebook', path, index },
    } satisfies Post;
    posts.push(normalized);
    media.push(...attachments);
  });
  return { posts, media };
}
export function parseFacebookPosts(raw: unknown, path: string): Post[] { return parseFacebookPostsWithMedia(raw, path).posts; }

const participantIdentity = (conversationId: string, name: string, facebookId?: string) => `person:messenger:${idPart(conversationId)}:${idPart(facebookId ?? name)}`;

export function parseFacebookConversationWithMedia(raw: unknown, path: string): { conversation?: Conversation; messages: Message[]; media: Media[]; people: Person[] } {
  const root = asRecord(raw);
  const rawMessages = Array.isArray(root.messages) ? root.messages : Array.isArray(root.message) ? root.message : [];
  const participantObjects = Array.isArray(root.participants) ? root.participants.map(asRecord) : [];
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
    const senderName = text(message.sender_name, message.sender, message.from, asRecord(message.sender_info).name);
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
  return { conversation, messages, media, people };
}
export function parseFacebookConversation(raw: unknown, path: string): { conversation?: Conversation; messages: Message[] } { const parsed = parseFacebookConversationWithMedia(raw, path); return { conversation: parsed.conversation, messages: parsed.messages }; }

export function personFromProfile(profile: Profile): Person {
  return { id: profile.personId, displayName: profile.displayName, facebookId: profile.facebookId, username: profile.username, profileUrl: profile.profileUrl, profilePhotoPath: profile.profilePhotoPath, coverPhotoPath: profile.coverPhotoPath, relationship: profile.relationship, identityConfidence: 'exact', identitySource: profile.source.path, sourcePaths: [profile.source.path], isArchiveOwner: true };
}

export function emptyNormalizedData(): NormalizedArchiveData { return { people: [], posts: [], conversations: [], messages: [], media: [], warnings: [] }; }
