import { AlertCircle, FileText, LoaderCircle, Paperclip, Play, RotateCcw } from 'lucide-react';
import type { Media } from '../archive/schemas/models';
import { useArchiveStore } from '../stores/archive';
import { useMediaObjectUrl } from '../media/useMediaObjectUrl';

const readable = (media: Media) => media.filename || media.path.split('/').pop() || 'Unnamed file';
export function MediaRenderer({ media, onOpen, compact = false }: { media: Media; onOpen?: () => void; compact?: boolean }) {
  const file = useArchiveStore(state => state.file);
  const { url, error } = useMediaObjectUrl(file, media);
  const unavailable = !file ? 'Reconnect the matching archive to view this media.' : error || 'This media entry is unavailable.';
  if (media.mediaType === 'file' || media.mediaType === 'unknown') return <div className="media-generic"><FileText/><span><b>{readable(media)}</b><small>{media.mimeType || 'Unsupported preview type'} · metadata only</small></span></div>;
  if (!url) return <button type="button" className={`media-placeholder ${compact ? 'compact' : ''}`} onClick={onOpen} disabled={!file || !!error}><span>{error ? <AlertCircle/> : file ? <LoaderCircle className="spin"/> : <RotateCcw/>}</span><b>{error ? 'Media unavailable' : file ? 'Loading media…' : 'Reconnect archive'}</b><small>{unavailable}</small></button>;
  if (media.mediaType === 'photo') return <button type="button" className={`media-preview ${compact ? 'compact' : ''}`} onClick={onOpen} aria-label={`Open ${readable(media)}`}><img src={url} alt={media.caption || readable(media)} loading="lazy"/></button>;
  if (media.mediaType === 'video') return <div className={`media-player ${compact ? 'compact' : ''}`}><video src={url} controls preload="metadata" aria-label={readable(media)}/>{onOpen && <button type="button" className="media-open-button" onClick={onOpen}><Play/> Open viewer</button>}</div>;
  return <div className={`media-player ${compact ? 'compact' : ''}`}><audio src={url} controls preload="metadata" aria-label={readable(media)}/></div>;
}
