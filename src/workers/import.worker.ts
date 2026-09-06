/// <reference lib="webworker" />
import { TextWriter, BlobReader, ZipReader } from '@zip.js/zip.js';
import { detectArchive } from '../archive/detectors';
import { compareFacebookChunkPaths, diagnosticWarningCategory, emptyNormalizedData, findUnsafeMediaReferences, parseFacebookAlbumsWithMedia, parseFacebookComments, parseFacebookConnections, parseFacebookConversationWithMedia, parseFacebookPostsWithMedia, parseFacebookProfile, parseFacebookReactions, personFromProfile, shapeSignature } from '../archive/adapters/facebook-parser';
import { FACEBOOK_PARSER_VERSION } from '../archive/adapters/version';
import { attributeArchivePart, archiveSetFingerprint, archiveSetId, cleanArchivePath, makeArchivePart, type ManifestEntry } from '../archive/archive-set';
import { isSuspiciousPath } from '../archive/security';
import type { DetectionResult } from '../archive/detectors/types';
import type { ArchivePart, ArchiveSet, NormalizedArchiveData, Person } from '../archive/schemas/models';
import type { ImportProgress, ImportRequest } from './protocol';

const send = (message: ImportProgress) => postMessage(message);
const present = (path: string, paths: Set<string>) => paths.has(path) || [...paths].some(candidate => candidate.endsWith(`/${path}`));
const candidateSection = (path: string): 'profile' | 'posts' | 'comments' | 'reactions' | 'messages' | 'connections' | 'albums' | undefined => {
  const value = cleanArchivePath(path).toLowerCase();
  if (value.includes('profile_information') || value.includes('profile_v2') || value.includes('personal_information') || value.includes('/profile/') || value.endsWith('/profile.json') || value === 'profile.json') return 'profile';
  if (value.includes('/posts/') || value.endsWith('/posts.json') || value === 'posts.json' || /(?:^|\/)your_posts(?:__|[_-])?[^/]*\.json$/i.test(value)) return 'posts';
  if (/messages\/(inbox|archived_threads|filtered_messages|message_requests|marketplace_messages|marketplace|thread_requests)\/.+\/message(?:[_-]\d+)?\.json$/i.test(value) || /(?:^|\/)message(?:[_-]\d+)?\.json$/i.test(value) && value.includes('messages/')) return 'messages';
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
type PartAckResult = 'ok' | 'failed' | 'cancelled';
const pendingPartAcks = new Map<string, (result: PartAckResult) => void>();
function checkCancelled() { if (cancelled) throw new Error('__SOCIALVAULT_CANCELLED__'); }
function waitForPartAck(ackId: string) {
  return new Promise<PartAckResult>(resolve => pendingPartAcks.set(ackId, resolve));
}
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
type ImportRunRequest = Exclude<ImportRequest, { action: 'part-ack' }>;
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
  const supportedSections = [...new Set(unique.flatMap(item => item.detection.supportedSections ?? []))];
  const unsupportedSections = [...new Set(unique.flatMap(item => item.detection.unsupportedSections ?? []))];
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
  return { supported: supportedEvidence, platform: supportedEvidence ? 'facebook' : 'unknown', confidence: supportedEvidence ? Math.min(.99, .58 + sections.length * .05) : .03, entryCount: totalEntries, inspectedEntries: totalEntries, sections, supportedSections, unsupportedSections, warnings, identity: first ? { filename: unique.length === 1 ? first.name : `${unique.length} Facebook ZIP parts`, size: totalSize, entryCount: totalEntries, fingerprint, knownEntries: unique.flatMap(item => item.entries.filter(entry => !entry.directory).map(entry => cleanArchivePath(entry.filename))).sort().slice(0, 80) } : undefined, parts, archiveSetFingerprint: fingerprint, totalSize, duplicateParts: duplicateNames, unsupportedParts, duplicatePaths };
}

async function parsePart(item: InspectedPart, partCount: number): Promise<NormalizedArchiveData> {
  checkCancelled();
  let reader: ZipReader<Blob> | undefined;
  const data = emptyNormalizedData();
  const startedAt = performance.now();
  const sectionDurations = new Map<string, number>();
  const sectionCounts = new Map<string, number>();
  const malformedSections = new Set<string>();
  try {
    reader = new ZipReader(new BlobReader(item.file));
    const entries = await reader.getEntries();
    const candidates = entries.filter(entry => !entry.directory && entry.filename.toLowerCase().endsWith('.json') && (entry.uncompressedSize ?? 0) <= 20 * 1024 * 1024).sort((a, b) => {
      const aMessage = /(?:^|\/)message(?:[_-]\d+)?\.json$/i.test(cleanArchivePath(a.filename));
      const bMessage = /(?:^|\/)message(?:[_-]\d+)?\.json$/i.test(cleanArchivePath(b.filename));
      return aMessage && bMessage ? compareFacebookChunkPaths(a.filename, b.filename) : cleanArchivePath(a.filename).localeCompare(cleanArchivePath(b.filename), undefined, { numeric: true, sensitivity: 'base' });
    });
    data.importedSections = item.detection.sections;
    data.archiveIdentity = identityFor(item.file, item.entries);
    data.archiveParts = [{ ...item.part, archiveId: item.part.archiveId }];
    data.diagnostics = { candidateFiles: candidates.length, parsedFiles: 0, unsupportedCandidates: 0, malformedFiles: 0, missingMedia: 0, incompleteIdentities: 0, shapeSignatures: [], detectedSections: item.detection.sections, unsupportedSections: item.detection.unsupportedSections ?? [] };
    const people = new Map<string, Person>();
    for (let index = 0; index < candidates.length; index++) {
      checkCancelled();
      const entry = candidates[index]; const path = cleanArchivePath(entry.filename); const section = candidateSection(path);
      if (!section) {
        data.diagnostics.unsupportedCandidates++;
        data.warnings.push(`${item.file.name} · ${entry.filename}: unsupported Facebook JSON shape (skipped).`);
        try {
          const fileEntry = entry as unknown as { getData: (writer: TextWriter) => Promise<string> };
          const raw = JSON.parse(await fileEntry.getData(new TextWriter()));
          data.diagnostics.shapeSignatures?.push(`${cleanArchivePath(entry.filename)} → ${shapeSignature(raw)}`);
        } catch { /* malformed unsupported files are covered by the candidate warning */ }
        continue;
      }
      send({ type: 'progress', stage: section, message: `${item.file.name}: parsing ${section}…`, completed: index + 1, total: candidates.length, partIndex: item.part.partIndex + 1, partCount, partId: item.part.id });
      const sectionStartedAt = performance.now();
      sectionCounts.set(section, (sectionCounts.get(section) ?? 0) + 1);
      try {
        const fileEntry = entry as unknown as { getData: (writer: TextWriter) => Promise<string> };
        const raw = JSON.parse(await fileEntry.getData(new TextWriter())); data.diagnostics.parsedFiles++;
        findUnsafeMediaReferences(raw).forEach(unsafe => data.warnings.push(`${item.file.name} · ${entry.filename}: suspicious media path skipped (${unsafe})`));
        let recognized = false;
        if (section === 'profile') { const profile = parseFacebookProfile(raw, entry.filename); if (profile) { recognized = true; data.profile ??= profile; data.profileFacts.push(...(profile.facts ?? [])); addPerson(people, personFromProfile(profile), entry.filename); } else data.diagnostics.incompleteIdentities++; }
        else if (section === 'posts') { const parsed = parseFacebookPostsWithMedia(raw, entry.filename); recognized = parsed.posts.length > 0; data.posts.push(...parsed.posts); data.media.push(...parsed.media); data.comments.push(...parsed.comments); data.reactions.push(...parsed.reactions); parsed.people.forEach(person => addPerson(people, person, entry.filename)); }
        else if (section === 'comments') { const parsed = parseFacebookComments(raw, entry.filename); recognized = parsed.comments.length > 0; data.comments.push(...parsed.comments); parsed.people.forEach(person => addPerson(people, person, entry.filename)); }
        else if (section === 'reactions') { const parsed = parseFacebookReactions(raw, entry.filename); recognized = parsed.reactions.length > 0; data.reactions.push(...parsed.reactions); parsed.people.forEach(person => addPerson(people, person, entry.filename)); }
        else if (section === 'connections') { const parsed = parseFacebookConnections(raw, entry.filename); recognized = parsed.connections.length > 0; data.connections.push(...parsed.connections); parsed.people.forEach(person => addPerson(people, person, entry.filename)); }
        else if (section === 'albums') { const parsed = parseFacebookAlbumsWithMedia(raw, entry.filename); recognized = parsed.albums.length > 0; data.albums.push(...parsed.albums); data.media.push(...parsed.media); }
        else { const parsed = parseFacebookConversationWithMedia(raw, entry.filename); recognized = !!parsed.conversation || parsed.messages.length > 0; if (parsed.conversation && !data.conversations.some(conversation => conversation.id === parsed.conversation!.id)) data.conversations.push(parsed.conversation); parsed.people.forEach(person => addPerson(people, person, entry.filename)); data.messages.push(...parsed.messages); data.media.push(...parsed.media); }
        if (!recognized) { data.diagnostics.unsupportedCandidates++; data.warnings.push(`${item.file.name} · ${entry.filename}: unsupported ${section} JSON shape (skipped).`); data.diagnostics.shapeSignatures?.push(`${path} → ${shapeSignature(raw)}`); }
      } catch (error) { malformedSections.add(section); data.diagnostics.malformedFiles++; data.warnings.push(`${item.file.name} · ${entry.filename}: ${error instanceof Error ? error.message : 'Unsupported JSON'}`); }
      sectionDurations.set(section, (sectionDurations.get(section) ?? 0) + performance.now() - sectionStartedAt);
    }
    for (const conversation of data.conversations) conversation.participantNames.forEach((displayName, index) => addPerson(people, { id: conversation.participantIds[index] ?? `person:messenger:${conversation.id}:${index}`, displayName, identityConfidence: 'inferred', identitySource: conversation.source.path, sourcePaths: [conversation.source.path] }, conversation.source.path));
    for (const message of data.messages) if (message.senderId && message.senderName) addPerson(people, { id: message.senderId, displayName: message.senderName, firstSeen: message.sentAt, lastSeen: message.sentAt, identityConfidence: 'inferred', identitySource: message.source.path, sourcePaths: [message.source.path] }, message.source.path);
    for (const post of data.posts) if (post.authorId) addPerson(people, { id: post.authorId, displayName: data.profile?.displayName ?? 'Archive owner', firstSeen: post.createdAt, lastSeen: post.createdAt, identityConfidence: post.authorId === 'owner' ? 'exact' : 'inferred', identitySource: post.source.path, sourcePaths: [post.source.path], isArchiveOwner: post.authorId === 'owner' }, post.source.path);
    for (const comment of data.comments) if (comment.authorId && comment.authorName) addPerson(people, { id: comment.authorId, displayName: comment.authorName, firstSeen: comment.createdAt, lastSeen: comment.createdAt, identityConfidence: comment.authorId.startsWith('person:facebook:') ? 'exact' : 'inferred', identitySource: comment.source.path, sourcePaths: [comment.source.path] }, comment.source.path);
    for (const reaction of data.reactions) if (reaction.personId && reaction.personName) addPerson(people, { id: reaction.personId, displayName: reaction.personName, firstSeen: reaction.createdAt, lastSeen: reaction.createdAt, identityConfidence: reaction.personId.startsWith('person:facebook:') ? 'exact' : 'inferred', identitySource: reaction.source.path, sourcePaths: [reaction.source.path] }, reaction.source.path);
    data.people = [...people.values()]; data.diagnostics.incompleteIdentities = data.people.filter(person => !person.facebookId && !person.username && !person.profileUrl).length;
    const warningCounts = new Map<string, { message: string; count: number; sourcePaths: Set<string> }>();
    for (const warning of data.warnings) {
      const category = diagnosticWarningCategory(warning);
      const existing = warningCounts.get(category) ?? { message: warning.replace(/^.*?·\s*/, '').slice(0, 180), count: 0, sourcePaths: new Set<string>() };
      existing.count += 1;
      const source = warning.match(/·\s([^:]+):/)?.[1]; if (source) existing.sourcePaths.add(cleanArchivePath(source));
      warningCounts.set(category, existing);
    }
    data.warningGroups = [...warningCounts.entries()].map(([category, value]) => ({ category, message: value.message, count: value.count, sourcePaths: [...value.sourcePaths].slice(0, 8) }));
    // Keep the progress message bounded even when a large export repeats the
    // same malformed shape thousands of times. Full occurrence counts remain
    // available in warningGroups/diagnostics.
    data.warnings = [...new Set(data.warnings)].slice(0, 200);
    data.diagnostics.warningGroups = data.warningGroups;
    data.performance = { totalDurationMs: Math.round(performance.now() - startedAt), sectionCounts: Object.fromEntries(sectionCounts), slowestSections: [...sectionDurations.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([section, durationMs]) => ({ section, durationMs: Math.round(durationMs) })) };
    data.diagnostics.performance = data.performance;
    const unsupported = item.detection.unsupportedSections ?? [], imported = item.detection.sections.filter(section => !unsupported.includes(section));
    data.coverage = { detectedSections: item.detection.sections, importedSections: imported, partialSections: data.warnings.length ? imported : [], unsupportedSections: unsupported, malformedSections: [...malformedSections], skippedParts: [], sectionStatuses: item.detection.sections.map(section => ({ section, status: unsupported.includes(section) ? 'unsupported' as const : malformedSections.has(section) ? 'malformed' as const : data.warnings.length ? 'partial' as const : 'imported' as const, parserVersion: FACEBOOK_PARSER_VERSION })) };
    return attributeArchivePart(data, item.part.id);
  } finally { await reader?.close().catch(() => {}); }
}

async function run(payload: ImportRunRequest) {
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
  let detection = aggregateDetection(inspected, duplicateNames);
  if (payload.expectedParts?.length) {
    const expectedParts = payload.expectedParts;
    const candidatesByFingerprint = new Map(inspected.map(item => [item.part.manifestFingerprint, item]));
    const fingerprint = archiveSetFingerprint(expectedParts);
    const expectedWithCandidates = expectedParts.map(expected => {
      const candidate = candidatesByFingerprint.get(expected.manifestFingerprint)?.part;
      if (candidate?.status === 'failed') return { ...expected, connected: false, status: 'failed' as const };
      return candidate ? { ...expected, ...candidate, id: expected.id, archiveId: expected.archiveId, partIndex: expected.partIndex, connected: true, status: 'ready' as const } : { ...expected, connected: false, status: expected.status === 'skipped' ? 'skipped' as const : expected.status === 'failed' ? 'failed' as const : 'missing' as const };
    });
    detection = { ...detection, sections: [...new Set([...detection.sections, ...expectedParts.flatMap(part => part.sections ?? [])])], supportedSections: detection.supportedSections, unsupportedSections: detection.unsupportedSections, parts: expectedWithCandidates, archiveSetFingerprint: fingerprint, totalSize: expectedParts.reduce((sum, part) => sum + part.fileSize, 0), entryCount: expectedParts.reduce((sum, part) => sum + part.entryCount, 0), inspectedEntries: expectedParts.reduce((sum, part) => sum + part.entryCount, 0), identity: detection.identity ?? { filename: `${expectedParts.length} Facebook ZIP parts`, size: expectedParts.reduce((sum, part) => sum + part.fileSize, 0), entryCount: expectedParts.reduce((sum, part) => sum + part.entryCount, 0), fingerprint, knownEntries: expectedParts.flatMap(part => part.sections ?? []).slice(0, 80) } };
  }
  send({ type: 'progress', stage: 'detected', message: detection.supported ? `Facebook archive detected across ${inspected.length} ZIP part${inspected.length === 1 ? '' : 's'}.` : 'No supported Facebook archive was detected.', completed: inspected.length, total: files.length });
  send({ type: 'progress', stage: 'identity', message: 'Created a local archive-set signature', completed: inspected.length, total: files.length });
  if (payload.action === 'inspect' || payload.action === 'verify') { send({ type: 'result', result: detection }); return; }
  if (!detection.supported) throw new Error('These ZIP files do not look like a supported Facebook Download Your Information archive.');
  const completed = new Set(payload.completedPartIds ?? []), skipped = new Set(payload.skippedPartIds ?? []);
  const parseable = inspected.filter(item => item.part.status !== 'failed' && !completed.has(item.part.id) && !skipped.has(item.part.id));
  const parts = detection.parts ?? [], partByFingerprint = new Map(parts.map(part => [part.manifestFingerprint, part]));
  // Keep only import metadata in this worker after a part is handed to the
  // database worker. Normalized records can be very large; retaining every
  // part result here would defeat resumability and create an unbounded queue.
  const data = emptyNormalizedData();
  const parsedPartIds = new Set<string>();
  const pathOwners = new Map<string, Set<string>>();
  for (const item of [...inspected].sort((a, b) => a.part.manifestFingerprint.localeCompare(b.part.manifestFingerprint))) for (const entry of item.entries) if (!entry.directory) {
    const path = cleanArchivePath(entry.filename); const segments = path.split('/');
    for (let offset = 0; offset < segments.length; offset++) { const suffixSegments = segments.slice(offset); if (offset > 0 && suffixSegments.length < 2) continue; const suffix = suffixSegments.join('/'); if (!suffix) continue; const owners = pathOwners.get(suffix) ?? new Set<string>(); owners.add(item.part.id); pathOwners.set(suffix, owners); }
  }
  const mergePartMetadata = (partData: NormalizedArchiveData) => {
    data.warnings = [...new Set([...data.warnings, ...partData.warnings])].slice(0, 200);
    data.importedSections = [...new Set([...(data.importedSections ?? []), ...(partData.importedSections ?? [])])];
    data.archiveParts = [...(data.archiveParts ?? []), ...(partData.archiveParts ?? [])];
    if (partData.archiveIdentity && !data.archiveIdentity) data.archiveIdentity = partData.archiveIdentity;
    const left = data.diagnostics ?? { candidateFiles: 0, parsedFiles: 0, unsupportedCandidates: 0, malformedFiles: 0, missingMedia: 0, incompleteIdentities: 0 };
    const right = partData.diagnostics ?? { candidateFiles: 0, parsedFiles: 0, unsupportedCandidates: 0, malformedFiles: 0, missingMedia: 0, incompleteIdentities: 0 };
    data.diagnostics = { candidateFiles: left.candidateFiles + right.candidateFiles, parsedFiles: left.parsedFiles + right.parsedFiles, unsupportedCandidates: left.unsupportedCandidates + right.unsupportedCandidates, malformedFiles: left.malformedFiles + right.malformedFiles, missingMedia: left.missingMedia + right.missingMedia, incompleteIdentities: left.incompleteIdentities + right.incompleteIdentities, shapeSignatures: [...new Set([...(left.shapeSignatures ?? []), ...(right.shapeSignatures ?? [])])].slice(0, 100), detectedSections: [...new Set([...(left.detectedSections ?? []), ...(right.detectedSections ?? [])])], unsupportedSections: [...new Set([...(left.unsupportedSections ?? []), ...(right.unsupportedSections ?? [])])] };
    const groups = new Map((data.warningGroups ?? []).map(group => [group.category, { ...group, sourcePaths: [...group.sourcePaths] }]));
    for (const group of partData.warningGroups ?? partData.diagnostics?.warningGroups ?? []) { const prior = groups.get(group.category); if (!prior) groups.set(group.category, { ...group, sourcePaths: [...group.sourcePaths] }); else { prior.count += group.count; prior.sourcePaths = [...new Set([...prior.sourcePaths, ...group.sourcePaths])].slice(0, 8); } }
    data.warningGroups = [...groups.values()]; data.diagnostics.warningGroups = data.warningGroups;
    const leftMetrics = data.performance ?? {}; const rightMetrics = partData.performance ?? partData.diagnostics?.performance ?? {};
    const sectionCounts = { ...(leftMetrics.sectionCounts ?? {}) }; for (const [section, count] of Object.entries(rightMetrics.sectionCounts ?? {})) sectionCounts[section] = (sectionCounts[section] ?? 0) + count;
    const slowest = [...(leftMetrics.slowestSections ?? []), ...(rightMetrics.slowestSections ?? [])].sort((a, b) => b.durationMs - a.durationMs).slice(0, 5);
    data.performance = { totalDurationMs: (leftMetrics.totalDurationMs ?? 0) + (rightMetrics.totalDurationMs ?? 0), sectionCounts, slowestSections: slowest }; data.diagnostics.performance = data.performance;
    const leftCoverage = data.coverage, rightCoverage = partData.coverage;
    if (leftCoverage || rightCoverage) data.coverage = { detectedSections: [...new Set([...(leftCoverage?.detectedSections ?? []), ...(rightCoverage?.detectedSections ?? [])])], importedSections: [...new Set([...(leftCoverage?.importedSections ?? []), ...(rightCoverage?.importedSections ?? [])])], partialSections: [...new Set([...(leftCoverage?.partialSections ?? []), ...(rightCoverage?.partialSections ?? [])])], unsupportedSections: [...new Set([...(leftCoverage?.unsupportedSections ?? []), ...(rightCoverage?.unsupportedSections ?? [])])], malformedSections: [...new Set([...(leftCoverage?.malformedSections ?? []), ...(rightCoverage?.malformedSections ?? [])])], skippedParts: [...new Set([...(leftCoverage?.skippedParts ?? []), ...(rightCoverage?.skippedParts ?? [])])] };
  };
  for (const item of parseable) {
    checkCancelled(); const archivePart = partByFingerprint.get(item.part.manifestFingerprint) ?? item.part; const parsedPart = { ...item, part: { ...item.part, ...archivePart, archiveId: archiveSetId(detection.archiveSetFingerprint ?? '') } }; const partData = await parsePart(parsedPart, parts.length);
    for (const media of partData.media) {
      if (isSuspiciousPath(media.path)) continue;
      const owners = pathOwners.get(cleanArchivePath(media.path)); const ownerPartId = owners?.size === 1 ? [...owners][0] : undefined;
      if (ownerPartId) media.source = { ...media.source, archivePartId: ownerPartId };
      else { if (partData.diagnostics) partData.diagnostics.missingMedia += 1; const warning = `${media.source.path}: media reference not found in selected archive parts (${media.path})`; partData.warnings.push(warning); const category = diagnosticWarningCategory(warning); const group = partData.warningGroups?.find(item => item.category === category); if (group) group.count += 1; else partData.warningGroups = [...(partData.warningGroups ?? []), { category, message: 'media reference not found in selected archive parts', count: 1, sourcePaths: [cleanArchivePath(media.source.path)].slice(0, 8) }]; }
    }
    partData.warnings = [...new Set(partData.warnings)].slice(0, 200);
    if (partData.diagnostics) partData.diagnostics.warningGroups = partData.warningGroups;
    parsedPartIds.add(parsedPart.part.id); mergePartMetadata(partData);
    const ackId = `${payload.sessionId ?? 'import'}:${parsedPart.part.id}`;
    send({ type: 'part-result', data: partData, part: parsedPart.part, sessionId: payload.sessionId, ackId });
    const acknowledgement = await waitForPartAck(ackId);
    if (acknowledgement === 'cancelled' || cancelled) checkCancelled();
    if (acknowledgement === 'failed') throw new Error('The local database could not persist an imported ZIP part.');
  }
  const archiveSet: ArchiveSet = { id: archiveSetId(detection.archiveSetFingerprint ?? ''), platform: 'facebook', createdAt: Date.now(), partCount: parts.length, totalSize: detection.totalSize ?? 0, fingerprint: detection.archiveSetFingerprint ?? '', status: 'complete' };
  const failedParts = parts.filter(part => part.status === 'failed' || part.status === 'missing');
  if (failedParts.length || skipped.size) archiveSet.status = 'incomplete';
  data.archiveSet = archiveSet; data.archiveParts = parts.map(part => ({ ...part, archiveId: archiveSet.id, connected: part.status !== 'failed' && part.status !== 'missing' && !skipped.has(part.id), status: part.status === 'failed' ? 'failed' as const : skipped.has(part.id) ? 'skipped' as const : part.status === 'missing' ? 'missing' as const : completed.has(part.id) || parsedPartIds.has(part.id) ? 'complete' as const : 'ready' as const })); data.archiveIdentity = detection.identity ?? data.archiveIdentity; data.importedSections = detection.sections.filter(section => !(detection.unsupportedSections ?? []).includes(section)); data.warnings = [...new Set([...detection.warnings, ...data.warnings])].slice(0, 200);
  const finalWarningGroups = new Map<string, { message: string; count: number; sourcePaths: Set<string> }>();
  for (const group of data.warningGroups ?? []) finalWarningGroups.set(group.category, { message: group.message, count: group.count, sourcePaths: new Set(group.sourcePaths) });
  for (const warning of detection.warnings) { const category = diagnosticWarningCategory(warning); const group = finalWarningGroups.get(category) ?? { message: warning.replace(/^.*?·\s*/, '').slice(0, 180), count: 0, sourcePaths: new Set<string>() }; group.count += 1; const source = warning.match(/·\s([^:]+):/)?.[1]; if (source) group.sourcePaths.add(cleanArchivePath(source)); finalWarningGroups.set(category, group); }
  data.warningGroups = [...finalWarningGroups.entries()].map(([category, group]) => ({ category, message: group.message, count: group.count, sourcePaths: [...group.sourcePaths].slice(0, 8) })); if (data.diagnostics) data.diagnostics.warningGroups = data.warningGroups;
  if (data.diagnostics) { data.diagnostics.detectedSections = detection.sections; data.diagnostics.unsupportedSections = detection.unsupportedSections ?? []; }
  const unsupportedSections = detection.unsupportedSections ?? [];
  const malformedSections = [...new Set([...(data.coverage?.malformedSections ?? []), ...(failedParts.length ? detection.sections : [])])];
  const partialSections = [...new Set([...(data.coverage?.partialSections ?? []), ...(data.warnings.length ? data.importedSections : [])])];
  data.coverage = { detectedSections: detection.sections, importedSections: data.importedSections, partialSections, unsupportedSections, malformedSections, skippedParts: [...skipped], sectionStatuses: detection.sections.map(section => ({ section, status: unsupportedSections.includes(section) ? 'unsupported' as const : malformedSections.includes(section) ? 'malformed' as const : partialSections.includes(section) ? 'partial' as const : 'imported' as const, parserVersion: FACEBOOK_PARSER_VERSION })) };
  checkCancelled();
  send({ type: 'progress', stage: 'media', message: 'Checking media references across archive parts…', completed: data.media.length, total: data.media.length, partCount: inspected.length }); send({ type: 'progress', stage: 'search', message: 'Preparing local search index…', partCount: inspected.length }); send({ type: 'progress', stage: 'complete', message: archiveSet.status === 'complete' ? 'Local import complete' : 'Local import paused with incomplete parts', completed: data.archiveParts?.filter(part => part.status === 'complete').length ?? 0, total: data.archiveParts?.length ?? 0, partCount: inspected.length }); send({ type: 'import-result', data, sessionId: payload.sessionId });
}

self.onmessage = (event: MessageEvent<File | ImportRequest>) => {
  const payload = event.data instanceof File ? { action: 'inspect' as const, file: event.data } : event.data;
  if (payload.action === 'part-ack') { const resolve = pendingPartAcks.get(payload.ackId); if (resolve) { pendingPartAcks.delete(payload.ackId); resolve(payload.ok === false ? 'failed' : 'ok'); } return; }
  if (payload.action === 'cancel') { cancelled = true; pendingPartAcks.forEach(resolve => resolve('cancelled')); pendingPartAcks.clear(); return; }
  cancelled = false; void run(payload).catch(error => { if (error instanceof Error && error.message === '__SOCIALVAULT_CANCELLED__') send({ type: 'cancelled', message: 'Import cancelled. Completed ZIP parts remain available to resume.', sessionId: payload.sessionId }); else send({ type: 'error', message: error instanceof Error ? error.message : 'The archive could not be processed.' }); });
};
