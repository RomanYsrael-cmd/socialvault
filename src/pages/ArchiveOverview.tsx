import { useRef, useState } from 'react';
import { BarChart3, CheckCircle2, Database, FileArchive, HardDrive, Layers3, Link2, LoaderCircle, ShieldCheck, TriangleAlert } from 'lucide-react';
import { Navigate } from 'react-router-dom';
import { useArchiveStore } from '../stores/archive';
import type { ImportProgress } from '../workers/protocol';
import { database } from '../database/client';
import { useDatabaseQuery } from './useDatabaseQuery';
import type { DetectionResult } from '../archive/detectors/types';
import type { ArchiveStats } from '../database/types';

const format = (bytes = 0) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
const date = (value?: string) => value ? new Date(value).toLocaleDateString() : '—';

export function ArchiveOverview() {
  const { file, fileName, fileSize, result, imported, storageMode, markImported, setArchive } = useArchiveStore();
  const [busy, setBusy] = useState(false), [status, setStatus] = useState(''), [warnings, setWarnings] = useState<string[]>([]), [error, setError] = useState(''), [refresh, setRefresh] = useState(0);
  const reconnectInput = useRef<HTMLInputElement>(null);
  const { data: stats, loading: statsLoading } = useDatabaseQuery(() => database.stats(), [imported, refresh]);
  if (!result && statsLoading) return <div className="page"><p className="empty">Loading saved local archive…</p></div>;
  if (!result && !stats?.archiveIdentity) return <Navigate to="/" replace/>;
  const start = () => {
    if (!file) return;
    setBusy(true); setError('');
    const worker = new Worker(new URL('../workers/import.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = async (event: MessageEvent<ImportProgress>) => {
      const message = event.data;
      if (message.type === 'progress') setStatus(message.message);
      if (message.type === 'error') { setError(message.message); setBusy(false); worker.terminate(); }
      if (message.type === 'import-result') {
        try { setStatus('Finalizing local database…'); const info = await database.init(); await database.replace(message.data); setWarnings(message.data.warnings); markImported(info.mode); setRefresh(value => value + 1); setStatus(`Imported ${message.data.posts.length} posts, ${message.data.comments.length} comments, ${message.data.connections.length} connections, ${message.data.albums.length} albums, and ${message.data.messages.length} messages locally.`); }
        catch (caught) { setError(caught instanceof Error ? caught.message : 'Local storage failed.'); }
        finally { setBusy(false); worker.terminate(); }
      }
    };
    worker.onerror = () => { setError('The local import worker stopped unexpectedly.'); setBusy(false); worker.terminate(); };
    worker.postMessage({ action: 'import', file });
  };
  const reconnect = (candidate: File) => {
    setBusy(true); setError(''); setStatus('Checking the selected archive signature…');
    const worker = new Worker(new URL('../workers/import.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = async (event: MessageEvent<ImportProgress>) => {
      const message = event.data;
      if (message.type === 'error') { setError(message.message); setBusy(false); worker.terminate(); return; }
      if (message.type === 'result') {
        const expected = stats?.archiveIdentity, actual = message.result.identity;
        const matches = expected && actual && expected.filename === actual.filename && expected.size === actual.size && expected.fingerprint === actual.fingerprint && expected.entryCount === actual.entryCount;
        if (!matches) { setError('That ZIP does not match the imported archive. Choose the original file to reconnect media safely.'); setBusy(false); worker.terminate(); return; }
        const mode = (await database.init()).mode; setArchive(candidate, message.result as DetectionResult, true); markImported(mode); setStatus('Archive reconnected. Text and search remain available while media loads on demand.'); setBusy(false); worker.terminate();
      }
    };
    worker.onerror = () => { setError('The archive verification worker stopped unexpectedly.'); setBusy(false); worker.terminate(); };
    worker.postMessage({ action: 'verify', file: candidate });
  };
  if (!result && stats?.archiveIdentity) return <div className="page"><div className="page-title"><span className="success-icon"><Link2/></span><div><p className="eyebrow">Saved local archive</p><h1>Reconnect media</h1><p>Your normalized text, people, statistics, and search index are still available. Reconnect the matching ZIP only when you want to preview media.</p></div></div><section className="panel reconnect-panel"><Database/><div><h2>Archive disconnected</h2><p>Expected <b>{stats.archiveIdentity.filename}</b> · {format(stats.archiveIdentity.size)} · {stats.archiveIdentity.entryCount.toLocaleString()} entries.</p><input ref={reconnectInput} type="file" accept=".zip,application/zip" hidden onChange={event => { const candidate = event.target.files?.[0]; if (candidate) reconnect(candidate); }}/><button className="primary" onClick={() => reconnectInput.current?.click()} disabled={busy}>{busy ? <><LoaderCircle className="spin"/> Checking ZIP…</> : 'Select matching ZIP'}</button>{status && <small>{status}</small>}{error && <p className="error">{error}</p>}</div></section><SavedStats stats={stats}/><div className="privacy-banner"><ShieldCheck/><div><b>Still local-only</b><p>The ZIP is verified and read on this device. No archive contents are uploaded.</p></div></div></div>;
  if (!result) return null;
  const allWarnings = [...result.warnings, ...warnings];
  return <div className="page"><div className="page-title"><span className="success-icon"><CheckCircle2/></span><div><p className="eyebrow">Archive ready</p><h1>Your archive is open</h1><p>We found a Facebook Download Your Information archive and inspected its structure.</p></div></div><div className="stats"><article><FileArchive/><span><small>ZIP file</small><b>{fileName}</b></span></article><article><HardDrive/><span><small>Archive size</small><b>{format(fileSize)}</b></span></article><article><Layers3/><span><small>ZIP entries inspected</small><b>{result.inspectedEntries.toLocaleString()}</b></span></article><article><ShieldCheck/><span><small>Platform</small><b>Facebook</b></span></article></div><section className="panel"><h2>Detected sections</h2><p>Recognizable categories found in the ZIP structure.</p><div className="chips">{result.sections.length ? result.sections.map(section => <span key={section}><CheckCircle2/>{section}</span>) : <span>No named sections detected</span>}</div></section><section className="panel import-panel"><Database/><div><h2>{imported ? 'Local import complete' : 'Import archive data'}</h2><p>{imported ? `Saved locally using ${storageMode === 'opfs' ? 'SQLite in OPFS' : 'SQLite with IndexedDB fallback'}.` : 'Parse supported profile, post, comments, reactions, connections, albums, messages, and media metadata into a private local database.'}</p>{status && <small>{status}</small>}{error && <p className="error">{error}</p>}<button className="primary" onClick={start} disabled={busy || imported}>{busy ? <><LoaderCircle className="spin"/> Importing locally…</> : imported ? <><CheckCircle2/> Imported</> : 'Start local import'}</button></div></section>{imported && stats && <SavedStats stats={stats}/>} {allWarnings.length > 0 && <section className="panel warning"><h2><TriangleAlert/> Import notes</h2>{allWarnings.map(warning => <p key={warning}>{warning}</p>)}</section>}<div className="privacy-banner"><ShieldCheck/><div><b>Your data never left this device</b><p>The ZIP was read and indexed locally by background workers. No archive contents were sent to a server.</p></div></div></div>;
}

function SavedStats({ stats }: { stats: ArchiveStats }) {
  return <section className="panel stats-panel"><div className="panel-heading"><div><h2>Imported records</h2><p>Counts come from normalized records in SQLite, not from unparsed ZIP files.</p></div><BarChart3/></div><div className="record-stats"><div><b>{stats.people}</b><span>People</span></div><div><b>{stats.posts}</b><span>Posts</span></div><div><b>{stats.comments}</b><span>Comments</span></div><div><b>{stats.reactions}</b><span>Reactions</span></div><div><b>{stats.connections}</b><span>Connections</span></div><div><b>{stats.albums}</b><span>Albums</span></div><div><b>{stats.conversations}</b><span>Conversations</span></div><div><b>{stats.messages}</b><span>Messages</span></div><div><b>{stats.media}</b><span>Media references</span></div><div><b>{stats.warnings}</b><span>Warnings</span></div></div><div className="date-range"><span><small>Earliest known content</small><b>{date(stats.earliest)}</b></span><span><small>Latest known content</small><b>{date(stats.latest)}</b></span><span><small>Source sections imported</small><b>{stats.sections}</b></span>{stats.diagnostics && <><span><small>JSON candidates / parsed</small><b>{stats.diagnostics.candidateFiles} / {stats.diagnostics.parsedFiles}</b></span><span><small>Malformed / unsupported</small><b>{stats.diagnostics.malformedFiles} / {stats.diagnostics.unsupportedCandidates}</b></span><span><small>Missing media / incomplete IDs</small><b>{stats.diagnostics.missingMedia} / {stats.diagnostics.incompleteIdentities}</b></span></>}</div></section>;
}
