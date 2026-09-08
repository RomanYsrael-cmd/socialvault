import type { ImportMetrics } from './schemas/models';

/** Bounded, local-only measurements. Labels must be structural, never archive values. */
export interface StageMetric { ms: number; calls: number; rows: number; bytes: number; maxMs: number }
export interface PipelineMetrics { stage: string; updatedAt: number; stages: Record<string, StageMetric>; current?: { part: number; file: number; section: string }; slowestFiles?: { file: number; bytes: number; records: number; ms: number; dbWaitMs: number }[] }
export class ImportMeter {
  readonly stages: Record<string, StageMetric> = {};
  stage = 'idle';
  updatedAt = Date.now();
  current?: PipelineMetrics['current'];
  slowestFiles: NonNullable<PipelineMetrics['slowestFiles']> = [];
  add(stage: string, ms = 0, rows = 0, bytes = 0) {
    this.stage = stage; if (!stage.startsWith('sql:')) this.updatedAt = Date.now();
    const value = this.stages[stage] ??= { ms: 0, calls: 0, rows: 0, bytes: 0, maxMs: 0 };
    value.ms += ms; value.calls++; value.rows += rows; value.bytes += bytes; value.maxMs = Math.max(value.maxMs, ms);
  }
  snapshot(): PipelineMetrics { return { stage: this.stage, updatedAt: this.updatedAt, stages: structuredClone(this.stages), current: this.current, slowestFiles: this.slowestFiles }; }
}
export const importMeter = new ImportMeter();
export const liveImportMetrics: Record<string, PipelineMetrics> = {};
export function possibleStall(metrics: PipelineMetrics, now = Date.now(), threshold = 60_000) { return metrics.stage !== 'idle' && now - metrics.updatedAt >= threshold; }

/** Convert a live meter to the privacy-safe, persisted diagnostic shape. */
export function metricsFromMeter(meter: ImportMeter = importMeter): Pick<ImportMetrics, 'stageDurationsMs' | 'stageCounts' | 'stageRows' | 'stageBytes' | 'stageMaxLatencyMs' | 'slowestFiles'> {
  const stageDurationsMs: Record<string, number> = {}, stageCounts: Record<string, number> = {}, stageRows: Record<string, number> = {}, stageBytes: Record<string, number> = {}, stageMaxLatencyMs: Record<string, number> = {};
  for (const [stage, metric] of Object.entries(meter.stages)) {
    stageDurationsMs[stage] = Math.round(metric.ms);
    stageCounts[stage] = metric.calls;
    stageRows[stage] = metric.rows;
    stageBytes[stage] = metric.bytes;
    stageMaxLatencyMs[stage] = Math.round(metric.maxMs);
  }
  return { stageDurationsMs, stageCounts, stageRows, stageBytes, stageMaxLatencyMs, slowestFiles: meter.slowestFiles.map(file => ({ ...file, ms: Math.round(file.ms), dbWaitMs: Math.round(file.dbWaitMs) })) };
}
