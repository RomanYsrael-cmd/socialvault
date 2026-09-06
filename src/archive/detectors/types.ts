import type {ArchiveIdentity} from '../schemas/models';
export type ArchivePlatform='facebook'|'unknown';
export interface DetectionResult{supported:boolean;platform:ArchivePlatform;confidence:number;entryCount:number;inspectedEntries:number;sections:string[];warnings:string[];identity?:ArchiveIdentity}
export interface ArchiveEntryInfo{filename:string;directory:boolean;uncompressedSize?:number;compressedSize?:number}
export interface ArchiveDetector{platform:ArchivePlatform;detect(entries:ArchiveEntryInfo[]):DetectionResult}
