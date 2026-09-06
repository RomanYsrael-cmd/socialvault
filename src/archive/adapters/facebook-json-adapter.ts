import { FACEBOOK_PARSER_VERSION } from './version';
import type { FacebookArchiveAdapter } from './types';

/** Registry entry for the existing tolerant JSON parser.  The parser itself
 * remains in facebook-parser.ts so older callers keep their public exports. */
export const facebookJsonAdapter: FacebookArchiveAdapter = {
  platform: 'facebook',
  format: 'json',
  parserVersion: FACEBOOK_PARSER_VERSION,
  supports: path => path.toLowerCase().endsWith('.json'),
};
