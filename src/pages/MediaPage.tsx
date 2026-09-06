import { useEffect, useState } from 'react';
import { FileJson, Image as ImageIcon, LoaderCircle, Music, Paperclip, SlidersHorizontal, Video } from 'lucide-react';
import { database } from '../database/client';
import type { Media } from '../archive/schemas/models';
import type { Page } from '../database/types';
import { MediaRenderer } from '../components/MediaRenderer';
import { MediaViewer } from '../components/MediaViewer';

const icon: Record<Media['mediaType'], typeof ImageIcon> = { photo: ImageIcon, video: Video, audio: Music, file: Paperclip, unknown: Paperclip };
const date = (value?: string) => value ? new Date(value).toLocaleString() : 'Date unavailable';

export function MediaPage() {
  const [filter, setFilter] = useState<'all' | Media['mediaType']>('all');
  const [page, setPage] = useState<Page<Media>>({ items: [], hasMore: false });
  const [loading, setLoading] = useState(true), [loadingMore, setLoadingMore] = useState(false), [error, setError] = useState(''), [viewerIndex, setViewerIndex] = useState<number>();
  useEffect(() => { let active = true; setLoading(true); database.media({ limit: 30, mediaType: filter === 'all' ? undefined : filter }).then(next => active && setPage(next)).catch(caught => active && setError(caught instanceof Error ? caught.message : String(caught))).finally(() => active && setLoading(false)); return () => { active = false; }; }, [filter]);
  const loadMore = () => { if (!page.nextCursor || loadingMore) return; setLoadingMore(true); database.media({ limit: 30, cursor: page.nextCursor, mediaType: filter === 'all' ? undefined : filter }).then(next => setPage(current => ({ ...next, items: [...current.items, ...next.items] }))).catch(caught => setError(caught instanceof Error ? caught.message : String(caught))).finally(() => setLoadingMore(false)); };
  const previewable = page.items.filter(item => item.mediaType === 'photo' || item.mediaType === 'video' || item.mediaType === 'audio');
  const content = loading ? <p className="empty"><LoaderCircle className="spin"/> Loading media metadata…</p> : error ? <p className="error">{error}</p> : !page.items.length ? <p className="empty">No media metadata was found in supported posts or messages.</p> : (
    <>
      <div className="media-grid">
        {page.items.map(item => {
          const MediaIcon = icon[item.mediaType];
          const viewerPosition = previewable.findIndex(candidate => candidate.id === item.id);
          return <article key={item.id} className="media-card"><div className="media-card-preview">{item.mediaType === 'photo' || item.mediaType === 'video' || item.mediaType === 'audio' ? <MediaRenderer media={item} onOpen={() => viewerPosition >= 0 && setViewerIndex(viewerPosition)} compact/> : <span className="media-icon"><MediaIcon/></span>}</div><div className="media-card-body"><b>{item.filename || item.path.split('/').pop() || 'Unnamed media'}</b><small>{item.mediaType}{item.mimeType ? ` · ${item.mimeType}` : ''} · {date(item.timestamp)}</small>{item.caption && <p>{item.caption}</p>}<small title={item.source.path}><FileJson/> {item.source.path.split('/').pop()}</small></div></article>;
        })}
      </div>
      {page.hasMore && <button className="load-more" onClick={loadMore} disabled={loadingMore}>{loadingMore ? <><LoaderCircle className="spin"/> Loading more…</> : 'Load more media'}</button>}
    </>
  );
  return <div className="page"><div className="page-heading-row"><div><p className="eyebrow">Lazy local media · metadata only</p><h1 className="section-title">Photos & media</h1><p className="section-lead">Only the selected original entry is decompressed. No media blobs are copied into the database.</p></div><label className="filter-row media-filter"><SlidersHorizontal/> <select aria-label="Filter media" value={filter} onChange={event => setFilter(event.target.value as typeof filter)}><option value="all">All media</option><option value="photo">Images</option><option value="video">Video</option><option value="audio">Audio</option><option value="file">Files</option></select></label></div>{content}{viewerIndex !== undefined && <MediaViewer items={previewable} index={viewerIndex} onClose={() => setViewerIndex(undefined)} onChange={setViewerIndex}/>}</div>;
}
