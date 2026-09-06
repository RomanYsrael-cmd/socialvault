import { useEffect, useState } from 'react';
import type { Media } from '../archive/schemas/models';
import { objectUrlCache } from './object-url-cache';
import { database } from '../database/client';
export function useMediaObjectUrl(files: File | Record<string, File> | undefined, media: Media | undefined) {
  const [url, setUrl] = useState<string>();
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    setUrl(undefined); setError('');
    if (!files || !media || media.mediaType === 'file' || media.mediaType === 'unknown') return;
    const registry = files instanceof File ? undefined : files;
    const file = media.source.archivePartId ? registry?.[media.source.archivePartId] : files instanceof File ? files : Object.values(registry ?? {})[0];
    if (!file) { setError(media.source.archivePartId ? 'Archive part not connected.' : 'Reconnect the matching archive to view this media.'); return; }
    objectUrlCache.acquire(file, media.path, media.mimeType, media.source.archivePartId).then(value => { void database.touchMedia(media.path); if (active) setUrl(value); }).catch(caught => active && setError(caught instanceof Error ? caught.message : String(caught)));
    return () => { active = false; objectUrlCache.releaseKey(file, media.path, media.source.archivePartId); };
  }, [files, media?.path, media?.mimeType, media?.mediaType, media?.source.archivePartId]);
  return { url, error };
}
