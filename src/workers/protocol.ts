import type { DetectionResult } from '../archive/detectors/types';
import type { ArchiveSet, NormalizedArchiveData } from '../archive/schemas/models';

export type ImportRequest = { action: 'inspect' | 'import' | 'import-part' | 'verify' | 'cancel'; file?: File; expectedParts?: import('../archive/schemas/models').ArchivePart[]; archiveSet?: ArchiveSet; sessionId?: string; completedPartIds?: string[]; skippedPartIds?: string[] } | { action: 'part-ack' | 'batch-ack'; ackId: string; ok?: boolean; error?: string };
export type ImportProgress =
  | { type: 'progress'; stage: 'opening' | 'inspecting' | 'detected' | 'identity' | 'profile' | 'posts' | 'comments' | 'reactions' | 'connections' | 'albums' | 'messages' | 'media' | 'search' | 'complete'; message: string; completed?: number; total?: number; partIndex?: number; partCount?: number; partId?: string }
  | { type: 'manifest'; part: import('../archive/schemas/models').ArchivePart; paths: string[] }
  | { type: 'result'; result: DetectionResult }
  | { type: 'part-batch'; data: NormalizedArchiveData; part: import('../archive/schemas/models').ArchivePart; sessionId?: string; ackId: string }
  | { type: 'part-result'; data: NormalizedArchiveData; part: import('../archive/schemas/models').ArchivePart; sessionId?: string; ackId: string }
  | { type: 'import-result'; data: NormalizedArchiveData; sessionId?: string }
  | { type: 'cancelled'; message: string; sessionId?: string }
  | { type: 'error'; message: string };
