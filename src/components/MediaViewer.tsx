import { useEffect } from 'react';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import type { Media } from '../archive/schemas/models';
import { MediaRenderer } from './MediaRenderer';

export function MediaViewer({ items, index, onClose, onChange }: { items: Media[]; index: number; onClose: () => void; onChange: (index: number) => void }) {
  const media = items[index];
  useEffect(() => { const handler = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); if (event.key === 'ArrowLeft' && index > 0) onChange(index - 1); if (event.key === 'ArrowRight' && index < items.length - 1) onChange(index + 1); }; window.addEventListener('keydown', handler); return () => window.removeEventListener('keydown', handler); }, [index, items.length, onClose, onChange]);
  if (!media) return null;
  return <div className="media-viewer" role="dialog" aria-modal="true" aria-label="Media viewer" onClick={event => { if (event.target === event.currentTarget) onClose(); }}><div className="media-viewer-card"><button type="button" className="viewer-close" onClick={onClose} aria-label="Close media viewer"><X/></button>{index > 0 && <button type="button" className="viewer-nav prev" onClick={() => onChange(index - 1)} aria-label="Previous media"><ChevronLeft/></button>}<div className="viewer-content"><MediaRenderer media={media} compact/><div className="viewer-meta"><b>{media.filename || media.path.split('/').pop() || 'Media'}</b><small>{media.mediaType}{media.mimeType ? ` · ${media.mimeType}` : ''}{media.timestamp ? ` · ${new Date(media.timestamp).toLocaleString()}` : ''}</small><small>Source: {media.source.path}</small></div></div>{index < items.length - 1 && <button type="button" className="viewer-nav next" onClick={() => onChange(index + 1)} aria-label="Next media"><ChevronRight/></button>}</div></div>;
}
