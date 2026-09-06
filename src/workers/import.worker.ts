/// <reference lib="webworker" />
import { TextWriter, BlobReader, ZipReader } from '@zip.js/zip.js';
import { detectArchive } from '../archive/detectors';
import { emptyNormalizedData, findUnsafeMediaReferences, parseFacebookAlbumsWithMedia, parseFacebookComments, parseFacebookConnections, parseFacebookConversationWithMedia, parseFacebookPostsWithMedia, parseFacebookProfile, parseFacebookReactions, personFromProfile } from '../archive/adapters/facebook-parser';
import { isSuspiciousPath } from '../archive/security';
import type { Person } from '../archive/schemas/models';
import type { ImportProgress, ImportRequest } from './protocol';

const send = (message: ImportProgress) => postMessage(message);
const clean = (path: string) => path.replaceAll('\\', '/').replace(/^\.\//, '');
const present = (path: string, paths: Set<string>) => paths.has(path) || [...paths].some(candidate => candidate.endsWith(`/${path}`));
const candidateSection = (path: string): 'profile' | 'posts' | 'comments' | 'reactions' | 'messages' | 'connections' | 'albums' | undefined => {
  const value = clean(path).toLowerCase();
  if (value.includes('profile_information') || value.includes('profile_v2') || value.endsWith('/profile.json') || value === 'profile.json') return 'profile';
  if (value.includes('/posts/') || /(?:^|\/)your_posts(?:__|[_-])?[^/]*\.json$/i.test(value)) return 'posts';
  if (/messages\/(inbox|archived_threads|filtered_messages)\/.+\/message(?:[_-]\d+)?\.json$/i.test(value)) return 'messages';
  if (value.includes('comment')) return 'comments';
  if (value.includes('reaction') || value.includes('like')) return 'reactions';
  if (value.includes('friends') || value.includes('followers') || value.includes('following') || value.includes('friend_requests') || value.includes('connections')) return 'connections';
  if (value.includes('albums') || value.includes('album')) return 'albums';
  return undefined;
};
const hash = (value: string) => {
  let result = 2166136261;
  for (let index = 0; index < value.length; index++) { result ^= value.charCodeAt(index); result = Math.imul(result, 16777619); }
  return (result >>> 0).toString(16).padStart(8, '0');
};
const identityFor = (file: File, entries: { filename: string; directory?: boolean; uncompressedSize?: number; compressedSize?: number }[]) => {
  const manifest = entries.filter(entry => !entry.directory).map(entry => `${clean(entry.filename)}:${entry.uncompressedSize ?? 0}:${entry.compressedSize ?? 0}`).sort();
  return { filename: file.name, size: file.size, entryCount: entries.length, fingerprint: hash(manifest.join('|')), knownEntries: manifest.slice(0, 80).map(item => item.split(':')[0]) };
};

function addPerson(map: Map<string, Person>, person: Person, sourcePath?: string) {
  const existing = map.get(person.id);
  if (!existing) { map.set(person.id, { ...person, sourcePaths: [...new Set([...(person.sourcePaths ?? []), ...(sourcePath ? [sourcePath] : [])])] }); return; }
  existing.sourcePaths = [...new Set([...(existing.sourcePaths ?? []), ...(person.sourcePaths ?? []), ...(sourcePath ? [sourcePath] : [])])];
  existing.firstSeen = [existing.firstSeen, person.firstSeen].filter(Boolean).sort()[0] ?? existing.firstSeen;
  existing.lastSeen = [existing.lastSeen, person.lastSeen].filter(Boolean).sort().at(-1) ?? existing.lastSeen;
  for (const key of ['facebookId', 'username', 'profileUrl', 'profilePhotoPath', 'coverPhotoPath', 'relationship', 'identitySource'] as const) if (!existing[key] && person[key]) existing[key] = person[key] as never;
}

self.onmessage = async (event: MessageEvent<File | ImportRequest>) => {
  let reader: ZipReader<Blob> | undefined;
  try {
    const payload = event.data;
    const file = payload instanceof File ? payload : payload.file;
    const action = payload instanceof File ? 'inspect' : payload.action;
    send({ type: 'progress', stage: 'opening', message: 'Opening archive…' });
    reader = new ZipReader(new BlobReader(file));
    const entries = await reader.getEntries();
    const entryInfo = entries.map(entry => ({ filename: entry.filename, directory: entry.directory, uncompressedSize: entry.uncompressedSize, compressedSize: entry.compressedSize }));
    const detection = detectArchive(entryInfo);
    detection.identity = identityFor(file, entryInfo);
    send({ type: 'progress', stage: 'inspecting', message: `Inspecting ${entries.length.toLocaleString()} files…` });
    if (detection.supported) send({ type: 'progress', stage: 'detected', message: 'Facebook archive detected' });
    send({ type: 'progress', stage: 'identity', message: 'Created a local archive signature' });
    if (action === 'inspect' || action === 'verify') { send({ type: 'result', result: detection }); return; }
    if (!detection.supported) throw new Error('This is not a supported Facebook archive.');

    const candidates = entries.filter(entry => !entry.directory && entry.filename.toLowerCase().endsWith('.json') && (entry.uncompressedSize ?? 0) <= 20 * 1024 * 1024);
    const archivePaths = new Set(entries.filter(entry => !entry.directory).map(entry => clean(entry.filename)));
    const data = emptyNormalizedData();
    data.importedSections = detection.sections;
    data.archiveIdentity = detection.identity;
    data.diagnostics = { candidateFiles: candidates.length, parsedFiles: 0, unsupportedCandidates: 0, malformedFiles: 0, missingMedia: 0, incompleteIdentities: 0 };
    const people = new Map<string, Person>();
    for (let index = 0; index < candidates.length; index++) {
      const entry = candidates[index];
      const path = clean(entry.filename);
      const section = candidateSection(path);
      if (!section) { data.diagnostics.unsupportedCandidates++; continue; }
      send({ type: 'progress', stage: section, message: `Parsing ${section}…`, completed: index + 1, total: candidates.length });
      try {
        const fileEntry = entry as unknown as { getData: (writer: TextWriter) => Promise<string> };
        const raw = JSON.parse(await fileEntry.getData(new TextWriter()));
        data.diagnostics.parsedFiles++;
        findUnsafeMediaReferences(raw).forEach(unsafe => data.warnings.push(`${entry.filename}: suspicious media path skipped (${unsafe})`));
        if (section === 'profile') {
          const profile = parseFacebookProfile(raw, entry.filename);
          if (profile) { data.profile ??= profile; data.profileFacts.push(...(profile.facts ?? [])); addPerson(people, personFromProfile(profile), entry.filename); }
          else data.diagnostics.incompleteIdentities++;
        } else if (section === 'posts') {
          const parsed = parseFacebookPostsWithMedia(raw, entry.filename);
          data.posts.push(...parsed.posts); data.media.push(...parsed.media); data.comments.push(...parsed.comments); data.reactions.push(...parsed.reactions); parsed.people.forEach(person => addPerson(people, person, entry.filename));
        } else if (section === 'comments') {
          const parsed = parseFacebookComments(raw, entry.filename); data.comments.push(...parsed.comments); parsed.people.forEach(person => addPerson(people, person, entry.filename));
        } else if (section === 'reactions') {
          const parsed = parseFacebookReactions(raw, entry.filename); data.reactions.push(...parsed.reactions); parsed.people.forEach(person => addPerson(people, person, entry.filename));
        } else if (section === 'connections') {
          const parsed = parseFacebookConnections(raw, entry.filename);
          data.connections.push(...parsed.connections); parsed.people.forEach(person => addPerson(people, person, entry.filename));
        } else if (section === 'albums') {
          const parsed = parseFacebookAlbumsWithMedia(raw, entry.filename);
          data.albums.push(...parsed.albums); data.media.push(...parsed.media);
        } else {
          const parsed = parseFacebookConversationWithMedia(raw, entry.filename);
          if (parsed.conversation && !data.conversations.some(conversation => conversation.id === parsed.conversation!.id)) data.conversations.push(parsed.conversation);
          parsed.people.forEach(person => addPerson(people, person, entry.filename));
          data.messages.push(...parsed.messages); data.media.push(...parsed.media);
        }
      } catch (error) {
        data.diagnostics.malformedFiles++;
        data.warnings.push(`${entry.filename}: ${error instanceof Error ? error.message : 'Unsupported JSON'}`);
      }
    }
    for (const conversation of data.conversations) {
      conversation.participantNames.forEach((displayName, index) => addPerson(people, { id: conversation.participantIds[index] ?? `person:messenger:${conversation.id}:${index}`, displayName, identityConfidence: 'inferred', identitySource: conversation.source.path, sourcePaths: [conversation.source.path] }));
    }
    for (const message of data.messages) {
      if (message.senderId && message.senderName) addPerson(people, { id: message.senderId, displayName: message.senderName, firstSeen: message.sentAt, lastSeen: message.sentAt, identityConfidence: 'inferred', identitySource: message.source.path, sourcePaths: [message.source.path] });
    }
    for (const post of data.posts) {
      if (post.authorId) addPerson(people, { id: post.authorId, displayName: data.profile?.displayName ?? 'Archive owner', firstSeen: post.createdAt, lastSeen: post.createdAt, identityConfidence: post.authorId === 'owner' ? 'exact' : 'inferred', identitySource: post.source.path, sourcePaths: [post.source.path], isArchiveOwner: post.authorId === 'owner' });
    }
    for (const comment of data.comments) {
      if (comment.authorId && comment.authorName) addPerson(people, { id: comment.authorId, displayName: comment.authorName, firstSeen: comment.createdAt, lastSeen: comment.createdAt, identityConfidence: comment.authorId.startsWith('person:facebook:') ? 'exact' : 'inferred', identitySource: comment.source.path, sourcePaths: [comment.source.path] });
    }
    for (const reaction of data.reactions) {
      if (reaction.personId && reaction.personName) addPerson(people, { id: reaction.personId, displayName: reaction.personName, firstSeen: reaction.createdAt, lastSeen: reaction.createdAt, identityConfidence: reaction.personId.startsWith('person:facebook:') ? 'exact' : 'inferred', identitySource: reaction.source.path, sourcePaths: [reaction.source.path] });
    }
    const unique = <T extends { id: string }>(items: T[]) => [...new Map(items.map(item => [item.id, item])).values()];
    data.posts = unique(data.posts); data.comments = unique(data.comments); data.reactions = unique(data.reactions); data.connections = unique(data.connections); data.albums = unique(data.albums); data.messages = unique(data.messages); data.media = unique(data.media);
    data.people = [...people.values()];
    data.diagnostics.incompleteIdentities = data.people.filter(person => !person.facebookId && !person.username && !person.profileUrl).length;
    send({ type: 'progress', stage: 'media', message: 'Checking media references…', completed: data.media.length, total: data.media.length });
    for (const item of data.media) {
      if (isSuspiciousPath(item.path)) { data.warnings.push(`${item.source.path}: suspicious media path skipped (${item.path})`); continue; }
      if (!present(clean(item.path), archivePaths)) { data.diagnostics.missingMedia++; data.warnings.push(`${item.source.path}: media reference not found in archive (${item.path})`); }
    }
    send({ type: 'progress', stage: 'search', message: 'Preparing local search index…' });
    send({ type: 'progress', stage: 'complete', message: 'Local import complete', completed: candidates.length, total: candidates.length });
    send({ type: 'import-result', data });
  } catch (error) { send({ type: 'error', message: error instanceof Error ? error.message : 'The archive could not be processed.' }); }
  finally { await reader?.close().catch(() => {}); }
};
