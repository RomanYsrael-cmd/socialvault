import { describe, expect, it } from 'vitest';
import { createDiagnosticsReport, diagnosticsText } from './diagnostics';

describe('privacy-safe diagnostics', () => {
  it('contains structure and counts but no archive values', () => {
    const report = createDiagnosticsReport({
      parserVersion: 8,
      schemaVersion: 7,
      archiveParts: [{ id: 'part:1', archiveId: 'set:1', partIndex: 0, filename: 'messages/Private Person.zip', fileSize: 12, entryCount: 2, manifestFingerprint: 'abc', connected: false, status: 'failed', sections: ['Messages'] }],
      session: { id: 'import-session:private-fingerprint', archiveSetId: 'archive-set:private-fingerprint', startedAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', parserVersion: 8, schemaVersion: 7, expectedPartCount: 1, inspectedPartCount: 1, importedPartCount: 0, failedPartCount: 1, skippedPartCount: 0, currentStage: 'failed', status: 'failed', normalizedCounts: { profiles: 0, people: 0, posts: 0, comments: 0, reactions: 0, connections: 0, albums: 0, conversations: 0, messages: 0, media: 0, activities: 0 }, warningsCount: 4, metrics: { partDurationsMs: { 'archive-part:private-fingerprint': 10 } } },
      diagnostics: { candidateFiles: 2, parsedFiles: 1, unsupportedCandidates: 1, malformedFiles: 0, missingMedia: 0, incompleteIdentities: 0, shapeSignatures: ['messages/Private Person.json → object{messages_data:array[string], Private Person:string}'], warningGroups: [{ category: 'unsupported-shape', message: 'private message text', count: 4, sourcePaths: ['messages/Private Person.json'] }, { category: 'Private Person parser detail', message: 'private text', count: 1, sourcePaths: ['messages/Private Person.json'] }] },
      warnings: 4,
    });
    const serialized = diagnosticsText(report);
    expect(serialized).toContain('unsupported-shape');
    expect(serialized).toContain('<file>.zip');
    expect(serialized).toContain('<session>');
    expect(serialized).not.toContain('private-fingerprint');
    expect(serialized).not.toContain('Private Person');
    expect(serialized).not.toContain('private message text');
    expect(serialized).not.toContain('messages/Private Person.json');
    expect(serialized).toContain('includesMessageText');
  });
});
