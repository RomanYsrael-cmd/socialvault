import {facebookDetector} from './facebook'; import {validateEntries} from '../security'; import type {ArchiveEntryInfo,DetectionResult} from './types';
export function detectArchive(entries:ArchiveEntryInfo[]):DetectionResult{const securityWarnings=validateEntries(entries);const result=facebookDetector.detect(entries);return {...result,warnings:[...securityWarnings,...result.warnings]}}
/** Aggregate structure evidence across ZIP parts without requiring each part to be complete. */
export function detectArchiveSet(parts: ArchiveEntryInfo[][]): DetectionResult {
  const results = parts.map(entries => detectArchive(entries));
  const sections = [...new Set(results.flatMap(result => result.sections))];
  const supportedSections = [...new Set(results.flatMap(result => result.supportedSections ?? []))];
  const unsupportedSections = [...new Set(results.flatMap(result => result.unsupportedSections ?? []))];
  const supported = results.some(result => result.supported || result.sections.length > 0);
  return { supported, platform: supported ? 'facebook' : 'unknown', confidence: supported ? Math.min(.99, .58 + sections.length * .05) : .03, entryCount: results.reduce((sum, result) => sum + result.entryCount, 0), inspectedEntries: results.reduce((sum, result) => sum + result.inspectedEntries, 0), sections, supportedSections, unsupportedSections, warnings: results.flatMap(result => result.warnings) };
}
