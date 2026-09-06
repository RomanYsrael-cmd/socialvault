import { useEffect, useMemo, useState } from 'react';
import { AtSign, CalendarDays, ExternalLink, FileJson, MessageCircle, UserRound } from 'lucide-react';
import { Link, useParams } from 'react-router-dom';
import { database } from '../database/client';
import type { Media, Post } from '../archive/schemas/models';
import type { PersonSummary, Page } from '../database/types';
import { facebookProfileTarget } from '../archive/security';
import { MediaRenderer } from '../components/MediaRenderer';

const date = (value?: string) => value ? new Date(value).toLocaleDateString() : '—';
export function PersonPage() {
  const { personId } = useParams();
  const id = decodeURIComponent(personId ?? '');
  const [person, setPerson] = useState<PersonSummary>();
  const [posts, setPosts] = useState<Page<Post>>({ items: [], hasMore: false });
  const [error, setError] = useState('');
  useEffect(() => { let active = true; setError(''); database.person(id).then(value => { if (active) setPerson(value); }).catch(errorValue => active && setError(errorValue instanceof Error ? errorValue.message : String(errorValue))); database.posts({ personId: id, limit: 5 }).then(value => active && setPosts(value)).catch(() => undefined); return () => { active = false; }; }, [id]);
  const external = useMemo(() => person && facebookProfileTarget(person), [person]);
  const profileMedia = person?.profilePhotoPath ? [{ id: `profile-photo:${person.id}`, path: person.profilePhotoPath, mediaType: 'photo' as const, ownerType: 'post' as const, ownerId: person.id, source: { platform: 'facebook', path: person.identitySource ?? 'profile' } } satisfies Media] : undefined;
  if (error) return <div className="page"><p className="error">{error}</p></div>;
  if (!person) return <div className="page"><p className="empty">Loading person…</p></div>;
  return <div className="page"><Link className="back" to={person.isArchiveOwner ? '/profile' : '/people'}>← People</Link><section className="person-hero"><div className="person-avatar">{profileMedia ? <MediaRenderer media={profileMedia[0]} compact/> : <UserRound/>}</div><div className="person-heading"><p className="eyebrow">{person.isArchiveOwner ? 'Archive owner' : 'Archive person'}</p><h1 className="section-title">{person.displayName}</h1>{person.username && <p><AtSign/> {person.username}</p>}{person.facebookId && <small>Facebook ID {person.facebookId}</small>}{external && <a className="external-link" href={external.url} target="_blank" rel="noreferrer">{external.kind === 'exact' ? 'View exact Facebook profile' : 'Search this name on Facebook'} <ExternalLink/></a>}</div></section><div className="person-stats"><div><b>{person.messageCount}</b><span>Messages</span></div><div><b>{person.postCount}</b><span>Posts</span></div><div><b>{person.commentCount}</b><span>Comments</span></div><div><b>{person.reactionCount}</b><span>Reactions</span></div><div><b>{person.connectionCount}</b><span>Connections</span></div><div><b>{person.albumCount}</b><span>Albums</span></div><div><b>{person.sharedPostCount}</b><span>Shared posts</span></div><div><b>{person.sharedMediaCount}</b><span>Shared media</span></div><div><b>{person.mediaCount}</b><span>Media</span></div><div><b>{person.participationCount}</b><span>Conversations</span></div></div><section className="panel interaction-panel"><h2>Archive context</h2><p><CalendarDays/> First seen {date(person.firstInteraction)} · Last seen {date(person.lastInteraction)}</p><p><FileJson/> Identity confidence: {person.identityConfidence ?? 'unknown'}{person.identitySource ? ` · ${person.identitySource}` : ''}</p>{person.sourcePaths?.length ? <small>Source files: {person.sourcePaths.slice(0, 4).join(', ')}{person.sourcePaths.length > 4 ? ` and ${person.sourcePaths.length - 4} more` : ''}</small> : null}</section>{person.messageCount > 0 && <section className="panel"><h2><MessageCircle/> Conversations</h2><p>Messages involving this person are available in the Messenger archive.</p><Link className="text-link" to="/messages">Open conversations →</Link></section>}<section className="panel"><h2>Related posts</h2>{posts.items.length ? <div className="related-posts">{posts.items.map(post => <Link className="related-post-link" key={post.id} to={`/posts/${encodeURIComponent(post.id)}`}><b>{post.title || 'Post'}</b><p>{post.text || 'No text content'}</p><small>{date(post.createdAt)}</small></Link>)}</div> : <p className="empty-inline">No posts linked to this person.</p>}</section></div>;
}
