import type { NormalizedArchiveData } from './schemas/models';
export const BATCH_ROWS = 5000;
export const BATCH_BYTES = 8 * 1024 * 1024;
export const recordKeys = ['people', 'profileFacts', 'posts', 'comments', 'reactions', 'connections', 'albums', 'conversations', 'messages', 'media'] as const;
/** Conservative UTF-8/clone estimate including keys, provenance and nested
 * media, without serializing a second complete production payload. */
export function estimateValueBytes(value: unknown): number {
  if (typeof value === 'string') return 8 + value.length * 3;
  if (value === null || value === undefined) return 8;
  if (typeof value !== 'object') return 16;
  if (Array.isArray(value)) return 16 + value.reduce((sum, item) => sum + estimateValueBytes(item), 0);
  return 32 + Object.entries(value).reduce((sum, [key, item]) => sum + 8 + key.length * 3 + estimateValueBytes(item), 0);
}
export const batchRows = (batch: NormalizedArchiveData) => recordKeys.reduce((sum, key) => sum + batch[key].length, 0);
export function* splitBatch(data: NormalizedArchiveData, rowLimit = BATCH_ROWS, byteLimit = BATCH_BYTES): Generator<NormalizedArchiveData> {
  const empty = () => ({ people: [], profileFacts: [], posts: [], comments: [], reactions: [], connections: [], albums: [], conversations: [], messages: [], media: [], warnings: [] }) as NormalizedArchiveData;
  let output = empty(), count = 0, bytes = 1024;
  for (const key of recordKeys) for (const record of data[key]) {
    const size = estimateValueBytes(record);
    if (count && (count >= rowLimit || bytes + size > byteLimit)) { yield output; output = empty(); count = 0; bytes = 1024; }
    (output[key] as unknown[]).push(record); count++; bytes += size;
  }
  if (count || data.completedSourcePaths?.length) { output.completedSourcePaths = data.completedSourcePaths; yield output; }
}
