import { mergeDetectionResults } from './detection-aggregate';
import { archiveSourceRegistry, type ArchiveSourceDescriptor } from './source-registry';
import type { DetectionResult } from './detectors/types';
import type { ArchivePart, ArchiveSet, NormalizedArchiveData } from './schemas/models';
import type { ImportProgress } from '../workers/protocol';

export type ImportProgressHandler = (message: ImportProgress) => void;

const makeWorker = () => new Worker(new URL('../workers/import.worker.ts', import.meta.url), { type: 'module' });

/** Inspect one source at a time. A worker owns one File for one operation and
 * is terminated before the next source is materialized. */
export async function inspectArchiveSources(sources: readonly ArchiveSourceDescriptor[], onProgress?: ImportProgressHandler): Promise<DetectionResult> {
  const results: DetectionResult[] = [];
  const duplicateNames: string[] = [];
  const fingerprints = new Set<string>();
  for (const source of sources) {
    const file = await archiveSourceRegistry.materializeKey(source.key);
    if (!file) {
      results.push({ supported: false, platform: 'unknown', confidence: 0, entryCount: 0, inspectedEntries: 0, sections: [], warnings: [`${source.name}: source is no longer available; reconnect the selected folder or ZIP.`], parts: [{ id: `archive-part:missing:${source.key}`, archiveId: '', partIndex: results.length, filename: source.name, fileSize: source.size, entryCount: 0, manifestFingerprint: `missing:${source.key}`, connected: false, status: 'missing' }] });
      continue;
    }
    const result = await inspectSource(file, source, onProgress);
    const fingerprint = result.parts?.[0]?.manifestFingerprint ?? result.identity?.fingerprint;
    if (fingerprint && fingerprints.has(fingerprint)) duplicateNames.push(source.name);
    else { if (fingerprint) fingerprints.add(fingerprint); results.push(result); }
    if (archiveSourceRegistry.hasHandle(source.key)) archiveSourceRegistry.releaseKey(source.key);
  }
  const merged = mergeDetectionResults(results, duplicateNames);
  archiveSourceRegistry.bindParts(merged.parts ?? []);
  return merged;
}

function inspectSource(file: File, source: ArchiveSourceDescriptor, onProgress?: ImportProgressHandler): Promise<DetectionResult> {
  return new Promise((resolve, reject) => {
    const worker = makeWorker();
    let settled = false;
    const finish = (callback: () => void) => { if (settled) return; settled = true; worker.terminate(); callback(); };
    worker.onmessage = (event: MessageEvent<ImportProgress>) => {
      const message = event.data;
      onProgress?.(message);
      if (message.type === 'manifest') {
        archiveSourceRegistry.bindPartForKey(source.key, message.part.id);
        archiveSourceRegistry.registerManifest(message.part.id, message.paths);
      } else if (message.type === 'result') finish(() => resolve(message.result));
      else if (message.type === 'error') finish(() => reject(new Error(message.message)));
    };
    worker.onerror = () => finish(() => reject(new Error('The archive inspector stopped unexpectedly.')));
    worker.postMessage({ action: 'inspect', file });
  });
}

export interface ImportPartHandlers {
  onProgress?: ImportProgressHandler;
  onBatch?: (data: NormalizedArchiveData, part: ArchivePart) => Promise<void>;
  onPart?: (data: NormalizedArchiveData, part: ArchivePart) => Promise<void>;
  onCancelReady?: (cancel: () => void) => void;
}

/** Import exactly one archive part. Batches are acknowledged before parsing
 * continues, and the worker is discarded after the part checkpoint. */
export async function importArchivePart(part: ArchivePart, archiveSet: ArchiveSet, sessionId: string, handlers: ImportPartHandlers = {}): Promise<NormalizedArchiveData> {
  const file = await archiveSourceRegistry.materialize(part.id);
  if (!file) throw new Error(`Archive part ${part.filename} is not connected. Reconnect it before importing.`);
  return new Promise((resolve, reject) => {
    const worker = makeWorker();
    let settled = false;
    const finish = (callback: () => void) => { if (settled) return; settled = true; worker.terminate(); callback(); };
    worker.onmessage = (event: MessageEvent<ImportProgress>) => {
      const message = event.data;
      handlers.onProgress?.(message);
      if (message.type === 'manifest') {
        archiveSourceRegistry.bindPartForKey(part.id, message.part.id);
        archiveSourceRegistry.registerManifest(part.id, message.paths);
      } else if (message.type === 'part-batch') {
        void (handlers.onBatch ? handlers.onBatch(message.data, message.part) : Promise.resolve()).then(() => worker.postMessage({ action: 'batch-ack', ackId: message.ackId, ok: true })).catch(error => worker.postMessage({ action: 'batch-ack', ackId: message.ackId, ok: false, error: error instanceof Error ? error.message : String(error) }));
      } else if (message.type === 'part-result') {
        void (handlers.onPart ? handlers.onPart(message.data, message.part) : Promise.resolve()).then(() => worker.postMessage({ action: 'part-ack', ackId: message.ackId, ok: true })).catch(error => worker.postMessage({ action: 'part-ack', ackId: message.ackId, ok: false, error: error instanceof Error ? error.message : String(error) }));
      } else if (message.type === 'import-result') {
        finish(() => { archiveSourceRegistry.markProcessed(part.id); resolve(message.data); });
      } else if (message.type === 'cancelled') finish(() => reject(new Error(message.message)));
      else if (message.type === 'error') finish(() => reject(new Error(message.message)));
    };
    worker.onerror = () => finish(() => reject(new Error('The local import worker stopped unexpectedly.')));
    handlers.onCancelReady?.(() => worker.postMessage({ action: 'cancel', sessionId }));
    worker.postMessage({ action: 'import-part', file, expectedParts: [part], archiveSet, sessionId });
  });
}
