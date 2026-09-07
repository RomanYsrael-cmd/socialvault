import type { ArchivePart, ArchiveSet, NormalizedArchiveData, Person, SourceRef } from './schemas/models';

/** Small deterministic local hash; it is a signature, not a security primitive. */
export function hashText(value: string) {
  return hashTextParts([value]);
}
/** Hash sorted manifest components incrementally so no giant joined string is retained. */
export function hashTextParts(parts: Iterable<string>) {
  let result = 2166136261;
  let first = true;
  for (const part of parts) {
    if (!first) { result ^= 124; result = Math.imul(result, 16777619); }
    for (let index = 0; index < part.length; index++) { result ^= part.charCodeAt(index); result = Math.imul(result, 16777619); }
    first = false;
  }
  return (result >>> 0).toString(16).padStart(8, '0');
}

export interface ManifestEntry { filename: string; directory?: boolean; uncompressedSize?: number; compressedSize?: number }
export function cleanArchivePath(path: string) { return path.replaceAll('\\', '/').replace(/^\.\//, '').replace(/^\//, ''); }
export function manifestFingerprint(entries: ManifestEntry[]) {
  const manifest = entries.filter(entry => !entry.directory).map(entry => `${cleanArchivePath(entry.filename)}:${entry.uncompressedSize ?? 0}:${entry.compressedSize ?? 0}`).sort();
  return hashTextParts(manifest);
}
export function knownManifestEntries(entries: ManifestEntry[], limit = 80) {
  return entries.filter(entry => !entry.directory).map(entry => cleanArchivePath(entry.filename)).sort().slice(0, limit);
}
export function archiveSetFingerprint(parts: Pick<ArchivePart, 'manifestFingerprint'>[]) {
  return hashText([...new Set(parts.map(part => part.manifestFingerprint))].sort().join('|'));
}
export function archiveSetId(fingerprint: string) { return `archive-set:facebook:${fingerprint}`; }
export function archivePartId(manifest: string) { return `archive-part:${manifest}`; }
export function makeArchivePart(file: { name: string; size: number }, entries: ManifestEntry[], partIndex: number, archiveId?: string): ArchivePart {
  const manifest = manifestFingerprint(entries);
  return { id: archivePartId(manifest), archiveId: archiveId ?? archiveSetId(manifest), partIndex, filename: file.name, fileSize: file.size, entryCount: entries.length, manifestFingerprint: manifest, connected: true, status: 'ready' };
}
export function makeArchiveSet(parts: ArchivePart[], createdAt = Date.now()): ArchiveSet {
  const fingerprint = archiveSetFingerprint(parts);
  const id = archiveSetId(fingerprint);
  const formats = [...new Set(parts.map(part => part.sourceFormat).filter((format): format is Exclude<ArchivePart['sourceFormat'], undefined | 'unknown'> => !!format && format !== 'unknown'))];
  const sourceFormat = formats.length > 1 ? 'mixed' as const : formats[0];
  return { id, platform: 'facebook', createdAt, partCount: parts.length, totalSize: parts.reduce((total, part) => total + part.fileSize, 0), fingerprint, sourceFormat, status: 'complete' };
}

export interface PartMatchResult { matched: Array<{ expected: ArchivePart; candidate: ArchivePart }>; missing: ArchivePart[]; duplicates: ArchivePart[]; unexpected: ArchivePart[] }
/** Match by manifest identity; filenames are retained for human diagnostics, never trusted alone. */
export function matchArchiveParts(expected: ArchivePart[], candidates: ArchivePart[]): PartMatchResult {
  const matched: PartMatchResult['matched'] = [], missing: ArchivePart[] = [], duplicates: ArchivePart[] = [], unexpected: ArchivePart[] = [];
  const used = new Set<string>();
  for (const part of expected) {
    const sameFingerprint = candidates.filter(candidate => candidate.manifestFingerprint === part.manifestFingerprint && candidate.status !== 'missing' && candidate.status !== 'failed' && candidate.status !== 'skipped');
    const candidate = sameFingerprint.find(item => !used.has(item.id));
    if (!candidate) { missing.push({ ...part, connected: false, status: 'missing' }); continue; }
    used.add(candidate.id); matched.push({ expected: part, candidate: { ...candidate, id: part.id, archiveId: part.archiveId, partIndex: part.partIndex, connected: true, status: 'ready' } });
    sameFingerprint.filter(item => item !== candidate).forEach(item => duplicates.push({ ...item, status: 'duplicate', connected: false }));
  }
  candidates.filter(candidate => !used.has(candidate.id)).forEach(candidate => {
    if (!duplicates.some(item => item.id === candidate.id)) unexpected.push({ ...candidate, status: 'missing', connected: false });
  });
  return { matched, missing, duplicates, unexpected };
}

function mergePeople(existing: Person, incoming: Person): Person {
  const result = { ...existing };
  for (const key of ['facebookId', 'username', 'profileUrl', 'profilePhotoPath', 'coverPhotoPath', 'relationship', 'identitySource'] as const) if (!result[key] && incoming[key]) result[key] = incoming[key] as never;
  result.sourcePaths = [...new Set([...(existing.sourcePaths ?? []), ...(incoming.sourcePaths ?? [])])];
  result.sourcePartIds = [...new Set([...(existing.sourcePartIds ?? []), ...(incoming.sourcePartIds ?? [])])];
  result.firstSeen = [existing.firstSeen, incoming.firstSeen].filter(Boolean).sort()[0] ?? existing.firstSeen;
  result.lastSeen = [existing.lastSeen, incoming.lastSeen].filter(Boolean).sort().at(-1) ?? existing.lastSeen;
  if (incoming.isArchiveOwner) result.isArchiveOwner = true;
  if (result.identityConfidence !== 'exact' && incoming.identityConfidence === 'exact') result.identityConfidence = 'exact';
  return result;
}
const byId = <T extends { id: string }>(items: T[]) => { const map = new Map<string, T>(); for (const item of items) if (!map.has(item.id)) map.set(item.id, item); return [...map.values()]; };
const sourceWithPart = (source: SourceRef, partId: string): SourceRef => ({ ...source, archivePartId: source.archivePartId ?? partId });
/** Attach a ZIP part to every normalized source reference without exposing raw JSON to the UI. */
export function attributeArchivePart(data: NormalizedArchiveData, partId: string): NormalizedArchiveData {
  const map = <T extends { source: SourceRef }>(items: T[]) => items.map(item => ({ ...item, source: sourceWithPart(item.source, partId) }));
  return {
    ...data,
    profile: data.profile ? { ...data.profile, source: sourceWithPart(data.profile.source, partId), facts: data.profile.facts?.map(fact => ({ ...fact, source: sourceWithPart(fact.source, partId) })) } : undefined,
    people: data.people.map(person => ({ ...person, sourcePartIds: [...new Set([...(person.sourcePartIds ?? []), partId])] })),
    profileFacts: map(data.profileFacts), posts: map(data.posts).map(post => ({ ...post, media: post.media?.map(media => ({ ...media, source: sourceWithPart(media.source, partId) })), comments: post.comments?.map(comment => ({ ...comment, source: sourceWithPart(comment.source, partId) })), reactions: post.reactions?.map(reaction => ({ ...reaction, source: sourceWithPart(reaction.source, partId) })) })),
    comments: map(data.comments), reactions: map(data.reactions), connections: map(data.connections), albums: map(data.albums), conversations: map(data.conversations), messages: map(data.messages).map(message => ({ ...message, media: message.media?.map(media => ({ ...media, source: sourceWithPart(media.source, partId) })) })), media: map(data.media),
  };
}

/** Merge part results deterministically while preserving the first stable source record. */
export function mergeNormalizedData(parts: NormalizedArchiveData[]): NormalizedArchiveData {
  const result: NormalizedArchiveData = { people: [], profileFacts: [], posts: [], comments: [], reactions: [], connections: [], albums: [], conversations: [], messages: [], media: [], warnings: [] };
  const people = new Map<string, Person>();
  const warningGroups = new Map<string, { category: string; message: string; count: number; sourcePaths: Set<string> }>();
  const sectionCounts: Record<string, number> = {};
  const sectionDurations = new Map<string, number>();
  let totalDurationMs = 0;
  for (const data of parts) {
    const incomingFormat = data.sourceFormat && data.sourceFormat !== 'unknown' ? data.sourceFormat : undefined;
    if (incomingFormat) result.sourceFormat = !result.sourceFormat ? incomingFormat : result.sourceFormat === incomingFormat ? result.sourceFormat : 'mixed';
    if (data.archiveSet && !result.archiveSet) result.archiveSet = data.archiveSet;
    if (data.profile && !result.profile) result.profile = data.profile;
    else if (data.profile && result.profile) result.profile = { ...result.profile, ...Object.fromEntries(Object.entries(data.profile).filter(([key, value]) => value && key !== 'source' && !((result.profile as unknown as Record<string, unknown>)[key]))), source: result.profile.source } as typeof result.profile;
    data.people.forEach(person => people.set(person.id, people.has(person.id) ? mergePeople(people.get(person.id)!, person) : person));
    result.profileFacts.push(...data.profileFacts); result.posts.push(...data.posts); result.comments.push(...data.comments); result.reactions.push(...data.reactions); result.connections.push(...data.connections); result.albums.push(...data.albums); result.conversations.push(...data.conversations); result.messages.push(...data.messages); result.media.push(...data.media); result.warnings.push(...data.warnings);
    result.importedSections = [...new Set([...(result.importedSections ?? []), ...(data.importedSections ?? [])])];
    if (data.archiveParts) result.archiveParts = [...(result.archiveParts ?? []), ...data.archiveParts];
    if (data.diagnostics) {
      const current = result.diagnostics ?? { candidateFiles: 0, parsedFiles: 0, unsupportedCandidates: 0, malformedFiles: 0, missingMedia: 0, incompleteIdentities: 0 };
      const incomingFormat = data.diagnostics.sourceFormat && data.diagnostics.sourceFormat !== 'unknown' ? data.diagnostics.sourceFormat : undefined;
      const sourceFormat = incomingFormat ? !current.sourceFormat ? incomingFormat : current.sourceFormat === incomingFormat ? current.sourceFormat : 'mixed' : current.sourceFormat;
      result.diagnostics = { candidateFiles: current.candidateFiles + data.diagnostics.candidateFiles, parsedFiles: current.parsedFiles + data.diagnostics.parsedFiles, unsupportedCandidates: current.unsupportedCandidates + data.diagnostics.unsupportedCandidates, malformedFiles: current.malformedFiles + data.diagnostics.malformedFiles, missingMedia: current.missingMedia + data.diagnostics.missingMedia, incompleteIdentities: current.incompleteIdentities + data.diagnostics.incompleteIdentities, htmlCandidateFiles: (current.htmlCandidateFiles ?? 0) + (data.diagnostics.htmlCandidateFiles ?? 0), htmlParsedFiles: (current.htmlParsedFiles ?? 0) + (data.diagnostics.htmlParsedFiles ?? 0), htmlRecordCount: (current.htmlRecordCount ?? 0) + (data.diagnostics.htmlRecordCount ?? 0), sourceFormat, shapeSignatures: [...new Set([...(current.shapeSignatures ?? []), ...(data.diagnostics.shapeSignatures ?? [])])].slice(0, 100), detectedSections: [...new Set([...(current.detectedSections ?? []), ...(data.diagnostics.detectedSections ?? [])])], unsupportedSections: [...new Set([...(current.unsupportedSections ?? []), ...(data.diagnostics.unsupportedSections ?? [])])] };
    }
    for (const group of data.warningGroups ?? data.diagnostics?.warningGroups ?? []) {
      const existing = warningGroups.get(group.category) ?? { category: group.category, message: group.message, count: 0, sourcePaths: new Set<string>() };
      existing.count += group.count; group.sourcePaths.forEach(path => existing.sourcePaths.add(path)); warningGroups.set(group.category, existing);
    }
    totalDurationMs += data.performance?.totalDurationMs ?? data.diagnostics?.performance?.totalDurationMs ?? 0;
    for (const [section, count] of Object.entries(data.performance?.sectionCounts ?? {})) sectionCounts[section] = (sectionCounts[section] ?? 0) + count;
    for (const item of data.performance?.slowestSections ?? []) sectionDurations.set(item.section, (sectionDurations.get(item.section) ?? 0) + item.durationMs);
  }
  result.people = [...people.values()]; result.profileFacts = byId(result.profileFacts); result.posts = byId(result.posts); result.comments = byId(result.comments); result.reactions = byId(result.reactions); result.connections = byId(result.connections); result.albums = byId(result.albums);
  const conversations = new Map<string, typeof result.conversations[number]>();
  for (const conversation of result.conversations) { const existing = conversations.get(conversation.id); if (!existing) conversations.set(conversation.id, { ...conversation, participantIds: [...conversation.participantIds], participantNames: [...conversation.participantNames] }); else { existing.participantIds = [...new Set([...existing.participantIds, ...conversation.participantIds])]; existing.participantNames = [...new Set([...existing.participantNames, ...conversation.participantNames])]; if (!existing.title && conversation.title) existing.title = conversation.title; } }
  result.conversations = [...conversations.values()]; result.messages = byId(result.messages); result.media = byId(result.media); result.warnings = [...new Set(result.warnings)];
  result.archiveParts = byId(result.archiveParts ?? []);
  result.warningGroups = [...warningGroups.values()].map(group => ({ category: group.category, message: group.message, count: group.count, sourcePaths: [...group.sourcePaths].slice(0, 8) }));
  if (result.diagnostics) {
    const maxBatchRecords = Math.max(...parts.map(data => data.performance?.maxBatchRecords ?? data.diagnostics?.performance?.maxBatchRecords ?? 0), 0);
    const maxBatchBytes = Math.max(...parts.map(data => data.performance?.maxBatchBytes ?? data.diagnostics?.performance?.maxBatchBytes ?? 0), 0);
    result.diagnostics.warningGroups = result.warningGroups;
    result.diagnostics.performance = { totalDurationMs, sectionCounts, slowestSections: [...sectionDurations.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([section, durationMs]) => ({ section, durationMs })), maxBatchRecords: maxBatchRecords || undefined, maxBatchBytes: maxBatchBytes || undefined };
  }
  if (totalDurationMs || Object.keys(sectionCounts).length) result.performance = result.diagnostics?.performance;
  result.coverage = { detectedSections: [...new Set(parts.flatMap(data => data.coverage?.detectedSections ?? data.importedSections ?? []))], importedSections: [...new Set(parts.flatMap(data => data.coverage?.importedSections ?? data.importedSections ?? []))], partialSections: [...new Set(parts.flatMap(data => data.coverage?.partialSections ?? []))], unsupportedSections: [...new Set(parts.flatMap(data => data.coverage?.unsupportedSections ?? []))], malformedSections: [...new Set(parts.flatMap(data => data.coverage?.malformedSections ?? []))], skippedParts: [...new Set(parts.flatMap(data => data.coverage?.skippedParts ?? []))] };
  return result;
}
