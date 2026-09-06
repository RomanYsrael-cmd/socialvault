import type { NormalizedArchiveData } from '../schemas/models';

export type FacebookExportFormat = 'json' | 'html';

/** Small adapter contract shared by format-specific Facebook implementations. */
export interface FacebookArchiveAdapter {
  readonly platform: 'facebook';
  readonly format: FacebookExportFormat;
  readonly parserVersion: number;
  supports(path: string): boolean;
}

export type AdapterBatch = Pick<NormalizedArchiveData, 'profile' | 'people' | 'profileFacts' | 'posts' | 'comments' | 'reactions' | 'connections' | 'albums' | 'conversations' | 'messages' | 'media'>;
