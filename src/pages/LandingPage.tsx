import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { FileArchive, LockKeyhole, ShieldCheck, X, ArrowRight, LoaderCircle, FolderOpen } from 'lucide-react';
import { Logo } from '../components/Logo';
import type { ImportProgress } from '../workers/protocol';
import { useArchiveStore } from '../stores/archive';
import { discoverZipSources, directoryPicker } from '../archive/folder';
import { archiveSourceRegistry, type ArchiveSourceDescriptor } from '../archive/source-registry';
import { inspectArchiveSources } from '../archive/source-operations';

const format = (n: number) => n <= 0 ? 'size available during inspection' : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : n < 1024 * 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
const isZip = (file: File) => file.name.toLowerCase().endsWith('.zip') || file.type === 'application/zip' || file.type === 'application/x-zip-compressed';
const descriptorKey = (source: ArchiveSourceDescriptor) => source.key;

export function LandingPage() {
  const input = useRef<HTMLInputElement>(null), nav = useNavigate(), save = useArchiveStore(s => s.setArchive);
  const [sources, setSources] = useState<ArchiveSourceDescriptor[]>([]), [drag, setDrag] = useState(false), [status, setStatus] = useState(''), [folderStatus, setFolderStatus] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false), [expanded, setExpanded] = useState(false);
  const choose = (selected: File[] | FileList) => {
    const next = [...selected]; setError(''); setStatus(''); setFolderStatus('');
    if (!next.length) return;
    if (next.some(file => !isZip(file))) { setError('Choose a ZIP file (or ZIP files) from your Facebook Download Your Information export.'); return; }
    const descriptors = archiveSourceRegistry.registerFiles(next);
    setSources(current => [...current, ...descriptors.filter(candidate => !current.some(existing => descriptorKey(existing) === descriptorKey(candidate))) ]);
  };
  const chooseFolderFiles = (selected: FileList) => {
    const zips = [...selected].filter(isZip); setError(''); setStatus(''); setFolderStatus('');
    if (!zips.length) { setError('No ZIP files were found in that folder.'); return; }
    const descriptors = archiveSourceRegistry.registerFiles(zips);
    setSources(descriptors);
    setFolderStatus(`${descriptors.length} ZIP part${descriptors.length === 1 ? '' : 's'} discovered · ${format(descriptors.reduce((sum, source) => sum + source.size, 0))} total from the selected folder.`);
  };
  const chooseFolder = async () => {
    setError(''); setFolderStatus('');
    const picker = directoryPicker();
    if (picker) {
      try {
        const discovered = await discoverZipSources(await picker());
        if (!discovered.sources?.length) { setError('No ZIP files were found in that folder.'); return; }
        const descriptors = archiveSourceRegistry.registerHandles(discovered.sources);
        setSources(descriptors);
        setFolderStatus(`${descriptors.length} ZIP part${descriptors.length === 1 ? '' : 's'} discovered · sizes will be read lazily during inspection in ${discovered.rootName}${discovered.truncated ? ' (discovery was safely bounded)' : ''}.`);
      } catch (caught) { if ((caught as Error)?.name !== 'AbortError') setError(caught instanceof Error ? caught.message : 'The folder could not be opened.'); }
      return;
    }
    input.current?.setAttribute('webkitdirectory', ''); input.current?.click();
  };
  const remove = (key: string) => setSources(current => current.filter(source => descriptorKey(source) !== key));
  const clear = () => { archiveSourceRegistry.clear(); setSources([]); setExpanded(false); setStatus(''); setFolderStatus(''); };
  const inspect = async () => {
    if (!sources.length) return;
    setBusy(true); setError(''); setStatus('Inspecting selected archive parts locally…');
    try {
      const result = await inspectArchiveSources(sources, message => { if (message.type === 'progress') setStatus(message.message); });
      if (!result.supported) { setError(result.format === 'html' && result.sections.length ? 'Facebook HTML markers were found, but no supported structural pages were detected. Choose a complete export set and try again.' : result.format === 'mixed' ? 'This archive mixes Facebook JSON and HTML files, but no supported Facebook structure was detected.' : 'These ZIPs do not look like a supported Facebook Download Your Information archive.'); return; }
      save(result, archiveSourceRegistry.descriptors()); nav('/archive');
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'The archive inspector stopped unexpectedly.'); }
    finally { setBusy(false); }
  };
  const visibleSources = expanded ? sources : sources.slice(0, 6);
  const totalSize = sources.reduce((sum, source) => sum + source.size, 0);
  return <div className="landing"><header><Logo/><span><LockKeyhole size={15}/> Private by design</span></header><main><section className="intro"><div className="eyebrow"><ShieldCheck size={16}/> Your history, back in your hands</div><h1>Open your social archive.<br/><em>Keep it yours.</em></h1><p>Explore the memories, conversations, and connections in your Facebook archive—through a familiar, calm interface that runs entirely on your device.</p><div className="privacy-points"><div><ShieldCheck/><span><b>100% on-device</b><small>Your archive is never uploaded.</small></span></div><div><LockKeyhole/><span><b>No account required</b><small>No login, password, or access token.</small></span></div></div></section><section className="open-card"><div className="card-heading"><span><FileArchive/></span><div><h2>Open your Facebook archive</h2><p>Select one or all ZIP parts from a Facebook JSON or HTML export.</p></div></div><div className={'dropzone '+(drag ? 'drag' : '')} onDragOver={event => { event.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)} onDrop={event => { event.preventDefault(); setDrag(false); choose(event.dataTransfer.files); }} onClick={() => input.current?.click()}><input ref={input} type="file" multiple accept=".zip,application/zip,application/x-zip-compressed" onChange={event => { const folder = event.currentTarget.hasAttribute('webkitdirectory'); if (event.target.files) folder ? chooseFolderFiles(event.target.files) : choose(event.target.files); event.currentTarget.removeAttribute('webkitdirectory'); event.currentTarget.value = ''; }}/>{sources.length ? <><FileArchive size={32}/><b>{sources.length} ZIP part{sources.length === 1 ? '' : 's'} selected</b><small>{totalSize ? `${format(totalSize)} total` : 'ZIP sizes will be read during inspection'} · processed one part at a time</small><div className="selected-files" onClick={event => event.stopPropagation()}>{visibleSources.map(source => <div className="selected-file" key={source.key}><span title={source.name}>{source.name}</span><small>{format(source.size)}</small><button aria-label={`Remove ${source.name}`} onClick={() => remove(source.key)}><X/></button></div>)}{sources.length > 6 && <button className="text-button" onClick={() => setExpanded(value => !value)}>{expanded ? 'Show fewer parts' : `Show all ${sources.length} parts`}</button>}</div><div className="selection-actions"><button className="text-button" onClick={event => { event.stopPropagation(); input.current?.click(); }}>Add more ZIP parts</button><button className="text-button" onClick={event => { event.stopPropagation(); clear(); }}>Clear all</button></div></> : <><div className="upload-icon"><FileArchive/></div><b>Drop your archive parts here</b><span>or <u>choose one or more ZIP files</u></span><small>Facebook JSON and HTML exports supported · all parsing stays local</small></>}</div>{folderStatus && <p className="status">{folderStatus}</p>}{error && <p className="error" role="alert">{error}</p>}{status && !error && <p className="status">{status}</p>}<button className="secondary folder-button" type="button" onClick={chooseFolder}><FolderOpen/> Select archive folder</button><button className="primary" disabled={!sources.length || busy} onClick={inspect}>{busy ? <LoaderCircle className="spin"/> : <>Inspect {sources.length > 1 ? 'archive set' : 'archive'} <ArrowRight/></>}</button><p className="local-note"><LockKeyhole/> Your files stay in this browser. No upload occurs.</p></section></main><footer>Independent and not affiliated with Meta or Facebook.</footer></div>;
}
