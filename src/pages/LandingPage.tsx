import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { FileArchive, LockKeyhole, ShieldCheck, X, ArrowRight, LoaderCircle } from 'lucide-react';
import { Logo } from '../components/Logo';
import type { ImportProgress } from '../workers/protocol';
import { useArchiveStore } from '../stores/archive';

const format = (n: number) => n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : n < 1024 * 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
const isZip = (file: File) => file.name.toLowerCase().endsWith('.zip') || file.type === 'application/zip' || file.type === 'application/x-zip-compressed';

export function LandingPage() {
  const input = useRef<HTMLInputElement>(null), nav = useNavigate(), save = useArchiveStore(s => s.setArchive);
  const [files, setFiles] = useState<File[]>([]), [drag, setDrag] = useState(false), [status, setStatus] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false), [expanded, setExpanded] = useState(false);
  const choose = (selected: File[] | FileList) => {
    const next = [...selected]; setError(''); setStatus('');
    if (!next.length) return;
    if (next.some(file => !isZip(file))) { setError('Choose a ZIP file (or ZIP files) from your Facebook Download Your Information export.'); return; }
    const deduped = [...new Map([...files, ...next].map(file => [`${file.name}:${file.size}:${file.lastModified}`, file])).values()]; setFiles(deduped);
  };
  const remove = (key: string) => setFiles(current => current.filter(file => `${file.name}:${file.size}:${file.lastModified}` !== key));
  const inspect = () => {
    if (!files.length) return;
    setBusy(true); setError(''); const worker = new Worker(new URL('../workers/import.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent<ImportProgress>) => { const message = event.data; if (message.type === 'progress') setStatus(message.message); if (message.type === 'error') { setError(message.message); setBusy(false); worker.terminate(); } if (message.type === 'result') { setBusy(false); worker.terminate(); if (!message.result.supported) { setError('These ZIPs do not look like a Facebook Download Your Information archive.'); return; } save(files, message.result); nav('/archive'); } };
    worker.onerror = () => { setError('The archive inspector stopped unexpectedly.'); setBusy(false); worker.terminate(); };
    worker.postMessage({ action: 'inspect', files });
  };
  const visibleFiles = expanded ? files : files.slice(0, 6);
  return <div className="landing"><header><Logo/><span><LockKeyhole size={15}/> Private by design</span></header><main><section className="intro"><div className="eyebrow"><ShieldCheck size={16}/> Your history, back in your hands</div><h1>Open your social archive.<br/><em>Keep it yours.</em></h1><p>Explore the memories, conversations, and connections in your Facebook archive—through a familiar, calm interface that runs entirely on your device.</p><div className="privacy-points"><div><ShieldCheck/><span><b>100% on-device</b><small>Your archive is never uploaded.</small></span></div><div><LockKeyhole/><span><b>No account required</b><small>No login, password, or access token.</small></span></div></div></section><section className="open-card"><div className="card-heading"><span><FileArchive/></span><div><h2>Open your Facebook archive</h2><p>Select one or all ZIP parts from your Download Your Information export.</p></div></div><div className={'dropzone '+(drag ? 'drag' : '')} onDragOver={event => { event.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)} onDrop={event => { event.preventDefault(); setDrag(false); choose(event.dataTransfer.files); }} onClick={() => input.current?.click()}><input ref={input} type="file" multiple accept=".zip,application/zip,application/x-zip-compressed" onChange={event => { if (event.target.files) choose(event.target.files); event.currentTarget.value = ''; }}/>{files.length ? <><FileArchive size={32}/><b>{files.length} ZIP part{files.length === 1 ? '' : 's'} selected</b><small>{format(files.reduce((sum, file) => sum + file.size, 0))} total · processed one part at a time</small><div className="selected-files" onClick={event => event.stopPropagation()}>{visibleFiles.map(file => <div className="selected-file" key={`${file.name}:${file.size}:${file.lastModified}`}><span title={file.name}>{file.name}</span><small>{format(file.size)}</small><button aria-label={`Remove ${file.name}`} onClick={() => remove(`${file.name}:${file.size}:${file.lastModified}`)}><X/></button></div>)}{files.length > 6 && <button className="text-button" onClick={() => setExpanded(value => !value)}>{expanded ? 'Show fewer parts' : `Show all ${files.length} parts`}</button>}</div><div className="selection-actions"><button className="text-button" onClick={event => { event.stopPropagation(); input.current?.click(); }}>Add more ZIP parts</button><button className="text-button" onClick={event => { event.stopPropagation(); setFiles([]); setExpanded(false); }}>Clear all</button></div></> : <><div className="upload-icon"><FileArchive/></div><b>Drop your archive parts here</b><span>or <u>choose one or more ZIP files</u></span><small>Facebook JSON exports work best</small></>}</div>{error && <p className="error" role="alert">{error}</p>}{status && !error && <p className="status">{status}</p>}<button className="primary" disabled={!files.length || busy} onClick={inspect}>{busy ? <LoaderCircle className="spin"/> : <>Inspect {files.length > 1 ? 'archive set' : 'archive'} <ArrowRight/></>}</button><p className="local-note"><LockKeyhole/> Your files stay in this browser. No upload occurs.</p></section></main><footer>Independent and not affiliated with Meta or Facebook.</footer></div>;
}
