import { describe, expect, it } from 'vitest';
import { mergeDetectionResults } from './detection-aggregate';

const part = (id: string, fingerprint: string, filename: string) => ({ id, archiveId: `set:${fingerprint}`, partIndex: 0, filename, fileSize: 10, entryCount: 2, manifestFingerprint: fingerprint, connected: true, status: 'ready' as const });

describe('one-at-a-time detection aggregation', () => {
  it('deduplicates manifest-identical parts and creates a stable set shell', () => {
    const first = { supported: true, platform: 'facebook' as const, confidence: .9, entryCount: 2, inspectedEntries: 2, sections: ['Posts'], supportedSections: ['Posts'], warnings: [], format: 'json' as const, parts: [part('old-one', 'a', 'one.zip')] };
    const duplicate = { ...first, parts: [part('old-copy', 'a', 'copy.zip')] };
    const second = { supported: true, platform: 'facebook' as const, confidence: .8, entryCount: 2, inspectedEntries: 2, sections: ['Messages'], supportedSections: ['Messages'], warnings: [], format: 'json' as const, parts: [part('old-two', 'b', 'two.zip')] };
    const merged = mergeDetectionResults([first, duplicate, second], ['copy.zip']);
    expect(merged.parts?.map(item => item.manifestFingerprint)).toEqual(['a', 'b']);
    expect(merged.parts?.every(item => item.archiveId === merged.parts?.[0].archiveId)).toBe(true);
    expect(merged.sections).toEqual(['Posts', 'Messages']);
    expect(merged.duplicateParts).toEqual(['copy.zip']);
    expect(merged.warnings.some(warning => warning.includes('duplicate ZIP part'))).toBe(true);
  });
});
