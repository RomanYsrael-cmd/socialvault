/// <reference lib="webworker" />
import { TextWriter, BlobReader, ZipReader } from '@zip.js/zip.js';
import { detectArchive } from '../archive/detectors';
import { emptyNormalizedData, findUnsafeMediaReferences, parseFacebookAlbumsWithMedia, parseFacebookComments, parseFacebookConnections, parseFacebookConversationWithMedia, parseFacebookPostsWithMedia, parseFacebookProfile, parseFacebookReactions, personFromProfile } from '../archive/adapters/facebook-parser';
import { attributeArchivePart, archiveSetFingerprint, archiveSetId, cleanArchivePath, makeArchivePart, mergeNormalizedData, type ManifestEntry } from '../archive/archive-set';
import { isSuspiciousPath } from '../archive/security';
import type { DetectionResult } from '../archive/detectors/types';
import type { ArchivePart, ArchiveSet, NormalizedArchiveData, Person } from '../archive/schemas/models';
import type { ImportProgress, ImportRequest } from './protocol';

const send = (message: ImportProgress) => postMessage(message);
const present = (path: string, paths: Set<string>) => paths.has(path) || [...paths].some(candidate => candidate.endsWith(`/${path}`));
const candidateSection = (path: string): 'profile' | 'posts' | 'comments' | 'reactions' | 'messages' | 'connections' | 'albums' | undefined => {
  const value = cleanArchivePath(path).toLowerCase();
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
const identityFor = (file: File, entries: ManifestEntry[]) => ({ filename: file.name, size: file.size, entryCount: entries.length, fingerprint: hash(entries.filter(entry => !entry.directory).map(entry => `${cleanArchivePath(entry.filename)}:${entry.uncompressedSize ?? 0}:${entry.compressedSize ?? 0}`).sort().join('|')), knownEntries: entries.filter(entry => !entry.directory).map(entry => cleanArchivePath(entry.filename)).sort().slice(0, 80) });

let cancelled = false;
function checkCancelled() { if (cancelled) throw new Error('__SOCIALVAULT_CANCELLED__'); }
function addPerson(map: Map<string, Person>, person: Person, sourcePath?: string) {
  const existing = map.get(person.id);
  if (!existing) { map.set(person.id, { ...person, sourcePaths: [...new Set([...(person.sourcePaths ?? []), ...(sourcePath ? [sourcePath] : [])])] }); return; }
  existing.sourcePaths = [...new Set([...(existing.sourcePaths ?? []), ...(person.sourcePaths ?? []), ...(sourcePath ? [sourcePath] : [])])];
  existing.firstSeen = [existing.firstSeen, person.firstSeen].filter(Boolean).sort()[0] ?? existing.firstSeen;
  existing.lastSeen = [existing.lastSeen, person.lastSeen].filter(Boolean).sort().at(-1) ?? existing.lastSeen;
  for (const key of ['facebookId', 'username', 'profileUrl', 'profilePhotoPath', 'coverPhotoPath', 'relationship', 'identitySource'] as const) if (!existing[key] && person[key]) existing[key] = person[key] as never;
  if (person.identityConfidence === 'exact') existing.identityConfidence = 'exact';
}

type InspectedPart = { file: File; entries: ManifestEntry[]; detection: DetectionResult; part: ArchivePart };
async function inspectPart(file: File, partIndex: number, total: number): Promise<InspectedPart> {
  checkCancelled();
  send({ type: 'progress', stage: 'opening', message: `Opening ${file.name}…`, partIndex: partIndex + 1, partCount: total });
  let reader: ZipReader<Blob> | undefined;
  try {
    reader = new ZipReader(new BlobReader(file));
    const entries = (await reader.getEntries()).map(entry => ({ filename: entry.filename, directory: entry.directory, uncompressedSize: entry.uncompressedSize, compressedSize: entry.compressedSize }));
    const detection = detectArchive(entries);
    const part = makeArchivePart(file, entries, partIndex);
    send({ type: 'progress', stage: 'inspecting', message: `${file.name}: inspecting ${entries.length.toLocaleString()} entries…`, completed: partIndex + 1, total, partIndex: partIndex + 1, partCount: total, partId: part.id });
    return { file, entries, detection, part };
  } finally { await reader?.close().catch(() => {}); }
}

function aggregateDetection(inspected: InspectedPart[], duplicateNames: string[]): DetectionResult {
  const unique = [...new Map(inspected.map(item => [item.part.manifestFingerprint, item])).values()];
  const sections = [...new Set(unique.flatMap(item => item.detection.sections))];
  const supportedEvidence = unique.some(item => item.detection.supported || item.detection.sections.length > 0);
  const unsupportedParts = unique.filter(item => !item.detection.supported && item.detection.sections.length === 0).map(item => item.file.name);
  const totalEntries = unique.reduce((sum, item) => sum + item.entries.length, 0);
  const totalSize = unique.reduce((sum, item) => sum + item.file.size, 0);
  const fingerprint = archiveSetFingerprint(unique.map(item => item.part));
  const warnings = [...new Set(unique.flatMap(item => item.detection.warnings.map(warning => `${item.file.name}: ${warning}`)))];
  const pathOwners = new Map<string, string[]>(); unique.forEach(item => item.entries.filter(entry => !entry.directory).forEach(entry => { const path = cleanArchivePath(entry.filename); const owners = pathOwners.get(path) ?? []; if (!owners.includes(item.file.name)) owners.push(item.file.name); pathOwners.set(path, owners); }));
  const duplicatePaths = [...pathOwners.entries()].filter(([, owners]) => owners.length > 1).map(([path]) => path);
  duplicatePaths.slice(0, 20).forEach(path => warnings.push(`${(pathOwners.get(path) ?? []).join(', ')}: duplicate entry path appears in multiple ZIP parts (${path})`));
  duplicateNames.forEach(name => warnings.push(`${name}: duplicate ZIP part selected; it will be imported once.`));
  unsupportedParts.forEach(name => warnings.push(`${name}: no recognizable Facebook export sections; skipped.`));
  const parts = unique.map(item => ({ ...item.part, archiveId: archiveSetId(fingerprint), partIndex: unique.findIndex(other => other.part.manifestFingerprint === item.part.manifestFingerprint), sections: item.detection.sections }));
  const first = unique[0]?.file;
  return { supported: supportedEvidence, platform: supportedEvidence ? 'facebook' : 'unknown', confidence: supportedEvidence ? Math.min(.99, .58 + sections.length * .05) : .03, entryCount: totalEntries, inspectedEntries: totalEntries, sections, warnings, identity: first ? { filename: unique.length === 1 ? first.name : `${unique.length} Facebook ZIP parts`, size: totalSize, entryCount: totalEntries, fingerprint, knownEntries: unique.flatMap(item => item.entries.filter(entry => !entry.directory).map(entry => cleanArchivePath(entry.filename))).sort().slice(0, 80) } : undefined, parts, archiveSetFingerprint: fingerprint, totalSize, duplicateParts: duplicateNames, unsupportedParts, duplicatePaths };
}

async function parsePart(item: InspectedPart, partCount: number): Promise<NormalizedArchiveData> {
  checkCancelled();
  let reader: ZipReader<Blob> | undefined;
  const data = emptyNormalizedData();
  try {
    reader = new ZipReader(new BlobReader(item.file));
    const entries = await reader.getEntries();
    const candidates = entries.filter(entry => !entry.directory && entry.filename.toLowerCase().endsWith('.json') && (entry.uncompressedSize ?? 0) <= 20 * 1024 * 1024);
    data.importedSections = item.detection.sections;
    data.archiveIdentity = identityFor(item.file, item.entries);
    data.archiveParts = [{ ...item.part, archiveId: item.part.archiveId }];
    data.diagnostics = { candidateFiles: candidates.length, parsedFiles: 0, unsupportedCandidates: 0, malformedFiles: 0, missingMedia: 0, incompleteIdentities: 0 };
    const people = new Map<string, Person>();
    for (let index = 0; index < candidates.length; index++) {
      checkCancelled();
      const entry = candidates[index]; const path = cleanArchivePath(entry.filename); const section = candidateSection(path);
      if (!section) { data.diagnostics.unsupportedCandidates++; continue; }
      send({ type: 'progress', stage: section, message: `${item.file.name}: parsing ${section}…`, completed: index + 1, total: candidates.length, partIndex: item.part.partIndex + 1, partCount, partId: item.part.id });
      try {
        const fileEntry = entry as unknown as { getData: (writer: TextWriter) => Promise<string> };
        const raw = JSON.parse(await fileEntry.getData(new TextWriter())); data.diagnostics.parsedFiles++;
        findUnsafeMediaReferences(raw).forEach(unsafe => data.warnings.push(`${item.file.name} · ${entry.filename}: suspicious media path skipped (${unsafe})`));
        if (section === 'profile') { const profile = parseFacebookProfile(raw, entry.filename); if (profile) { data.profile ??= profile; data.profileFacts.push(...(profile.facts ?? [])); addPerson(people, personFromProfile(profile), entry.filename); } else data.diagnostics.incompleteIdentities++; }
        else if (section === 'posts') { const parsed = parseFacebookPostsWithMedia(raw, entry.filename); data.posts.push(...parsed.posts); data.media.push(...parsed.media); data.comments.push(...parsed.comments); data.reactions.push(...parsed.reactions); parsed.people.forEach(person => addPerson(people, person, entry.filename)); }
        else if (section === 'comments') { const parsed = parseFacebookComments(raw, entry.filename); data.comments.push(...parsed.comments); parsed.people.forEach(person => addPerson(people, person, entry.filename)); }
        else if (section === 'reactions') { const parsed = parseFacebookReactions(raw, entry.filename); data.reactions.push(...parsed.reactions); parsed.people.forEach(person => addPerson(people, person, entry.filename)); }
        else if (section === 'connections') { const parsed = parseFacebookConnections(raw, entry.filename); data.connections.push(...parsed.connections); parsed.people.forEach(person => addPerson(people, person, entry.filename)); }
        else if (section === 'albums') { const parsed = parseFacebookAlbumsWithMedia(raw, entry.filename); data.albums.push(...parsed.albums); data.media.push(...parsed.media); }
        else { const parsed = parseFacebookConversationWithMedia(raw, entry.filename); if (parsed.conversation && !data.conversations.some(conversation => conversation.id === parsed.conversation!.id)) data.conversations.push(parsed.conversation); parsed.people.forEach(person => addPerson(people, person, entry.filename)); data.messages.push(...parsed.messages); data.media.push(...parsed.media); }
      } catch (error) { data.diagnostics.malformedFiles++; data.warnings.push(`${item.file.name} · ${entry.filename}: ${error instanceof Error ? error.message : 'Unsupported JSON'}`); }
    }
    for (const conversation of data.conversations) conversation.participantNames.forEach((displayName, index) => addPerson(people, { id: conversation.participantIds[index] ?? `person:messenger:${conversation.id}:${index}`, displayName, identityConfidence: 'inferred', identitySource: conversation.source.path, sourcePaths: [conversation.source.path] }, conversation.source.path));
    for (const message of data.messages) if (message.senderId && message.senderName) addPerson(people, { id: message.senderId, displayName: message.senderName, firstSeen: message.sentAt, lastSeen: message.sentAt, identityConfidence: 'inferred', identitySource: message.source.path, sourcePaths: [message.source.path] }, message.source.path);
    for (const post of data.posts) if (post.authorId) addPerson(people, { id: post.authorId, displayName: data.profile?.displayName ?? 'Archive owner', firstSeen: post.createdAt, lastSeen: post.createdAt, identityConfidence: post.authorId === 'owner' ? 'exact' : 'inferred', identitySource: post.source.path, sourcePaths: [post.source.path], isArchiveOwner: post.authorId === 'owner' }, post.source.path);
    for (const comment of data.comments) if (comment.authorId && comment.authorName) addPerson(people, { id: comment.authorId, displayName: comment.authorName, firstSeen: comment.createdAt, lastSeen: comment.createdAt, identityConfidence: comment.authorId.startsWith('person:facebook:') ? 'exact' : 'inferred', identitySource: comment.source.path, sourcePaths: [comment.source.path] }, comment.source.path);
    for (const reaction of data.reactions) if (reaction.personId && reaction.personName) addPerson(people, { id: reaction.personId, displayName: reaction.personName, firstSeen: reaction.createdAt, lastSeen: reaction.createdAt, identityConfidence: reaction.personId.startsWith('person:facebook:') ? 'exact' : 'inferred', identitySource: reaction.source.path, sourcePaths: [reaction.source.path] }, reaction.source.path);
    data.people = [...people.values()]; data.diagnostics.incompleteIdentities = data.people.filter(person => !person.facebookId && !person.username && !person.profileUrl).length;
    return attributeArchivePart(data, item.part.id);
  } finally { await reader?.close().catch(() => {}); }
}

async function run(payload: ImportRequest) {
  const files = [...(payload.files ?? (payload.file ? [payload.file] : []))]; if (!files.length) throw new Error('Choose at least one ZIP file.');
  const inspected: InspectedPart[] = []; const duplicateNames: string[] = []; const fingerprints = new Set<string>();
  for (let index = 0; index < files.length; index++) {
    let item: InspectedPart;
    try { item = await inspectPart(files[index], index, files.length); }
    catch (error) {
      if (error instanceof Error && error.message.startsWith('Unsafe archive path')) throw error;
      const failedFingerprint = `failed:${hash(`${files[index].name}:${files[index].size}`)}`;
      item = { file: files[index], entries: [], detection: { supported: false, platform: 'unknown', confidence: 0, entryCount: 0, inspectedEntries: 0, sections: [], warnings: [`${files[index].name}: ZIP could not be inspected (${error instanceof Error ? error.message : 'malformed archive'}).`] }, part: { id: `archive-part:${failedFingerprint}`, archiveId: '', partIndex: index, filename: files[index].name, fileSize: files[index].size, entryCount: 0, manifestFingerprint: failedFingerprint, connected: false, status: 'failed' } };
    }
    if (fingerprints.has(item.part.manifestFingerprint)) { duplicateNames.push(files[index].name); continue; } fingerprints.add(item.part.manifestFingerprint); inspected.push(item);
  }
  const detection = aggregateDetection(inspected, duplicateNames);
  send({ type: 'progress', stage: 'detected', message: detection.supported ? `Facebook archive detected across ${inspected.length} ZIP part${inspected.length === 1 ? '' : 's'}.` : 'No supported Facebook archive was detected.', completed: inspected.length, total: files.length });
  send({ type: 'progress', stage: 'identity', message: 'Created a local archive-set signature', completed: inspected.length, total: files.length });
  if (payload.action === 'inspect' || payload.action === 'verify') { send({ type: 'result', result: detection }); return; }
  if (!detection.supported) throw new Error('These ZIP files do not look like a supported Facebook Download Your Information archive.');
  const results: NormalizedArchiveData[] = [];
  const parseable = inspected.filter(item => item.part.status !== 'failed');
  const parts = detection.parts ?? [], partByFingerprint = new Map(parts.map(part => [part.manifestFingerprint, part]));
  for (const item of parseable) { checkCancelled(); const archivePart = partByFingerprint.get(item.part.manifestFingerprint) ?? item.part; results.push(await parsePart({ ...item, part: { ...item.part, ...archivePart, archiveId: archiveSetId(detection.archiveSetFingerprint ?? '') } }, parts.length)); }
  const data = mergeNormalizedData(results); const archiveSet: ArchiveSet = { id: archiveSetId(detection.archiveSetFingerprint ?? ''), platform: 'facebook', createdAt: Date.now(), partCount: parts.length, totalSize: detection.totalSize ?? 0, fingerprint: detection.archiveSetFingerprint ?? '', status: 'complete' };
  const failedParts = parts.filter(part => part.status === 'failed');
  if (failedParts.length) archiveSet.status = 'incomplete';
  data.archiveSet = archiveSet; data.archiveParts = parts.map(part => ({ ...part, archiveId: archiveSet.id, connected: part.status !== 'failed', status: part.status === 'failed' ? 'failed' as const : 'ready' as const })); data.archiveIdentity = detection.identity; data.importedSections = detection.sections; data.warnings = [...new Set([...detection.warnings, ...data.warnings])];
  const pathOwners = new Map<string, string>();
  for (const item of [...inspected].sort((a, b) => a.part.manifestFingerprint.localeCompare(b.part.manifestFingerprint))) for (const entry of item.entries) if (!entry.directory) {
    const path = cleanArchivePath(entry.filename); const segments = path.split('/');
    for (let offset = 0; offset < segments.length; offset++) { const suffix = segments.slice(offset).join('/'); if (suffix && !pathOwners.has(suffix)) pathOwners.set(suffix, item.part.id); }
  }
  for (const media of data.media) {
    if (isSuspiciousPath(media.path)) continue;
    const path = cleanArchivePath(media.path); const ownerPartId = pathOwners.get(path);
    if (ownerPartId) media.source = { ...media.source, archivePartId: ownerPartId };
    else { if (data.diagnostics) data.diagnostics.missingMedia += 1; data.warnings.push(`${media.source.path}: media reference not found in selected archive parts (${media.path})`); }
  }
  send({ type: 'progress', stage: 'media', message: 'Checking media references across archive parts…', completed: data.media.length, total: data.media.length, partCount: inspected.length }); send({ type: 'progress', stage: 'search', message: 'Preparing local search index…', partCount: inspected.length }); send({ type: 'progress', stage: 'complete', message: 'Local import complete', completed: data.archiveParts?.length ?? 0, total: data.archiveParts?.length ?? 0, partCount: inspected.length }); send({ type: 'import-result', data });
}

self.onmessage = (event: MessageEvent<File | ImportRequest>) => {
  const payload = event.data instanceof File ? { action: 'inspect' as const, file: event.data } : event.data;
  if (payload.action === 'cancel') { cancelled = true; send({ type: 'cancelled', message: 'Import cancelled. No incomplete archive was saved.' }); return; }
  cancelled = false; void run(payload).catch(error => { if (error instanceof Error && error.message === '__SOCIALVAULT_CANCELLED__') send({ type: 'cancelled', message: 'Import cancelled. No incomplete archive was saved.' }); else send({ type: 'error', message: error instanceof Error ? error.message : 'The archive could not be processed.' }); });
};
