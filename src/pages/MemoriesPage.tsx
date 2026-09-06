import { useEffect, useMemo, useState } from 'react';
import { CalendarDays, ChevronLeft, ChevronRight, Clock3, LoaderCircle } from 'lucide-react';
import { Link } from 'react-router-dom';
import { database } from '../database/client';
import type { MemoryRecord } from '../database/types';

const monthNames = new Intl.DateTimeFormat(undefined, { month: 'long' });
const dayNames = new Intl.DateTimeFormat(undefined, { weekday: 'long' });
const dateFor = (month: number, day: number) => new Date(Date.UTC(2000, month - 1, day, 12));
const destination = (item: MemoryRecord) => {
  if (item.targetType === 'post' && item.targetId) return `/posts/${encodeURIComponent(item.targetId)}`;
  if (item.targetType === 'album' && item.targetId) return `/albums/${encodeURIComponent(item.targetId)}`;
  if (item.targetType === 'person' && item.targetId) return `/people/${encodeURIComponent(item.targetId)}`;
  if (item.targetType === 'profile') return '/profile';
  return item.targetType === 'media' ? '/photos' : '/activity';
};
const displayYear = (item: MemoryRecord) => item.yearsAgo === 0 ? 'This year' : `${item.yearsAgo} year${item.yearsAgo === 1 ? '' : 's'} ago`;

export function MemoriesPage() {
  const now = new Date();
  const [month, setMonth] = useState(now.getUTCMonth() + 1), [day, setDay] = useState(now.getUTCDate());
  const [items, setItems] = useState<MemoryRecord[]>([]), [loading, setLoading] = useState(true), [error, setError] = useState('');
  const selected = useMemo(() => dateFor(month, day), [month, day]);
  useEffect(() => { let active = true; setLoading(true); setError(''); database.memories(month, day, { limit: 80 }).then(next => active && setItems(next)).catch(value => active && setError(value instanceof Error ? value.message : String(value))).finally(() => active && setLoading(false)); return () => { active = false; }; }, [month, day]);
  const move = (delta: number) => { const next = new Date(Date.UTC(2000, month - 1, day + delta, 12)); setMonth(next.getUTCMonth() + 1); setDay(next.getUTCDate()); };
  const groups = items.reduce<Map<number, MemoryRecord[]>>((result, item) => { const group = result.get(item.calendarYear) ?? []; group.push(item); result.set(item.calendarYear, group); return result; }, new Map());
  const inputValue = `2000-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return <div className="page memories-page"><div className="page-heading-row"><div><p className="eyebrow">On this day · local SQLite history</p><h1 className="section-title">Memories</h1><p className="section-lead">Revisit dated records from your imported archive. Nothing is fetched from Facebook.</p></div><CalendarDays/></div><section className="panel memory-controls" aria-label="Choose a memory date"><button type="button" className="icon-button" onClick={() => move(-1)} aria-label="Previous day"><ChevronLeft/></button><div><b>{dayNames.format(selected)}</b><span>{monthNames.format(selected)} {day}</span></div><label><span className="sr-only">Memory date</span><input type="date" value={inputValue} min="2000-01-01" max="2000-12-31" onChange={event => { const [, nextMonth, nextDay] = event.target.value.split('-').map(Number); if (nextMonth && nextDay) { setMonth(nextMonth); setDay(nextDay); } }}/></label><button type="button" className="icon-button" onClick={() => move(1)} aria-label="Next day"><ChevronRight/></button></section>{loading ? <p className="empty"><LoaderCircle className="spin"/> Looking for memories…</p> : error ? <p className="error">{error}</p> : !items.length ? <p className="empty">No dated records were found for {monthNames.format(selected)} {day}.</p> : <div className="memory-list">{[...groups.entries()].map(([year, records]) => <section className="memory-year" key={year}><h2>{year} <small>{displayYear(records[0])}</small></h2>{records.map(item => <Link className="memory-card" key={item.id} to={destination(item)}><span className="memory-type">{item.type}</span><span><b>{item.summary}</b><small><Clock3/> {new Date(item.timestamp).toLocaleString()}</small><small className="memory-source">{item.source.path}</small></span><ChevronRight/></Link>)}</section>)}</div>}<p className="privacy-note">Memories are derived from timestamps already stored in this browser.</p></div>;
}
