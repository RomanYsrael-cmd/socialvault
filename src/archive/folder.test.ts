import { describe, expect, it } from 'vitest';
import { discoverZipFiles, discoverZipSources } from './folder';

const file = (name: string, size = 4) => new File([new Uint8Array(size)], name, { type: 'application/zip' });
type Node = { kind: 'file' | 'directory'; name: string; getFile?: () => Promise<File>; entries?: () => AsyncIterableIterator<[string, Node]> };
const directory = (name: string, children: Record<string, Node>) => ({ kind: 'directory' as const, name, async *entries() { for (const item of Object.entries(children)) yield item; } });
const zip = (name: string, size?: number): Node => ({ kind: 'file', name, getFile: async () => file(name, size) });

describe('bounded folder ZIP discovery', () => {
  it('recursively finds ZIPs while ignoring unrelated files', async () => {
    const result = await discoverZipFiles(directory('export', { 'readme.txt': { kind: 'file', name: 'readme.txt' }, 'one.zip': zip('one.zip'), nested: directory('nested', { 'two.ZIP': zip('two.ZIP', 7) }) }));
    expect(result.rootName).toBe('export');
    expect(result.files.map(item => item.name)).toEqual(['one.zip', 'two.ZIP']);
    expect(result.directories).toBe(2);
    expect(result.truncated).toBe(false);
  });

  it('reports a bounded depth instead of crawling forever', async () => {
    let root: Node = zip('deep.zip');
    for (let index = 0; index < 12; index++) root = directory(`level-${index}`, { [`level-${index + 1}`]: root });
    const result = await discoverZipFiles(root as never);
    expect(result.truncated).toBe(true);
    expect(result.files).toHaveLength(0);
    expect(result.warnings.some(message => /depth/i.test(message))).toBe(true);
  });

  it('stops after the ZIP safety bound', async () => {
    const children: Record<string, Node> = {};
    for (let index = 0; index < 10_005; index++) children[`part-${index}.zip`] = zip(`part-${index}.zip`);
    const result = await discoverZipFiles(directory('large', children));
    expect(result.files).toHaveLength(10_000);
    expect(result.truncated).toBe(true);
  });

  it('enumerates ZIP handles without materializing file bytes', async () => {
    let reads = 0;
    const lazy: Node = { kind: 'file', name: 'lazy.zip', getFile: async () => { reads++; return file('lazy.zip', 12); } };
    const result = await discoverZipSources(directory('export', { 'lazy.zip': lazy }));
    expect(result.files).toHaveLength(0);
    expect(result.sources).toHaveLength(1);
    expect(reads).toBe(0);
    await result.sources?.[0].handle?.getFile();
    expect(reads).toBe(1);
  });
});
