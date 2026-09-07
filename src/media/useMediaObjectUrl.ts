import { useEffect, useState } from 'react';
import type { Media } from '../archive/schemas/models';
import { archiveSourceRegistry } from '../archive/source-registry';
import { objectUrlCache } from './object-url-cache';
import { database } from '../database/client';

export function useMediaObjectUrl(media: Media | undefined, sourceVersion?: unknown) {
  const [url, setUrl] = useState<string>();
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    setUrl(undefined); setError('');
    if (!media || media.mediaType === 'file' || media.mediaType === 'unknown') return;
    const partId = media.source.archivePartId;
    if (!partId) { setError('Reconnect the matching archive to view this media.'); return; }
    let file: File | undefined;
    void archiveSourceRegistry.materialize(partId).then(materialized => {
      if (!active) return;
      file = materialized;
      if (!file) { setError('Archive part not connected.'); return; }
      return objectUrlCache.acquire(file, media.path, media.mimeType, partId).then(value => { void database.touchMedia(media.path); if (active) setUrl(value); });
    }).catch(caught => { if (active) setError(caught instanceof Error ? caught.message : String(caught)); });
    return () => { active = false; if (file) objectUrlCache.releaseKey(file, media.path, partId); };
  }, [media?.path, media?.mimeType, media?.mediaType, media?.source.archivePartId, sourceVersion]);
  return { url, error };
}
