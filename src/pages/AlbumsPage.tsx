import { useEffect, useState } from 'react';
import { Image, LoaderCircle, Search } from 'lucide-react';
import { Link } from 'react-router-dom';
import { database } from '../database/client';
import type { AlbumSummary, Page } from '../database/types';
export function AlbumsPage() {
  const [query, setQuery] = useState(''), [page, setPage] = useState<Page<AlbumSummary>>({ items: [], hasMore: false }), [loading, setLoading] = useState(true), [error, setError] = useState('');
  useEffect(() => { let active = true; setLoading(true); database.albums({ query, limit: 40 }).then(next => active && setPage(next)).catch(value => active && setError(value instanceof Error ? value.message : String(value))).finally(() => active && setLoading(false)); return () => { active = false; }; }, [query]);
  return <div className="page"><div className="page-heading-row"><div><p className="eyebrow">Local media</p><h1 className="section-title">Albums</h1><p className="section-lead">Albums and their media memberships, indexed without uploading files.</p></div><Image/></div><label className="search-control"><Search/><input aria-label="Search albums" value={query} onChange={event => setQuery(event.target.value)} placeholder="Search albums"/></label>{loading ? <p className="empty"><LoaderCircle className="spin"/> Loading albums…</p> : error ? <p className="error">{error}</p> : !page.items.length ? <p className="empty">No albums were found in this archive.</p> : <div className="album-grid">{page.items.map(album => <Link className="album-card" key={album.id} to={`/albums/${encodeURIComponent(album.id)}`}><div className="album-placeholder"><Image/></div><h2>{album.title}</h2><p>{album.mediaCount} media item{album.mediaCount === 1 ? '' : 's'}</p>{album.createdAt && <small>{new Date(album.createdAt).toLocaleDateString()}</small>}</Link>)}</div>}</div>;
}
