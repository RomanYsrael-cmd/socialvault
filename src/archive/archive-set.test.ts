import { describe, expect, it } from 'vitest';
import { archiveSetFingerprint, attributeArchivePart, makeArchivePart, makeArchiveSet, matchArchiveParts, mergeNormalizedData } from './archive-set';
import { emptyNormalizedData } from './adapters/facebook-parser';

const file = (name: string, size = 10) => ({ name, size });
const entries = (name: string) => [{ filename: `your_facebook_activity/${name}.json`, uncompressedSize: 2, compressedSize: 2 }];

describe('multi-part archive identity', () => {
  it('creates an order-independent set fingerprint and stable part IDs', () => {
    const a = makeArchivePart(file('part-1.zip'), entries('posts'), 0), b = makeArchivePart(file('part-2.zip'), entries('messages'), 1);
    expect(archiveSetFingerprint([a, b])).toBe(archiveSetFingerprint([b, a]));
    expect(makeArchiveSet([a, b]).partCount).toBe(2);
    expect(makeArchivePart(file('renamed.zip'), entries('posts'), 0).id).toBe(a.id);
  });
  it('matches renamed parts by manifest and reports missing, duplicate, and unexpected files', () => {
    const expected = makeArchivePart(file('part-1.zip'), entries('posts'), 0); const missing = makeArchivePart(file('part-2.zip'), entries('messages'), 1); const renamed = makeArchivePart(file('renamed.zip'), entries('posts'), 0); const extra = makeArchivePart(file('other.zip'), entries('other'), 1);
    const result = matchArchiveParts([expected, missing], [renamed, extra, { ...renamed, id: `${renamed.id}:copy` }]);
    expect(result.matched).toHaveLength(1); expect(result.matched[0].candidate.filename).toBe('renamed.zip'); expect(result.missing.map(part => part.id)).toEqual([missing.id]); expect(result.duplicates).toHaveLength(1); expect(result.unexpected).toHaveLength(1);
  });
  it('attributes records and deduplicates stable IDs across parts', () => {
    const first = emptyNormalizedData(); first.posts.push({ id: 'post:1', text: 'hello', source: { platform: 'facebook', path: 'posts.json' } });
    const second = emptyNormalizedData(); second.posts.push({ id: 'post:1', text: 'hello', source: { platform: 'facebook', path: 'posts.json' } }); second.posts.push({ id: 'post:2', text: 'world', source: { platform: 'facebook', path: 'posts-2.json' } });
    const merged = mergeNormalizedData([attributeArchivePart(first, 'archive-part:a'), attributeArchivePart(second, 'archive-part:b')]);
    expect(merged.posts.map(post => post.id)).toEqual(['post:1', 'post:2']); expect(merged.posts[0].source.archivePartId).toBe('archive-part:a'); expect(merged.posts[1].source.archivePartId).toBe('archive-part:b');
  });
});
