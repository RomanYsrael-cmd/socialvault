import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Clock3, FileJson, Image as ImageIcon, LoaderCircle, MessageCircle } from 'lucide-react';
import { Link, useParams } from 'react-router-dom';
import { database } from '../database/client';
import type { Post } from '../archive/schemas/models';
import { MediaRenderer } from '../components/MediaRenderer';
import { MediaViewer } from '../components/MediaViewer';
import { PersonDisplay } from '../components/PersonDisplay';

const shownDate = (value?: string) => value ? new Date(value).toLocaleString() : 'Date unavailable in archive';
function ReactionSummary({ post }: { post: Post }) {
  const grouped = (post.reactions ?? []).reduce<Record<string, number>>((result, reaction) => { result[reaction.kind] = (result[reaction.kind] ?? 0) + 1; return result; }, {});
  const actors = (post.reactions ?? []).filter(reaction => reaction.personName).slice(0, 8);
  return <div className="reaction-summary"><div><div className="reaction-breakdown">{Object.entries(grouped).map(([kind, count]) => <span key={kind}>{kind} {count}</span>)}</div>{actors.length ? <div className="reaction-actors">{actors.map(reaction => reaction.personId ? <Link key={reaction.id} to={`/people/${encodeURIComponent(reaction.personId)}`}>{reaction.personName}</Link> : <span key={reaction.id}>{reaction.personName}</span>)}</div> : null}</div><b>{post.reactionCount ?? post.reactions?.length ?? 0} reactions</b></div>;
}
export function PostPage() {
  const { postId: routeId } = useParams(), postId = decodeURIComponent(routeId ?? '');
  const [post, setPost] = useState<Post>(), [loading, setLoading] = useState(true), [error, setError] = useState(''), [viewerIndex, setViewerIndex] = useState<number>(), [showAllComments, setShowAllComments] = useState(false);
  useEffect(() => { let active = true; setLoading(true); setError(''); database.post(postId).then(value => active && setPost(value)).catch(value => active && setError(value instanceof Error ? value.message : String(value))).finally(() => active && setLoading(false)); return () => { active = false; }; }, [postId]);
  const media = useMemo(() => post?.media ?? [], [post]);
  if (loading) return <div className="page"><p className="empty"><LoaderCircle className="spin"/> Loading post…</p></div>;
  if (error) return <div className="page"><p className="error">{error}</p></div>;
  if (!post) return <div className="page"><Link className="back" to="/home"><ArrowLeft/> Home</Link><p className="empty">This post is not available in the imported archive.</p></div>;
  const comments = showAllComments ? (post.comments ?? []) : (post.comments ?? []).slice(0, 12);
  return <div className="page"><Link className="back" to="/home"><ArrowLeft/> Home</Link><article className="post-detail-card"><div className="post-author-row"><PersonDisplay person={{ id: post.authorId, displayName: post.authorName || (post.authorId === 'owner' ? 'Archive owner' : 'Unknown author'), photoPath: post.authorPhotoPath }} context="Historical archive post"/><span className="post-detail-date"><Clock3/> {shownDate(post.createdAt)}</span></div>{post.title && <h1>{post.title}</h1>}<p className="post-detail-text">{post.text || 'This post has no text content.'}</p>{media.length ? <div className={`post-media-layout count-${Math.min(media.length, 5)}`}>{media.slice(0, 5).map((item, index) => <MediaRenderer key={item.id} media={item} onOpen={() => setViewerIndex(index)}/>) }{media.length > 5 && <span className="media-overflow">+{media.length - 5} more attachments</span>}</div> : null}<ReactionSummary post={post}/><section className="post-comments"><h2><MessageCircle/> Comments <span>{post.commentCount ?? post.comments?.length ?? 0}</span></h2>{comments.length ? <div className="comment-list rich">{comments.map(comment => <div key={comment.id}><PersonDisplay compact person={{ id: comment.authorId, displayName: comment.authorName }} context={comment.createdAt ? new Date(comment.createdAt).toLocaleDateString() : undefined}/><p>{comment.text}</p></div>)}</div> : <p className="empty-inline">No comments were included for this post.</p>}{(post.comments?.length ?? 0) > 12 && <button className="load-more" onClick={() => setShowAllComments(value => !value)}>{showAllComments ? 'Show fewer comments' : `Show all ${post.comments?.length} comments`}</button>}</section><footer><span><FileJson/> {post.source.path}</span><span><ImageIcon/> {post.mediaCount ?? media.length} media</span></footer></article>{viewerIndex !== undefined && <MediaViewer items={media} index={viewerIndex} onClose={() => setViewerIndex(undefined)} onChange={setViewerIndex}/>}</div>;
}
