import { useEffect, useState } from 'react';
import { Activity, CalendarDays, ChevronRight, Clock3, FileJson, LoaderCircle, Search } from 'lucide-react';
import { Link } from 'react-router-dom';
import { database } from '../database/client';
import type { ActivityRecord, ActivityType } from '../archive/schemas/models';
import type { ArchiveStats, Page } from '../database/types';
import { PersonDisplay } from '../components/PersonDisplay';

const labels: Record<'all' | ActivityType, string> = { all: 'All activity', post: 'Posts', comment: 'Comments', reaction: 'Reactions', message: 'Messages', connection: 'Connections', album: 'Albums', media: 'Photos & media', profile: 'Profile' };
const destination = (item: ActivityRecord) => {
  if (item.targetType === 'post' && item.targetId) return `/posts/${encodeURIComponent(item.targetId)}`;
  if (item.targetType === 'album' && item.targetId) return `/albums/${encodeURIComponent(item.targetId)}`;
  if (item.targetType === 'person' && item.targetId) return `/people/${encodeURIComponent(item.targetId)}`;
  if (item.targetType === 'conversation' && item.targetId) return `/messages/${encodeURIComponent(item.targetId)}`;
  if (item.targetType === 'profile') return '/profile';
  return item.type === 'media' ? '/photos' : item.type === 'connection' ? '/friends' : '/activity';
};
const date = (value: string) => new Date(value).toLocaleString();

export function ActivityPage() {
  const [type, setType] = useState<'all' | ActivityType>('all'), [year, setYear] = useState<number>(), [query, setQuery] = useState('');
  const [page, setPage] = useState<Page<ActivityRecord>>({ items: [], hasMore: false }), [stats, setStats] = useState<ArchiveStats>(), [loading, setLoading] = useState(true), [loadingMore, setLoadingMore] = useState(false), [error, setError] = useState('');
  useEffect(() => { database.stats().then(setStats).catch(() => undefined); }, []);
  useEffect(() => { let active = true; setLoading(true); setError(''); database.activity({ limit: 40, activityType: type === 'all' ? undefined : type, year, query: query.trim() }).then(next => active && setPage(next)).catch(value => active && setError(value instanceof Error ? value.message : String(value))).finally(() => active && setLoading(false)); return () => { active = false; }; }, [type, year, query]);
  const loadMore = () => { if (!page.nextCursor || loadingMore) return; setLoadingMore(true); database.activity({ limit: 40, activityType: type === 'all' ? undefined : type, year, query: query.trim(), cursor: page.nextCursor }).then(next => setPage(current => ({ ...next, items: [...current.items, ...next.items] }))).catch(value => setError(value instanceof Error ? value.message : String(value))).finally(() => setLoadingMore(false)); };
  return <div className="page activity-page"><div className="page-heading-row"><div><p className="eyebrow">Local history ledger</p><h1 className="section-title">Activity</h1><p className="section-lead">A date-ordered view of messages, posts, interactions, connections, albums, media, and profile changes.</p></div><Activity/></div><section className="panel activity-filters" aria-label="Filter activity"><label><Search/><span className="sr-only">Search activity</span><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Filter activity"/></label><label><CalendarDays/><span className="sr-only">Activity type</span><select value={type} onChange={event => setType(event.target.value as 'all' | ActivityType)}>{Object.entries(labels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label><label><span>Year</span><select aria-label="Filter activity by year" value={year ?? ''} onChange={event => setYear(event.target.value ? Number(event.target.value) : undefined)}><option value="">All years</option>{stats?.years.map(value => <option key={value} value={value}>{value}</option>)}</select></label></section>{loading ? <p className="empty"><LoaderCircle className="spin"/> Loading activity…</p> : error ? <p className="error">{error}</p> : !page.items.length ? <p className="empty">No activity records matched these filters.</p> : <><div className="activity-list">{page.items.map(item => <article className="activity-card" key={item.id}><span className={`activity-badge activity-${item.type}`}>{labels[item.type]}</span><div className="activity-card-body"><div className="activity-card-heading">{item.actorPersonId && <PersonDisplay compact person={{ id: item.actorPersonId, displayName: item.actorName }} /> }<time><Clock3/> {date(item.timestamp)}</time></div><p>{item.summary}</p><small><FileJson/> {item.source.path}</small></div><Link className="activity-target" to={destination(item)} aria-label={`Open ${item.targetType ?? item.type} record`}><ChevronRight/></Link></article>)}</div>{page.hasMore && <button className="load-more" onClick={loadMore} disabled={loadingMore}>{loadingMore ? <><LoaderCircle className="spin"/> Loading more…</> : 'Load more activity'}</button>}</>}<p className="privacy-note">The ledger is derived locally from normalized records and keeps source paths for auditability.</p></div>;
}
