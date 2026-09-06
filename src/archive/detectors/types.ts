import type {ArchiveCoverage,ArchiveIdentity,ArchivePart} from '../schemas/models';
export type ArchivePlatform='facebook'|'unknown';
export interface DetectionResult{supported:boolean;platform:ArchivePlatform;confidence:number;entryCount:number;inspectedEntries:number;sections:string[];supportedSections?:string[];unsupportedSections?:string[];warnings:string[];identity?:ArchiveIdentity;parts?:ArchivePart[];archiveSetFingerprint?:string;totalSize?:number;duplicateParts?:string[];unsupportedParts?:string[];duplicatePaths?:string[];coverage?:ArchiveCoverage}
export interface ArchiveEntryInfo{filename:string;directory:boolean;uncompressedSize?:number;compressedSize?:number}
export interface ArchiveDetector{platform:ArchivePlatform;detect(entries:ArchiveEntryInfo[]):DetectionResult}
