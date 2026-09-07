import { afterEach, describe, expect, it } from 'vitest';
import { archiveSourceRegistry } from './source-registry';

afterEach(() => archiveSourceRegistry.clear());

describe('runtime archive source registry', () => {
  it('keeps directory sources lazy and reconnectable', async () => {
    let reads = 0;
    const source = archiveSourceRegistry.registerHandles([{ name: 'part.zip', relativePath: 'export/part.zip', handle: { kind: 'file', name: 'part.zip', getFile: async () => { reads++; return new File([new Uint8Array([1, 2])], 'part.zip', { type: 'application/zip' }); } } }])[0];
    expect(reads).toBe(0);
    const part = { id: 'part:one', archiveId: 'set:one', partIndex: 0, filename: 'part.zip', fileSize: 2, entryCount: 1, manifestFingerprint: 'fingerprint-one', connected: true, status: 'ready' as const };
    archiveSourceRegistry.bindParts([part]);
    expect(reads).toBe(0);
    expect(await archiveSourceRegistry.materialize(part.id)).toBeInstanceOf(File);
    expect(reads).toBe(1);
    archiveSourceRegistry.release(part.id);
    expect(archiveSourceRegistry.isAvailable(part.id)).toBe(true);
    expect(await archiveSourceRegistry.materialize(part.id)).toBeInstanceOf(File);
    expect(reads).toBe(2);
    expect(source.relativePath).toBe('export/part.zip');
  });

  it('resolves media paths from compact manifests', () => {
    const first = archiveSourceRegistry.registerHandles([{ name: 'one.zip', handle: { kind: 'file', name: 'one.zip', getFile: async () => new File([], 'one.zip') } }])[0];
    const second = archiveSourceRegistry.registerHandles([{ name: 'two.zip', handle: { kind: 'file', name: 'two.zip', getFile: async () => new File([], 'two.zip') } }])[0];
    archiveSourceRegistry.bindPartForKey(first.key, 'part:one'); archiveSourceRegistry.bindPartForKey(second.key, 'part:two');
    archiveSourceRegistry.registerManifest('part:one', ['photos/one.jpg']); archiveSourceRegistry.registerManifest('part:two', ['photos/two.jpg']);
    expect(archiveSourceRegistry.resolvePart('photos/one.jpg')).toBe('part:one');
    expect(archiveSourceRegistry.resolvePart('one.jpg')).toBe('part:one');
    expect(archiveSourceRegistry.resolvePart('missing.jpg')).toBeUndefined();
  });

  it('removes stale suffix owners when a part manifest is refreshed', () => {
    archiveSourceRegistry.registerManifest('part:one', ['photos/old.jpg']);
    archiveSourceRegistry.registerManifest('part:two', ['photos/old.jpg']);
    archiveSourceRegistry.registerManifest('part:one', ['photos/new.jpg']);
    expect(archiveSourceRegistry.resolvePart('photos/old.jpg')).toBe('part:two');
    expect(archiveSourceRegistry.resolvePart('old.jpg')).toBe('part:two');
    expect(archiveSourceRegistry.resolvePart('new.jpg')).toBe('part:one');
  });
});
