import { useEffect, useState } from 'react';
import { AtSign, CalendarDays, ExternalLink, FileJson, UserRound } from 'lucide-react';
import { Link } from 'react-router-dom';
import { database } from '../database/client';
import type { PersonSummary } from '../database/types';
import type { Profile } from '../archive/schemas/models';
import { facebookProfileTarget } from '../archive/security';
import { useDatabaseQuery } from './useDatabaseQuery';
export function ProfilePage() {
  const { data: profile, loading, error } = useDatabaseQuery(() => database.profile());
  const [person, setPerson] = useState<PersonSummary>();
  useEffect(() => { if (profile) database.person(profile.personId).then(setPerson).catch(() => undefined); }, [profile]);
  return <div className="page"><p className="eyebrow">Normalized archive</p><h1 className="section-title">Profile</h1>{loading ? <p className="empty">Loading local profile…</p> : error ? <p className="error">{error}</p> : !profile ? <p className="empty">No supported profile metadata was imported.</p> : <ProfileCard profile={profile} person={person}/>}</div>;
}
function ProfileCard({ profile: p, person }: { profile: Profile; person?: PersonSummary }) {
  const target = facebookProfileTarget(p);
  return <><section className="profile-card"><div className="avatar"><UserRound/></div><div><h2>{p.displayName}</h2>{p.username && <p><AtSign/> {p.username}</p>}{p.facebookId && <p>Facebook ID {p.facebookId}</p>}{p.relationship && <p>{p.relationship}</p>}{p.joinedAt && <p><CalendarDays/> Joined {new Date(p.joinedAt).toLocaleDateString()}</p>}{p.bio && <blockquote>{p.bio}</blockquote>}<small><FileJson/> Source: {p.source.path}</small><div className="profile-actions"><Link className="text-link" to={`/people/${encodeURIComponent(p.personId)}`}>Open archive profile →</Link>{target && <a className="external-link" href={target.url} target="_blank" rel="noreferrer">{target.kind === 'exact' ? 'View exact Facebook profile' : 'Search this name on Facebook'} <ExternalLink/></a>}</div></div></section>{p.facts?.length ? <section className="panel about-panel"><h2>About</h2><div className="about-grid">{p.facts.map(fact => <div key={fact.id}><small>{fact.category}{fact.label ? ` · ${fact.label}` : ''}</small><p>{fact.value}</p>{(fact.startDate || fact.endDate) && <small>{fact.startDate ? new Date(fact.startDate).toLocaleDateString() : '—'} – {fact.endDate ? new Date(fact.endDate).toLocaleDateString() : 'present'}</small>}</div>)}</div></section> : null}{person && <div className="person-stats"><div><b>{person.messageCount}</b><span>Messages</span></div><div><b>{person.postCount}</b><span>Posts</span></div><div><b>{person.commentCount}</b><span>Comments</span></div><div><b>{person.reactionCount}</b><span>Reactions</span></div><div><b>{person.mediaCount}</b><span>Media</span></div><div><b>{person.participationCount}</b><span>Conversations</span></div></div>}</>;
}
