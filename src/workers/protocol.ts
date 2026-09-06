import type { DetectionResult } from '../archive/detectors/types';
import type { NormalizedArchiveData } from '../archive/schemas/models';

export type ImportRequest = { action: 'inspect' | 'import' | 'verify' | 'cancel'; file?: File; files?: File[]; expectedParts?: import('../archive/schemas/models').ArchivePart[] };
export type ImportProgress =
  | { type: 'progress'; stage: 'opening' | 'inspecting' | 'detected' | 'identity' | 'profile' | 'posts' | 'comments' | 'reactions' | 'connections' | 'albums' | 'messages' | 'media' | 'search' | 'complete'; message: string; completed?: number; total?: number; partIndex?: number; partCount?: number; partId?: string }
  | { type: 'result'; result: DetectionResult }
  | { type: 'import-result'; data: NormalizedArchiveData }
  | { type: 'cancelled'; message: string }
  | { type: 'error'; message: string };
