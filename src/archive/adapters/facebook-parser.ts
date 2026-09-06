import { z } from 'zod';
import { isSuspiciousPath } from '../security';
import type { Conversation, Media, Message, NormalizedArchiveData, Post, Profile } from '../schemas/models';

const record = z.record(z.unknown());
const asRecord = (value: unknown) => record.safeParse(value).success ? value as Record<string, unknown> : {};
const text = (...values: unknown[]) => values.find(value => typeof value === 'string' && value.trim()) as string | undefined;
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
  if (value.includes('audio') || /\.(mp3|m4a|wav|ogg)$/.test(value)) return 'audio';
  if (value.includes('image') || /\.(jpe?g|png|gif|webp|heic)$/.test(value)) return 'photo';
  if (value.includes('file') || /\.(pdf|docx?|xlsx?|txt|zip)$/.test(value)) return 'file';
  return 'unknown';
};

function collectMedia(value: unknown, ownerType: 'post' | 'message', ownerId: string, sourcePath: string, sourceIndex: number) {
  const found: Media[] = [];
  const seen = new Set<string>();
  const walk = (node: unknown, depth: number) => {
    if (depth > 5 || node === null || node === undefined) return;
    if (Array.isArray(node)) { node.forEach(item => walk(item, depth + 1)); return; }
    const object = asRecord(node);
    const reference = text(object.uri, object.path, object.filename, object.file_name, object.fileName);
    const hint = text(object.mime_type, object.mimeType, object.type, object.media_type);
    if (reference && !/^https?:\/\//i.test(reference) && !/^data:/i.test(reference) && !isSuspiciousPath(reference)) {
      const path = normalizedPath(reference);
      if (!isSuspiciousPath(path) && (/[-_./]/.test(path) || hint)) {
        const key = `${path}|${hint ?? ''}`;
        if (!seen.has(key)) {
          seen.add(key);
          const metadata = asRecord(object.media_metadata ?? object.metadata);
          found.push({
            id: `media:${ownerType}:${idPart(ownerId)}:${found.length}`,
            path,
            filename: path.split('/').pop(),
            mediaType: mediaType(path, hint),
            mimeType: hint?.includes('/') ? hint : undefined,
            caption: text(object.description, object.caption, object.title),
            timestamp: date(object.creation_timestamp ?? object.timestamp),
            ownerType,
            ownerId,
            width: typeof metadata.width === 'number' ? metadata.width : undefined,
            height: typeof metadata.height === 'number' ? metadata.height : undefined,
            durationMs: typeof metadata.duration_ms === 'number' ? metadata.duration_ms : undefined,
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
    if (depth > 6 || node === null || node === undefined) return;
    if (Array.isArray(node)) { node.forEach(item => walk(item, depth + 1)); return; }
    const object = asRecord(node);
    for (const key of ['uri', 'path', 'filename', 'file_name', 'fileName']) {
      const candidate = object[key];
      if (typeof candidate === 'string' && isSuspiciousPath(candidate)) unsafe.add(candidate);
    }
    Object.values(object).forEach(child => walk(child, depth + 1));
  };
  walk(value, 0);
  return [...unsafe];
}

export function parseFacebookProfile(raw: unknown, path: string): Profile | undefined {
  const root = asRecord(raw);
  const profile = asRecord(root.profile_information ?? root.profile_v2 ?? root.profile ?? root);
  const displayName = text(profile.name, root.name, asRecord(profile.profile).name);
  if (!displayName) return;
  return { id: 'owner', personId: 'owner', displayName, username: text(profile.username, root.username), bio: text(profile.bio, profile.about_me, profile.intro_bio), joinedAt: date(profile.registration_timestamp ?? profile.account_creation_time), source: { platform: 'facebook', path } };
}

export function parseFacebookPostsWithMedia(raw: unknown, path: string): { posts: Post[]; media: Media[] } {
  const root = asRecord(raw);
  const list = Array.isArray(raw) ? raw : Array.isArray(root.posts) ? root.posts : [];
  const posts: Post[] = [];
  const media: Media[] = [];
  list.forEach((item, index) => {
    const post = asRecord(item);
    const data = Array.isArray(post.data) ? post.data.map(asRecord) : [];
    const body = text(post.post, post.text, post.content, ...data.map(entry => entry.post));
    if (!body && !post.title) return;
    const normalized = { id: `post:${idPart(path)}:${index}`, authorId: 'owner', text: body, title: text(post.title), createdAt: date(post.timestamp ?? post.creation_timestamp ?? post.created_timestamp), source: { platform: 'facebook', path, index } } satisfies Post;
    posts.push(normalized);
    media.push(...collectMedia(post, 'post', normalized.id, path, index));
  });
  return { posts, media };
}
export function parseFacebookPosts(raw: unknown, path: string): Post[] { return parseFacebookPostsWithMedia(raw, path).posts; }

export function parseFacebookConversationWithMedia(raw: unknown, path: string): { conversation?: Conversation; messages: Message[]; media: Media[] } {
  const root = asRecord(raw);
  const rawMessages = Array.isArray(root.messages) ? root.messages : [];
  if (!rawMessages.length && !root.title) return { messages: [], media: [] };
  const folder = path.replaceAll('\\', '/').split('/').slice(-2, -1)[0] || idPart(path);
  const conversationId = `conversation:${idPart(String(root.thread_path ?? folder))}`;
  const participants = Array.isArray(root.participants) ? root.participants.map(item => text(asRecord(item).name)).filter((value): value is string => !!value) : [];
  const conversation = { id: conversationId, title: text(root.title) ?? (participants.join(', ') || 'Conversation'), participantIds: [], participantNames: participants, source: { platform: 'facebook', path } } satisfies Conversation;
  const messages: Message[] = [];
  const media: Media[] = [];
  rawMessages.forEach((item, index) => {
    const message = asRecord(item);
    const body = text(message.content, message.text);
    if (!body) return;
    const normalized = { id: `message:${idPart(path)}:${index}`, conversationId, senderName: text(message.sender_name, message.sender), text: body, sentAt: date(message.timestamp_ms ?? message.timestamp), source: { platform: 'facebook', path, index } } satisfies Message;
    messages.push(normalized);
    media.push(...collectMedia(message, 'message', normalized.id, path, index));
  });
  return { conversation, messages, media };
}
export function parseFacebookConversation(raw: unknown, path: string): { conversation?: Conversation; messages: Message[] } { const parsed = parseFacebookConversationWithMedia(raw, path); return { conversation: parsed.conversation, messages: parsed.messages }; }
export function emptyNormalizedData(): NormalizedArchiveData { return { posts: [], conversations: [], messages: [], media: [], warnings: [] }; }
