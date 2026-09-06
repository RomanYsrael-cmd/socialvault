import type { ArchiveCoverage, ArchivePart, ImportDiagnostics, ImportSession } from '../archive/schemas/models';

export interface DiagnosticsInput {
  appVersion?: string;
  parserVersion?: number;
  schemaVersion?: number;
  archiveParts?: ArchivePart[];
  session?: ImportSession;
  coverage?: ArchiveCoverage;
  diagnostics?: ImportDiagnostics;
  warnings?: number;
}

const safePath = (value: string) => {
  const basename = value.replaceAll('\\', '/').split('/').filter(Boolean).pop() ?? 'unknown';
  const extension = basename.match(/\.[a-z0-9]{1,8}$/i)?.[0].toLowerCase() ?? '';
  return `<file>${extension}`;
};
const safeCategory = (value: string) => {
  const normalized = value.toLowerCase().trim();
  if (['unsupported-shape', 'malformed-json', 'unsafe-path', 'missing-media', 'duplicate-part', 'import-warning'].includes(normalized)) return normalized;
  if (normalized.includes('unsupported')) return 'unsupported-shape';
  if (normalized.includes('malformed') || normalized.includes('parse')) return 'malformed-json';
  if (normalized.includes('unsafe') || normalized.includes('suspicious')) return 'unsafe-path';
  if (normalized.includes('media')) return 'missing-media';
  if (normalized.includes('duplicate')) return 'duplicate-part';
  return 'parser-warning';
};
const safeMetrics = (metrics?: ImportSession['metrics']) => metrics ? {
  totalDurationMs: metrics.totalDurationMs ?? 0,
  partDurationsMs: Object.fromEntries(Object.values(metrics.partDurationsMs ?? {}).map((duration, index) => [`part-${index + 1}`, duration])),
  sectionCounts: metrics.sectionCounts ?? {},
  slowestSections: metrics.slowestSections ?? [],
} : null;
const safeShape = (value: string) => {
  const structural = new Set(['array', 'empty', 'null', 'object', 'string', 'number', 'boolean', 'undefined', 'about_me', 'account', 'account_information', 'albums', 'attachments', 'author', 'basic_information', 'body', 'content', 'conversation', 'created_at', 'data', 'display_name', 'entries', 'file_name', 'full_name', 'id', 'items', 'message', 'message_data', 'messages', 'messages_data', 'name', 'participants', 'path', 'personal_information', 'post', 'posts', 'posts_v2', 'profile', 'profile_information', 'profile_v2', 'sender', 'sender_name', 'text', 'thread', 'timestamp', 'title', 'uri', 'user_id', 'username']);
  const suffix = value.replace(/^.*?→\s*/, '');
  return `<path> → ${suffix.replace(/[A-Za-z][A-Za-z0-9_-]*/g, token => structural.has(token.toLowerCase()) ? token.toLowerCase() : '<key>')}`;
};

/** Build a report that describes structure and counts without archive values. */
export function createDiagnosticsReport(input: DiagnosticsInput) {
  const parts = input.archiveParts ?? [];
  const session = input.session;
  const coverage = input.coverage ?? session?.coverage;
  const safeCoverage = coverage ? { ...coverage, skippedParts: coverage.skippedParts.map(() => '<part>') } : null;
  return {
    product: 'SocialVault',
    version: input.appVersion ?? '0.1.0',
    parserVersion: input.parserVersion ?? session?.parserVersion ?? null,
    schemaVersion: input.schemaVersion ?? session?.schemaVersion ?? null,
    generatedAt: new Date().toISOString(),
    archive: {
      partCount: parts.length || session?.expectedPartCount || 0,
      totalSize: parts.reduce((sum, part) => sum + part.fileSize, 0),
      parts: parts.map(part => ({ index: part.partIndex + 1, filename: safePath(part.filename), size: part.fileSize, entryCount: part.entryCount, status: part.status ?? 'ready', warningCount: part.warningCount ?? 0, sections: part.sections ?? [] })),
    },
    import: session ? { id: '<session>', status: session.status, stage: session.currentStage, startedAt: session.startedAt, updatedAt: session.updatedAt, expectedParts: session.expectedPartCount, inspectedParts: session.inspectedPartCount, importedParts: session.importedPartCount, failedParts: session.failedPartCount, skippedParts: session.skippedPartCount, normalizedCounts: session.normalizedCounts, warnings: session.warningsCount, failedPartIds: session.failedPartIds?.length ?? 0, skippedPartIds: session.skippedPartIds?.length ?? 0, metrics: safeMetrics(session.metrics) } : null,
    coverage: safeCoverage,
    diagnostics: input.diagnostics ? { candidateFiles: input.diagnostics.candidateFiles, parsedFiles: input.diagnostics.parsedFiles, unsupportedCandidates: input.diagnostics.unsupportedCandidates, malformedFiles: input.diagnostics.malformedFiles, missingMedia: input.diagnostics.missingMedia, incompleteIdentities: input.diagnostics.incompleteIdentities, warningGroups: input.diagnostics.warningGroups?.map(group => ({ category: safeCategory(group.category), count: group.count, sourcePaths: group.sourcePaths.map(safePath) })), shapeSignatures: input.diagnostics.shapeSignatures?.map(safeShape), performance: input.diagnostics.performance ?? null } : null,
    privacy: { includesArchiveContent: false, includesNames: false, includesMessageText: false, includesPostText: false, includesMediaBytes: false, includesRawJson: false },
  };
}

export function diagnosticsText(report: ReturnType<typeof createDiagnosticsReport>) {
  return JSON.stringify(report, null, 2);
}
