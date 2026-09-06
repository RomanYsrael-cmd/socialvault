import { cleanArchivePath } from '../archive-set';
import { isSuspiciousPath } from '../security';

/**
 * Resolve a local href/src from a Facebook HTML export against the HTML file
 * that contains it.  Only archive-relative references are returned; remote
 * links, schemes, and traversal attempts are deliberately rejected.
 */
export function resolveArchiveRelativePath(sourcePath: string, reference?: string): string | undefined {
  if (!reference) return undefined;
  let value: string;
  try { value = decodeURIComponent(reference.trim()); } catch { return undefined; }
  if (!value || value.startsWith('//') || /^[a-z][a-z\d+.-]*:/i.test(value)) return undefined;
  value = value.split('#', 1)[0].split('?', 1)[0];
  if (!value) return undefined;
  const source = cleanArchivePath(sourcePath);
  const base = value.startsWith('/') ? [] : source.split('/').slice(0, -1);
  for (const segment of value.replaceAll('\\', '/').split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (!base.length) return undefined;
      base.pop();
      continue;
    }
    base.push(segment);
  }
  const resolved = cleanArchivePath(base.join('/'));
  if (!resolved || isSuspiciousPath(resolved)) return undefined;
  return resolved;
}

/** True for links that intentionally leave the local archive. */
export function isExternalHtmlReference(reference?: string): boolean {
  if (!reference) return false;
  const value = reference.trim();
  return value.startsWith('//') || /^[a-z][a-z\d+.-]*:/i.test(value);
}
