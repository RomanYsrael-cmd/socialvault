import { useEffect, useState } from 'react';
import { ArrowLeft, Image, LoaderCircle } from 'lucide-react';
import { Link, useParams } from 'react-router-dom';
import { database } from '../database/client';
import type { AlbumDetail } from '../database/types';
import { MediaRenderer } from '../components/MediaRenderer';
import { MediaViewer } from '../components/MediaViewer';
export function AlbumPage() {
  const { albumId } = useParams(), [detail, setDetail] = useState<AlbumDetail>(), [index, setIndex] = useState<number>(), [error, setError] = useState('');
  useEffect(() => { let active = true; database.album(decodeURIComponent(albumId ?? '')).then(value => active && setDetail(value)).catch(value => active && setError(value instanceof Error ? value.message : String(value))); return () => { active = false; }; }, [albumId]);
  if (error) return <div className="page"><p className="error">{error}</p></div>;
  if (!detail) return <div className="page"><p className="empty"><LoaderCircle className="spin"/> Loading album…</p></div>;
  return <div className="page"><Link className="back" to="/albums"><ArrowLeft/> Albums</Link><div className="page-heading-row"><div><p className="eyebrow">Album</p><h1 className="section-title">{detail.album.title}</h1><p className="section-lead">{detail.album.description || `${detail.media.length} media item${detail.media.length === 1 ? '' : 's'}`}</p></div><Image/></div><div className="album-media-grid">{detail.media.map((media, mediaIndex) => <figure key={media.id}><MediaRenderer media={media} onOpen={() => setIndex(mediaIndex)}/><figcaption>{media.filename || media.path.split('/').pop() || media.path}</figcaption></figure>)}</div>{index !== undefined && <MediaViewer items={detail.media} index={index} onClose={() => setIndex(undefined)} onChange={setIndex}/>}</div>;
}
