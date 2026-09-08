import { useEffect, useState } from 'react';
import { liveImportMetrics } from '../archive/import-metrics';
import type { StorageStatus } from '../database/types';

export function ImportDetails({ busy, storage }: { busy: boolean; storage?: StorageStatus }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  const parser = liveImportMetrics.parser, db = liveImportMetrics.database;
  const lastProgress = Math.max(parser?.updatedAt ?? now, db?.updatedAt ?? now);
  const stages = db?.stages ?? {}, writes = stages['base-write'];
  const parsing = parser?.stages['tokenize-normalize'];
  const normalized = parser?.stages.normalized?.rows ?? 0;
  const bytes = parser?.stages['zip-stream-wait']?.bytes ?? 0;
  return <details className="panel" data-testid="import-details"><summary>Import details</summary>
    <p>Database: {storage?.mode?.toUpperCase() ?? 'Opening'}{storage?.vfs ? ` (${storage.vfs})` : ''}. {storage?.reason}</p>
    {busy && <p>{now - lastProgress >= 60_000 ? 'Possible stall — no measured progress for 60 seconds. Work has not been cancelled.' : 'Local processing is active.'}</p>}
    <p>Parser stage: {parser?.stage ?? 'waiting'}. Database stage: {db?.stage ?? 'waiting'}. {parser?.current && `Part ${parser.current.part}, ${parser.current.section} file ${parser.current.file}.`}</p>
    <p>{normalized.toLocaleString()} records normalized · {(bytes / 1048576).toFixed(1)} MiB HTML read · {parsing?.ms ? Math.round(normalized / (parsing.ms / 1000)).toLocaleString() : 0} records/parser-second.</p>
    <p>{writes?.rows.toLocaleString() ?? 0} rows submitted to committed transactions · {writes?.ms ? Math.round(writes.rows / (writes.ms / 1000)).toLocaleString() : 0} rows/write-second · average batch {writes?.calls ? Math.round(writes.ms / writes.calls) : 0} ms · max {Math.round(writes?.maxMs ?? 0)} ms.</p>
    <small>Counts include idempotent duplicate submissions. Timings overlap where one stage contains another; they are not additive. No record values are included.</small>
  </details>;
}
