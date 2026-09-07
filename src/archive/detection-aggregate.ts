import type { DetectionResult } from './detectors/types';
import type { ArchivePart } from './schemas/models';
import { archiveSetFingerprint, archiveSetId } from './archive-set';

/** Merge one-at-a-time inspection results without retaining the source Files. */
export function mergeDetectionResults(results: readonly DetectionResult[], duplicateNames: readonly string[] = []): DetectionResult {
  const partsByFingerprint = new Map<string, ArchivePart>();
  for (const result of results) for (const part of result.parts ?? []) if (!partsByFingerprint.has(part.manifestFingerprint)) partsByFingerprint.set(part.manifestFingerprint, part);
  const rawParts = [...partsByFingerprint.values()];
  const fingerprint = archiveSetFingerprint(rawParts);
  const parts = rawParts.map((part, index) => ({ ...part, id: `archive-part:${part.manifestFingerprint}`, archiveId: archiveSetId(fingerprint), partIndex: index }));
  const formats = [...new Set(results.map(result => result.format ?? 'unknown'))];
  const format = formats.includes('mixed') || (formats.includes('json') && formats.includes('html')) ? 'mixed' : formats.includes('json') ? 'json' : formats.includes('html') ? 'html' : 'unknown';
  const sections = [...new Set(results.flatMap(result => result.sections))];
  const supportedSections = [...new Set(results.flatMap(result => result.supportedSections ?? []))];
  const unsupportedSections = [...new Set(results.flatMap(result => result.unsupportedSections ?? []))];
  const warnings = [...new Set([...results.flatMap(result => result.warnings), ...duplicateNames.map(name => `${name}: duplicate ZIP part selected; it will be imported once.`)])];
  const supported = results.some(result => result.supported);
  const totalSize = parts.reduce((sum, part) => sum + part.fileSize, 0);
  const entryCount = parts.reduce((sum, part) => sum + part.entryCount, 0);
  const identityResult = results.find(result => result.identity);
  const identity = identityResult?.identity ? { ...identityResult.identity, filename: parts.length === 1 ? parts[0].filename : `${parts.length} Facebook ZIP parts`, size: totalSize, entryCount, fingerprint, knownEntries: [...new Set(results.flatMap(result => result.identity?.knownEntries ?? []))].slice(0, 80) } : undefined;
  return {
    supported,
    platform: supported ? 'facebook' : 'unknown',
    confidence: supported ? Math.min(.99, .58 + sections.length * .05) : format === 'html' && sections.length ? .2 : .03,
    entryCount,
    inspectedEntries: entryCount,
    sections,
    supportedSections,
    unsupportedSections,
    warnings,
    identity,
    parts,
    archiveSetFingerprint: fingerprint,
    totalSize,
    duplicateParts: [...duplicateNames],
    unsupportedParts: results.flatMap(result => result.unsupportedParts ?? []),
    duplicatePaths: [...new Set(results.flatMap(result => result.duplicatePaths ?? []))],
    format,
  };
}
