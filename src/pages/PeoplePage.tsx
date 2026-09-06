import { useEffect, useState } from 'react';
import { ChevronRight, LoaderCircle, Search } from 'lucide-react';
import { Link } from 'react-router-dom';
import { database } from '../database/client';
import type { Page, PersonSummary } from '../database/types';
import { PersonDisplay } from '../components/PersonDisplay';
const PAGE_SIZE = 30;
export function PeoplePage() {
  const [query, setQuery] = useState('');
  const [page, setPage] = useState<Page<PersonSummary>>({ items: [], hasMore: false });
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { let active = true; const timer = window.setTimeout(() => { setLoading(true); database.people({ query: query.trim(), limit: PAGE_SIZE }).then(next => active && setPage(next)).catch(caught => active && setError(caught instanceof Error ? caught.message : String(caught))).finally(() => active && setLoading(false)); }, 250); return () => { active = false; window.clearTimeout(timer); }; }, [query]);
  const loadMore = () => { if (!page.nextCursor || loadingMore) return; setLoadingMore(true); database.people({ query: query.trim(), limit: PAGE_SIZE, cursor: page.nextCursor }).then(next => setPage(current => ({ ...next, items: [...current.items, ...next.items] }))).catch(caught => setError(caught instanceof Error ? caught.message : String(caught))).finally(() => setLoadingMore(false)); };
  return <div className="page"><div className="page-heading-row"><div><p className="eyebrow">Normalized identities</p><h1 className="section-title">People</h1><p className="section-lead">Names are kept separate unless the archive provides a stable identity key.</p></div><label className="search-field"><Search/><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Filter people" aria-label="Filter people"/></label></div>{loading ? <p className="empty"><LoaderCircle className="spin"/> Loading people…</p> : error ? <p className="error">{error}</p> : !page.items.length ? <p className="empty">No people were found in the imported archive.</p> : <><div className="people-list">{page.items.map(person => <Link key={person.id} to={`/people/${encodeURIComponent(person.id)}`}><PersonDisplay person={{ displayName: person.displayName, photoPath: person.profilePhotoPath }} /><span><b>{person.isArchiveOwner ? 'Archive owner' : person.relationship ?? 'Archive person'}</b><small>{person.messageCount} messages · {person.postCount} posts · {person.participationCount} conversations</small></span><ChevronRight/></Link>)}</div>{page.hasMore && <button className="load-more" onClick={loadMore} disabled={loadingMore}>{loadingMore ? <><LoaderCircle className="spin"/> Loading more…</> : 'Load more people'}</button>}</>}</div>;
}
