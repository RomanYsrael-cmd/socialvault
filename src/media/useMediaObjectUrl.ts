import { useEffect, useState } from 'react';
import type { Media } from '../archive/schemas/models';
import { objectUrlCache } from './object-url-cache';
import { database } from '../database/client';
export function useMediaObjectUrl(file: File | undefined, media: Media | undefined) {
  const [url, setUrl] = useState<string>();
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    setUrl(undefined); setError('');
    if (!file || !media || media.mediaType === 'file' || media.mediaType === 'unknown') return;
    objectUrlCache.acquire(file, media.path, media.mimeType).then(value => { void database.touchMedia(media.path); if (active) setUrl(value); }).catch(caught => active && setError(caught instanceof Error ? caught.message : String(caught)));
    return () => { active = false; objectUrlCache.releaseKey(file, media.path); };
  }, [file, media?.path, media?.mimeType, media?.mediaType]);
  return { url, error };
}
