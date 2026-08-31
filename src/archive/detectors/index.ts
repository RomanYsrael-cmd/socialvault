import {facebookDetector} from './facebook'; import {validateEntries} from '../security'; import type {ArchiveEntryInfo,DetectionResult} from './types';
export function detectArchive(entries:ArchiveEntryInfo[]):DetectionResult{const securityWarnings=validateEntries(entries);const result=facebookDetector.detect(entries);return {...result,warnings:[...securityWarnings,...result.warnings]}}
