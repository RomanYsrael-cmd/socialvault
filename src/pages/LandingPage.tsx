import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { FileArchive, LockKeyhole, ShieldCheck, X, ArrowRight, LoaderCircle, FolderOpen } from 'lucide-react';
import { Logo } from '../components/Logo';
import type { ImportProgress } from '../workers/protocol';
import { useArchiveStore } from '../stores/archive';
import { discoverZipFiles, directoryPicker } from '../archive/folder';

const format = (n: number) => n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : n < 1024 * 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
const isZip = (file: File) => file.name.toLowerCase().endsWith('.zip') || file.type === 'application/zip' || file.type === 'application/x-zip-compressed';
const fileKey = (file: File) => `${file.name}:${file.size}:${file.lastModified}`;

export function LandingPage() {
  const input = useRef<HTMLInputElement>(null), nav = useNavigate(), save = useArchiveStore(s => s.setArchive);
  const [files, setFiles] = useState<File[]>([]), [drag, setDrag] = useState(false), [status, setStatus] = useState(''), [folderStatus, setFolderStatus] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false), [expanded, setExpanded] = useState(false);
  const choose = (selected: File[] | FileList) => {
    const next = [...selected]; setError(''); setStatus(''); setFolderStatus('');
    if (!next.length) return;
    if (next.some(file => !isZip(file))) { setError('Choose a ZIP file (or ZIP files) from your Facebook Download Your Information export.'); return; }
    const deduped = [...new Map([...files, ...next].map(file => [`${file.name}:${file.size}:${file.lastModified}`, file])).values()]; setFiles(deduped);
  };
  const chooseFolderFiles = (selected: FileList) => {
    const zips = [...selected].filter(isZip);
    setError(''); setStatus(''); setFolderStatus('');
    if (!zips.length) { setError('No ZIP files were found in that folder.'); return; }
    const deduped = [...new Map(zips.map(file => [fileKey(file), file])).values()];
    setFiles(deduped); setFolderStatus(`${deduped.length} ZIP part${deduped.length === 1 ? '' : 's'} discovered · ${format(deduped.reduce((sum, file) => sum + file.size, 0))} total from the selected folder.`);
  };
  const chooseFolder = async () => {
    setError(''); setFolderStatus('');
    const picker = directoryPicker();
    if (picker) {
      try { const discovered = await discoverZipFiles(await picker()); if (!discovered.files.length) { setError('No ZIP files were found in that folder.'); return; } setFiles(discovered.files); setFolderStatus(`${discovered.files.length} ZIP part${discovered.files.length === 1 ? '' : 's'} discovered · ${format(discovered.files.reduce((sum, file) => sum + file.size, 0))} total in ${discovered.rootName}${discovered.truncated ? ' (discovery was safely bounded)' : ''}.`); } catch (caught) { if ((caught as Error)?.name !== 'AbortError') setError(caught instanceof Error ? caught.message : 'The folder could not be opened.'); }
      return;
    }
    input.current?.setAttribute('webkitdirectory', ''); input.current?.click();
  };
  const remove = (key: string) => setFiles(current => current.filter(file => `${file.name}:${file.size}:${file.lastModified}` !== key));
  const inspect = () => {
    if (!files.length) return;
    setBusy(true); setError(''); const worker = new Worker(new URL('../workers/import.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent<ImportProgress>) => { const message = event.data; if (message.type === 'progress') setStatus(message.message); if (message.type === 'error') { setError(message.message); setBusy(false); worker.terminate(); } if (message.type === 'result') { setBusy(false); worker.terminate(); if (!message.result.supported) { setError(message.result.format === 'html' && message.result.sections.length ? 'This looks like a Facebook HTML export. SocialVault currently imports Facebook JSON exports; request your information in JSON format and try again.' : message.result.format === 'mixed' ? 'This archive mixes Facebook JSON and HTML files. Select the JSON export parts to import them locally.' : 'These ZIPs do not look like a supported Facebook Download Your Information archive.'); return; } save(files, message.result); nav('/archive'); } };
    worker.onerror = () => { setError('The archive inspector stopped unexpectedly.'); setBusy(false); worker.terminate(); };
    worker.postMessage({ action: 'inspect', files });
  };
  const visibleFiles = expanded ? files : files.slice(0, 6);
  return <div className="landing"><header><Logo/><span><LockKeyhole size={15}/> Private by design</span></header><main><section className="intro"><div className="eyebrow"><ShieldCheck size={16}/> Your history, back in your hands</div><h1>Open your social archive.<br/><em>Keep it yours.</em></h1><p>Explore the memories, conversations, and connections in your Facebook archive—through a familiar, calm interface that runs entirely on your device.</p><div className="privacy-points"><div><ShieldCheck/><span><b>100% on-device</b><small>Your archive is never uploaded.</small></span></div><div><LockKeyhole/><span><b>No account required</b><small>No login, password, or access token.</small></span></div></div></section><section className="open-card"><div className="card-heading"><span><FileArchive/></span><div><h2>Open your Facebook archive</h2><p>Select one or all ZIP parts from a Facebook JSON export.</p></div></div><div className={'dropzone '+(drag ? 'drag' : '')} onDragOver={event => { event.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)} onDrop={event => { event.preventDefault(); setDrag(false); choose(event.dataTransfer.files); }} onClick={() => input.current?.click()}><input ref={input} type="file" multiple accept=".zip,application/zip,application/x-zip-compressed" onChange={event => { const folder = event.currentTarget.hasAttribute('webkitdirectory'); if (event.target.files) folder ? chooseFolderFiles(event.target.files) : choose(event.target.files); event.currentTarget.removeAttribute('webkitdirectory'); event.currentTarget.value = ''; }}/>{files.length ? <><FileArchive size={32}/><b>{files.length} ZIP part{files.length === 1 ? '' : 's'} selected</b><small>{format(files.reduce((sum, file) => sum + file.size, 0))} total · processed one part at a time</small><div className="selected-files" onClick={event => event.stopPropagation()}>{visibleFiles.map(file => <div className="selected-file" key={fileKey(file)}><span title={file.name}>{file.name}</span><small>{format(file.size)}</small><button aria-label={`Remove ${file.name}`} onClick={() => remove(fileKey(file))}><X/></button></div>)}{files.length > 6 && <button className="text-button" onClick={() => setExpanded(value => !value)}>{expanded ? 'Show fewer parts' : `Show all ${files.length} parts`}</button>}</div><div className="selection-actions"><button className="text-button" onClick={event => { event.stopPropagation(); input.current?.click(); }}>Add more ZIP parts</button><button className="text-button" onClick={event => { event.stopPropagation(); setFiles([]); setExpanded(false); }}>Clear all</button></div></> : <><div className="upload-icon"><FileArchive/></div><b>Drop your archive parts here</b><span>or <u>choose one or more ZIP files</u></span><small>Facebook JSON exports only · HTML exports are detected as unsupported</small></>}</div>{folderStatus && <p className="status">{folderStatus}</p>}{error && <p className="error" role="alert">{error}</p>}{status && !error && <p className="status">{status}</p>}<button className="secondary folder-button" type="button" onClick={chooseFolder}><FolderOpen/> Select archive folder</button><button className="primary" disabled={!files.length || busy} onClick={inspect}>{busy ? <LoaderCircle className="spin"/> : <>Inspect {files.length > 1 ? 'archive set' : 'archive'} <ArrowRight/></>}</button><p className="local-note"><LockKeyhole/> Your files stay in this browser. No upload occurs.</p></section></main><footer>Independent and not affiliated with Meta or Facebook.</footer></div>;
}
