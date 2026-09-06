import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('./client', () => ({ mediaClient: { extract: vi.fn(async () => new Blob(['image'], { type: 'image/png' })) } }));
import { objectUrlCache } from './object-url-cache';
describe('bounded media object URL cache', () => {
  afterEach(() => objectUrlCache.clear());
  it('reuses URLs and revokes them on archive replacement', async () => {
    const create = vi.fn(() => 'blob:local');
    const revoke = vi.fn();
    vi.stubGlobal('URL', { createObjectURL: create, revokeObjectURL: revoke });
    const file = new File(['zip'], 'archive.zip');
    expect(await objectUrlCache.acquire(file, 'photos/a.png', 'image/png')).toBe('blob:local');
    objectUrlCache.releaseKey(file, 'photos/a.png');
    expect(await objectUrlCache.acquire(file, 'photos/a.png', 'image/png')).toBe('blob:local');
    objectUrlCache.clear();
    expect(revoke).toHaveBeenCalledWith('blob:local');
    vi.unstubAllGlobals();
  });
});
