import type {ArchiveCoverage,ArchiveIdentity,ArchivePart} from '../schemas/models';
export type ArchivePlatform='facebook'|'unknown';
export type ArchiveFormat='json'|'html'|'mixed'|'unknown';
export interface DetectionResult{metadataOnlyEligible?:boolean;supported:boolean;platform:ArchivePlatform;confidence:number;entryCount:number;inspectedEntries:number;sections:string[];supportedSections?:string[];unsupportedSections?:string[];warnings:string[];identity?:ArchiveIdentity;parts?:ArchivePart[];archiveSetFingerprint?:string;totalSize?:number;duplicateParts?:string[];unsupportedParts?:string[];duplicatePaths?:string[];coverage?:ArchiveCoverage;format?:ArchiveFormat}
export interface ArchiveEntryInfo{filename:string;directory:boolean;uncompressedSize?:number;compressedSize?:number}
export interface ArchiveDetector{platform:ArchivePlatform;detect(entries:ArchiveEntryInfo[]):DetectionResult}
