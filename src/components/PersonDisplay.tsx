import { Link } from 'react-router-dom';
import type { Media } from '../archive/schemas/models';
import { MediaRenderer } from './MediaRenderer';

export type PersonDisplayValue = { id?: string; displayName?: string; photoPath?: string };
const initials = (name: string) => name.trim().split(/\s+/).slice(0, 2).map(part => part[0]?.toUpperCase()).join('') || '?';
export function PersonDisplay({ person, context, compact = false }: { person: PersonDisplayValue; context?: string; compact?: boolean }) {
  const name = person.displayName || 'Unknown person';
  const media = person.photoPath ? { id: `person-photo:${person.id ?? name}`, path: person.photoPath, mediaType: 'photo' as const, ownerType: 'post' as const, ownerId: person.id ?? name, source: { platform: 'facebook', path: 'profile' } } satisfies Media : undefined;
  const content = <><span className={`person-avatar-mini ${compact ? 'compact' : ''}`}>{media ? <MediaRenderer media={media} compact/> : initials(name)}</span><span className="person-display-copy"><b>{name}</b>{context && <small>{context}</small>}</span></>;
  return person.id ? <Link className="person-display" to={`/people/${encodeURIComponent(person.id)}`}>{content}</Link> : <span className="person-display">{content}</span>;
}
