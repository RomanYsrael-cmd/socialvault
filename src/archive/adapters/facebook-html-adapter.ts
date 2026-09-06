import { Tokenizer } from 'parse5';
import { hashText } from '../archive-set';
import { safeExternalUrl, safeFacebookUrl, isSuspiciousPath } from '../security';
import type { Album, Comment, Connection, Conversation, Media, Message, NormalizedArchiveData, Person, Post, Profile, ProfileFact, Reaction, SourceRef } from '../schemas/models';
import { isExternalHtmlReference, resolveArchiveRelativePath } from './html-path';
import { FACEBOOK_PARSER_VERSION } from './version';

/** HTML export parser limits. They keep malformed pages from becoming an
 * accidental unbounded-memory workload while preserving ordinary exports. */
// A twenty-thousand-record acknowledgement keeps the parser responsive while
// avoiding hundreds of thousands of worker round trips for large Messenger
// exports. The queue is still bounded: records are released as soon as the
// database acknowledges each batch, and text fields are individually capped.
export const HTML_RECORD_BATCH_SIZE = 20_000;
const MAX_TEXT = 100_000;
const MAX_MEDIA_PER_RECORD = 100;
const MAX_ALBUM_MEDIA_REFERENCES = 10_000;
const MAX_STACK_DEPTH = 2_048;

type Attr = { name: string; value: string };
type TokenTag = { tagName: string; attrs: Attr[]; selfClosing?: boolean };
type TokenCharacter = { chars: string };
type Row = { label: string; value: string };
type MediaRef = { path: string; mediaType: Media['mediaType']; filename?: string; caption?: string };
type Card = {
  ordinal: number;
  depth: number;
  heading?: string;
  headingClass?: string;
  body?: string;
  dateText?: string;
  datetime?: string;
  allText: string;
  media: MediaRef[];
  links: string[];
  attrs: Record<string, string>;
  profileHref?: string;
};
type Frame = {
  tag: string;
  classes: string;
  attrs: Attr[];
  text: string;
  capture?: 'heading' | 'body' | 'date' | 'h1' | 'th' | 'td' | 'time';
  card?: Card;
  row?: Row;
  href?: string;
};

export interface HtmlParserOptions {
  /** Called with bounded normalized batches while parsing a large entry. */
  onBatch?: (data: NormalizedArchiveData) => Promise<void> | void;
  /** Called between output batches/chunks so a worker can stop promptly. */
  checkCancelled?: () => void;
  /** Override the input chunk size for deterministic tests. */
  chunkSize?: number;
}

export interface HtmlParseResult extends NormalizedArchiveData {
  recordCount: number;
  maxBufferedRecords: number;
  parsed: boolean;
}

const emptyData = (): NormalizedArchiveData => ({ people: [], profileFacts: [], posts: [], comments: [], reactions: [], connections: [], albums: [], conversations: [], messages: [], media: [], warnings: [] });
const cleanText = (value: string | undefined) => (value ?? '').replace(/\s+/g, ' ').trim();
const attr = (token: TokenTag, name: string) => token.attrs.find(item => item.name.toLowerCase() === name.toLowerCase())?.value;
const classes = (token: TokenTag) => attr(token, 'class') ?? '';
const hasClass = (value: string, needle: string) => value.split(/\s+/).some(item => item === needle);
const bounded = (value: string, limit = MAX_TEXT) => value.length > limit ? `${value.slice(0, limit)}…` : value;
const sourceFor = (path: string, index?: number): SourceRef => ({ platform: 'facebook', path, index });
const mediaTypeFor = (path: string, tag?: string): Media['mediaType'] => {
  const lower = path.toLowerCase();
  if (tag === 'video' || /\.(?:mp4|mov|m4v|webm|avi|mkv)(?:$|[?#])/i.test(lower)) return 'video';
  if (tag === 'audio' || /\.(?:mp3|m4a|wav|ogg|aac)(?:$|[?#])/i.test(lower)) return 'audio';
  if (/\.(?:jpe?g|png|gif|webp|heic|avif|bmp)(?:$|[?#])/i.test(lower)) return 'photo';
  return 'unknown';
};
const isVoid = (tag: string) => ['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'].includes(tag);
const isHtmlPath = (path: string) => path.toLowerCase().endsWith('.html') || path.toLowerCase().endsWith('.htm');
const normalizePath = (path: string) => path.replaceAll('\\', '/').replace(/^\/+/, '');
const hasPathSegment = (path: string, segment: string) => path.startsWith(`${segment}/`) || path.includes(`/${segment}/`);
const messageFolder = (path: string) => {
  const match = normalizePath(path).match(/\/messages\/(?:inbox|archived_threads|filtered_threads|message_requests|marketplace_messages|marketplace|thread_requests|e2ee_cutover)\/([^/]+)\//i);
  return match?.[1] ?? normalizePath(path).split('/').slice(-2, -1)[0] ?? 'messages';
};
const connectionTypeFor = (path: string): Connection['type'] => {
  const value = path.toLowerCase();
  if (value.includes('removed_friends')) return 'removed_friend';
  if (value.includes('followers')) return 'follower';
  if (value.includes('following') || value.includes('who_you')) return 'following';
  if (value.includes('received') && value.includes('request')) return 'incoming_request';
  if ((value.includes('sent') || value.includes('outgoing')) && value.includes('request')) return 'outgoing_request';
  if (value.includes('blocked')) return 'blocked';
  if (value.includes('friend')) return 'friend';
  return 'unknown';
};
const categoryForFact = (label: string) => {
  const value = label.toLowerCase();
  if (value.includes('work') || value.includes('employ')) return 'work';
  if (value.includes('school') || value.includes('education') || value.includes('university')) return 'education';
  if (value.includes('live') || value.includes('place') || value.includes('hometown')) return 'places_lived';
  if (value.includes('relationship') || value.includes('married')) return 'relationship';
  if (value.includes('language')) return 'languages';
  if (value.includes('bio') || value.includes('about')) return 'bio';
  if (value.includes('username') || value.includes('profile')) return 'profile';
  return 'other';
};
const monthNumber = (value: string) => {
  const month = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'].findIndex(item => item.startsWith(value.toLowerCase()));
  return month < 0 ? undefined : month + 1;
};
const parseDate = (value?: string) => {
  const text = cleanText(value);
  if (!text) return undefined;
  const candidate = text.replace(/[\u202f\u00a0]/g, ' ').replace(/\s+at\s+/gi, ' ');
  const iso = candidate.match(/\b(\d{4}-\d{2}-\d{2}(?:[T ][^\s]+)?)\b/);
  if (iso) { const timestamp = Date.parse(iso[1]); if (Number.isFinite(timestamp)) return new Date(timestamp).toISOString(); }
  // Facebook's HTML renderer commonly uses “Month D, YYYY” or “D Month
  // YYYY”.  Restrict Date.parse to those explicit forms; arbitrary text must
  // not be mistaken for a timestamp.
  const monthDay = candidate.match(/\b([A-Za-z]{3,9})\s+(\d{1,2}),\s+(\d{4})\b/);
  const dayMonth = candidate.match(/\b(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{4})\b/);
  // Date.parse treats timezone-less human dates as local midnight. Facebook
  // renders these dates as archive facts, so interpret them at UTC midnight
  // (and preserve an explicit UTC/GMT offset when one is present) to keep
  // Memories calendar days stable across browser locales.
  if (!/(?:\b(?:UTC|GMT)\b|\bZ\b|[+-]\d{2}:?\d{2})/i.test(candidate)) {
    const parts = monthDay ? { month: monthNumber(monthDay[1]), day: Number(monthDay[2]), year: Number(monthDay[3]), start: monthDay.index! + monthDay[0].length } : dayMonth ? { month: monthNumber(dayMonth[2]), day: Number(dayMonth[1]), year: Number(dayMonth[3]), start: dayMonth.index! + dayMonth[0].length } : undefined;
    if (parts?.month) {
      const time = candidate.slice(parts.start).match(/^\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?/i);
      let hour = Number(time?.[1] ?? 0); const minute = Number(time?.[2] ?? 0); const second = Number(time?.[3] ?? 0); const meridiem = time?.[4]?.toLowerCase();
      if (meridiem === 'pm' && hour < 12) hour += 12; if (meridiem === 'am' && hour === 12) hour = 0;
      const timestamp = Date.UTC(parts.year, parts.month - 1, parts.day, hour, minute, second); if (Number.isFinite(timestamp)) return new Date(timestamp).toISOString();
    }
  }
  if (monthDay || dayMonth) {
    const timestamp = Date.parse(candidate); if (Number.isFinite(timestamp)) return new Date(timestamp).toISOString();
  }
  return undefined;
};
const externalProfile = (value?: string) => value ? safeFacebookUrl(value) : undefined;

function personFromIdentity(displayName: string, href: string | undefined, sourcePath: string, identityScope = sourcePath): Person {
  const profileUrl = externalProfile(href);
  let facebookId: string | undefined;
  let username: string | undefined;
  if (profileUrl) {
    try {
      const url = new URL(profileUrl);
      const id = url.searchParams.get('id');
      if (id && /^\d+$/.test(id)) facebookId = id;
      const pieces = url.pathname.split('/').filter(Boolean);
      if (!facebookId && pieces.length === 1 && !['profile.php', 'people'].includes(pieces[0].toLowerCase())) username = pieces[0];
      if (!facebookId && pieces[0]?.toLowerCase() === 'people' && pieces[1]) username = pieces[1];
    } catch { /* safeFacebookUrl already validated the URL */ }
  }
  const seed = facebookId ? `id:${facebookId}` : username ? `username:${username.toLowerCase()}` : `name:${cleanText(displayName).toLowerCase()}|scope:${identityScope}`;
  return { id: `person:facebook:html:${hashText(seed)}`, displayName: cleanText(displayName) || 'Unknown person', facebookId, username, profileUrl, identityConfidence: facebookId || username ? 'exact' : 'inferred', identitySource: sourcePath, sourcePaths: [sourcePath] };
}

class StreamingFacebookHtmlParser {
  private readonly tokenizer: Tokenizer;
  private readonly path: string;
  private readonly options: HtmlParserOptions;
  private readonly retainRecords: boolean;
  private readonly data = emptyData();
  private readonly batch = emptyData();
  private readonly stack: Frame[] = [];
  private readonly cards: Card[] = [];
  private readonly people = new Map<string, Person>();
  private readonly albumMedia: MediaRef[] = [];
  private readonly rows: Row[] = [];
  private pageTitle = '';
  private pageTime?: string;
  private profileHref?: string;
  private cardOrdinal = 0;
  private row?: Row;
  private paused = false;
  private batchRecords = 0;
  private totalRecords = 0;
  private maxBuffered = 0;
  private readonly sectionRecordCounts: Record<string, number> = {};
  private readonly conversationRecords = new Map<string, Conversation>();
  private warningSet = new Set<string>();
  private parseErrors = 0;

  constructor(path: string, options: HtmlParserOptions = {}) {
    this.path = normalizePath(path);
    this.options = options;
    this.retainRecords = !options.onBatch;
    this.tokenizer = new Tokenizer({}, {
      onComment: () => undefined,
      onDoctype: () => undefined,
      onStartTag: token => this.startTag(token),
      onEndTag: token => this.endTag(token),
      onCharacter: token => this.character(token),
      onWhitespaceCharacter: token => this.character(token),
      onNullCharacter: token => this.character(token),
      onEof: () => this.eof(),
      onParseError: () => { this.parseErrors++; },
    });
  }

  get result(): HtmlParseResult {
    if (this.parseErrors) this.warn(`${this.path}: malformed HTML tokens were skipped`);
    const conversationMap = new Map<string, Conversation>();
    for (const conversation of this.data.conversations) {
      const prior = conversationMap.get(conversation.id);
      if (!prior) conversationMap.set(conversation.id, { ...conversation, participantIds: [...conversation.participantIds], participantNames: [...conversation.participantNames] });
      else { prior.participantIds = [...new Set([...prior.participantIds, ...conversation.participantIds])]; prior.participantNames = [...new Set([...prior.participantNames, ...conversation.participantNames])]; if (!prior.title && conversation.title) prior.title = conversation.title; }
    }
    const output: HtmlParseResult = { ...this.data, conversations: [...conversationMap.values()], recordCount: this.totalRecords, maxBufferedRecords: this.maxBuffered, parsed: this.totalRecords > 0 || this.isCandidatePath() };
    output.diagnostics = { candidateFiles: this.isCandidatePath() ? 1 : 0, parsedFiles: this.isCandidatePath() ? 1 : 0, unsupportedCandidates: this.data.warnings.filter(item => item.includes('unsupported')).length, malformedFiles: this.parseErrors ? 1 : 0, missingMedia: 0, incompleteIdentities: output.people.filter(person => !person.facebookId && !person.username && !person.profileUrl).length, detectedSections: this.detectedSections() };
    output.importedSections = this.importedSections();
    output.coverage = { detectedSections: this.detectedSections(), importedSections: output.importedSections ?? [], partialSections: this.data.warnings.length ? output.importedSections ?? [] : [], unsupportedSections: [], malformedSections: [], skippedParts: [] };
    return output;
  }

  async feed(text: string, isLastChunk = false) {
    this.options.checkCancelled?.();
    this.tokenizer.write(text, isLastChunk);
    while (this.paused) {
      await this.flushBatch();
      this.options.checkCancelled?.();
      this.paused = false;
      this.tokenizer.resume();
    }
    this.options.checkCancelled?.();
  }

  async finish() {
    // A caller that fed no final chunk still gets EOF and album/profile
    // finalization. Tokenizer.write(..., true) is idempotent for our output.
    await this.feed('', true);
    await this.flushBatch();
    this.finalizePageRecords();
    await this.flushBatch();
  }

  private isCandidatePath() {
    const value = this.path.toLowerCase();
    return value.includes('profile_information') || value.includes('profile_v2') || value.includes('personal_information') || hasPathSegment(value, 'posts') || value.includes('your_posts') || hasPathSegment(value, 'messages') || value.includes('connections/') || value.includes('comment') || value.includes('reaction') || value.includes('likes_and_reactions') || value.includes('/album') || value.includes('albums') || value.includes('your_photos') || value.includes('your_videos');
  }

  private detectedSections() {
    const value = this.path.toLowerCase();
    const sections: string[] = [];
    if (value.includes('profile_information') || value.includes('profile_v2') || value.includes('personal_information')) sections.push('Profile');
    if (hasPathSegment(value, 'posts') || value.includes('your_posts')) sections.push('Posts');
    if (hasPathSegment(value, 'messages')) sections.push('Messages');
    if (value.includes('connections/')) sections.push('Friends');
    if (value.includes('comment')) sections.push('Comments');
    if (value.includes('reaction') || value.includes('likes_and_reactions')) sections.push('Reactions');
    if (value.includes('/album') || value.includes('albums') || value.includes('your_photos') || value.includes('your_videos')) sections.push('Albums', 'Photos');
    return [...new Set(sections)];
  }

  private importedSections() {
    const sections = this.detectedSections();
    return sections.filter(section => {
      if (section === 'Profile') return !!this.data.profile;
      if (section === 'Posts') return (this.sectionRecordCounts.Posts ?? 0) > 0;
      if (section === 'Messages') return (this.sectionRecordCounts.Messages ?? 0) > 0;
      if (section === 'Friends') return (this.sectionRecordCounts.Friends ?? 0) > 0;
      if (section === 'Comments') return (this.sectionRecordCounts.Comments ?? 0) > 0;
      if (section === 'Reactions') return (this.sectionRecordCounts.Reactions ?? 0) > 0;
      if (section === 'Albums') return (this.sectionRecordCounts.Albums ?? 0) > 0;
      if (section === 'Photos') return (this.sectionRecordCounts.Photos ?? 0) > 0;
      return false;
    });
  }

  private appendText(frame: Frame, chars: string) { frame.text = bounded(frame.text + chars); }
  private character(token: TokenCharacter) {
    const chars = token.chars;
    // Script/style/template contents are untrusted implementation details, not
    // archive records. Tokenizing them is harmless, but never let their text
    // fall through into a card's normalized body.
    const inRawText = this.stack.some(frame => frame.tag === 'script' || frame.tag === 'style' || frame.tag === 'template');
    if (!inRawText) for (const frame of this.stack) if (frame.capture) this.appendText(frame, chars);
    const card = this.cards.at(-1);
    if (card && !inRawText) card.allText = bounded(card.allText + chars);
  }

  private startTag(token: TokenTag) {
    const tag = token.tagName.toLowerCase();
    const className = classes(token);
    const frame: Frame = { tag, classes: className, attrs: token.attrs, text: '' };
    if (tag === 'section' && hasClass(className, '_a6-g') && this.stack.length < MAX_STACK_DEPTH) {
      const card: Card = { ordinal: this.cardOrdinal++, depth: this.stack.length + 1, allText: '', media: [], links: [], attrs: {} };
      for (const item of token.attrs) if (item.name.toLowerCase().startsWith('data-')) card.attrs[item.name.toLowerCase().slice(5)] = item.value;
      frame.card = card; this.cards.push(card);
    }
    if (tag === 'h1') frame.capture = 'h1';
    if (tag === 'h2') frame.capture = 'heading';
    if (tag === 'time') { frame.capture = 'time'; const datetime = attr(token, 'datetime'); if (datetime) { this.pageTime = datetime; const card = this.cards.at(-1); if (card) card.datetime = datetime; } }
    if (hasClass(className, '_a6-p')) frame.capture = 'body';
    if (hasClass(className, '_a72d')) frame.capture = 'date';
    if (tag === 'th') frame.capture = 'th';
    if (tag === 'td') frame.capture = 'td';
    if (tag === 'tr') { frame.row = { label: '', value: '' }; this.row = frame.row; }
    if (tag === 'a') {
      frame.href = attr(token, 'href') ?? attr(token, 'data-href');
      if (frame.href) {
        this.profileHref ??= externalProfile(frame.href);
        const card = this.cards.at(-1); if (card) { card.links.push(frame.href); if (externalProfile(frame.href)) card.profileHref ??= frame.href; }
      }
    }
    const ref = tag === 'img' ? attr(token, 'src') ?? attr(token, 'data-src') : tag === 'video' || tag === 'audio' || tag === 'source' ? attr(token, 'src') : undefined;
    if (ref) this.addMedia(this.cards.at(-1), ref, tag);
    if (token.selfClosing || isVoid(tag)) this.closeFrame(frame);
    else if (this.stack.length >= MAX_STACK_DEPTH) this.warn(`${this.path}: HTML nesting depth limit reached; deeper markup skipped`);
    else this.stack.push(frame);
  }

  private endTag(token: TokenTag) {
    const tag = token.tagName.toLowerCase();
    let index = this.stack.length - 1;
    while (index >= 0 && this.stack[index].tag !== tag) index--;
    if (index < 0) return;
    while (this.stack.length - 1 >= index) this.closeFrame(this.stack.pop()!);
  }

  private closeFrame(frame: Frame) {
    const text = cleanText(frame.text);
    if (frame.capture === 'h1' && text) this.pageTitle = this.pageTitle || text;
    if (frame.capture === 'time' && text) { this.pageTime = frame.attrs.find(item => item.name.toLowerCase() === 'datetime')?.value ?? text; const cardForTime = this.cards.at(-1); if (cardForTime) cardForTime.dateText = text; }
    const card = this.cards.at(-1);
    if (card && frame.capture === 'heading' && text) { card.heading = card.heading || text; card.headingClass = frame.classes; }
    if (card && frame.capture === 'body' && text) card.body = cleanText([card.body, text].filter(Boolean).join(' '));
    if (card && frame.capture === 'date' && text) card.dateText = card.dateText || text;
    if (frame.capture === 'th' && this.row) this.row.label = cleanText([this.row.label, text].filter(Boolean).join(' '));
    if (frame.capture === 'td' && this.row) this.row.value = cleanText([this.row.value, text].filter(Boolean).join(' '));
    if (frame.tag === 'tr' && frame.row) { if (frame.row.label || frame.row.value) this.rows.push(frame.row); if (this.row === frame.row) this.row = undefined; }
    if (frame.tag === 'a' && frame.href) {
      const cardForLink = this.cards.at(-1);
      if (cardForLink && !cardForLink.profileHref && externalProfile(frame.href)) cardForLink.profileHref = frame.href;
    }
    if (frame.card) {
      const cardIndex = this.cards.lastIndexOf(frame.card);
      if (cardIndex >= 0) this.cards.splice(cardIndex, 1);
      this.emitCard(frame.card);
    }
  }

  private addMedia(card: Card | undefined, reference: string, tag: string) {
    const path = resolveArchiveRelativePath(this.path, reference);
    if (!path) {
      if (isSuspiciousPath(reference)) this.warn(`${this.path}: suspicious HTML media reference skipped`);
      return;
    }
    const item: MediaRef = { path, mediaType: mediaTypeFor(path, tag), filename: path.split('/').at(-1) };
    if (card) { if (card.media.length < MAX_MEDIA_PER_RECORD) card.media.push(item); }
    else if (this.path.toLowerCase().includes('album') || this.path.toLowerCase().includes('your_photos') || this.path.toLowerCase().includes('your_videos')) {
      if (this.albumMedia.length < MAX_ALBUM_MEDIA_REFERENCES) this.albumMedia.push(item);
      else this.warn(`${this.path}: album media reference limit reached; remaining references skipped`);
    }
  }

  private warn(value: string) { if (this.warningSet.has(value)) return; this.warningSet.add(value); this.data.warnings.push(value); }
  private source(index: number) { return sourceFor(this.path, index); }
  private person(displayName: string, href?: string) {
    // Messenger chunks do not always link a sender to a profile. Scope that
    // cautious name fallback to the exported thread folder so the same sender
    // remains stable across message_N.html files without merging same-name
    // people from unrelated conversations.
    const scope = hasPathSegment(this.path.toLowerCase(), 'messages') ? `messages:${messageFolder(this.path).toLowerCase()}` : this.path;
    const person = personFromIdentity(displayName, href, this.path, scope);
    const existing = this.people.get(person.id);
    if (existing) { existing.sourcePaths = [...new Set([...(existing.sourcePaths ?? []), this.path])]; return existing; }
    this.people.set(person.id, person); this.push('people', person); return person;
  }
  private archiveOwner(displayName: string, href?: string) {
    const existing = this.people.get('owner');
    if (existing) return existing;
    const owner = personFromIdentity(displayName, href, this.path); owner.id = 'owner'; owner.identityConfidence = 'exact'; owner.isArchiveOwner = true; owner.sourcePaths = [this.path];
    this.people.set('owner', owner); this.push('people', owner); return owner;
  }
  private conversationId() { return `conversation:facebook:html:${hashText(`folder:${messageFolder(this.path).toLowerCase()}`)}`; }
  private emitConversation(title: string | undefined, participant?: Person) {
    const id = this.conversationId();
    const names = participant?.displayName ? [participant.displayName] : [];
    const ids = participant?.id ? [participant.id] : [];
    const prior = this.conversationRecords.get(id);
    if (!prior) {
      const conversation: Conversation = { id, title: cleanText(title) || undefined, participantIds: ids, participantNames: names, source: this.source(0) };
      this.conversationRecords.set(id, conversation);
      this.push('conversations', conversation);
      return;
    }
    let changed = false;
    if (!prior.title && title) { prior.title = cleanText(title) || undefined; changed = true; }
    if (participant && !prior.participantIds.includes(participant.id)) { prior.participantIds.push(participant.id); changed = true; }
    if (participant?.displayName && !prior.participantNames.includes(participant.displayName)) { prior.participantNames.push(participant.displayName); changed = true; }
    // Emit only when a new participant/title was discovered. Messenger pages
    // contain one section per message; sending the same conversation row for
    // every message would turn a 100k-message file into an avoidable N² DB
    // merge workload.
    if (changed) this.push('conversations', { ...prior, participantIds: [...prior.participantIds], participantNames: [...prior.participantNames] });
  }

  private emitCard(card: Card) {
    const path = this.path.toLowerCase();
    const date = parseDate(card.datetime) ?? parseDate(card.dateText);
    const heading = cleanText(card.heading);
    const body = cleanText(card.body) || cleanText(card.allText.replace(card.heading ?? '', '').replace(card.dateText ?? '', ''));
    const href = card.profileHref ?? card.links.find(item => externalProfile(item));
    if (hasPathSegment(path, 'messages')) {
      if (!heading || !hasClass(card.headingClass ?? '', '_a6-i')) { if (heading) this.emitConversation(heading); return; }
      const sender = this.person(heading, href); this.emitConversation(this.pageTitle || undefined, sender);
      const id = `message:facebook:html:${hashText(`${this.path}:${card.ordinal}`)}`;
      const media = card.media.map((item, index) => this.mediaFor(item, 'message', id, index));
      const message: Message = { id, conversationId: this.conversationId(), senderId: sender.id, senderName: sender.displayName, text: body || undefined, sentAt: date, mediaCount: media.length, media, source: this.source(card.ordinal) };
      this.push('messages', message); media.forEach(item => this.push('media', item));
      return;
    }
    if (path.includes('connections/')) {
      if (!heading) return;
      const person = this.person(heading, href);
      const connection: Connection = { id: `connection:facebook:html:${hashText(`${this.path}:${card.ordinal}`)}`, personId: person.id, displayName: person.displayName, facebookId: person.facebookId, username: person.username, profileUrl: person.profileUrl, type: connectionTypeFor(this.path), startedAt: date, source: this.source(card.ordinal) };
      this.push('connections', connection); return;
    }
    if (path.includes('comment')) {
      const postId = card.attrs['post-id'] ?? (card.attrs['target-type'] === 'post' ? card.attrs['target-id'] : undefined);
      if (!postId || !body) { this.warn(`${this.path}: comment target or text was not structurally identified`); return; }
      const authorName = card.attrs['comment-author'] ?? card.attrs.actor ?? heading;
      const author = this.person(authorName || 'Unknown person', href);
      const comment: Comment = { id: `comment:facebook:html:${hashText(`${this.path}:${card.ordinal}:${postId}:${body}`)}`, postId, authorId: author.id, authorName: author.displayName, text: body, createdAt: date, source: this.source(card.ordinal) };
      this.push('comments', comment); return;
    }
    if (path.includes('reaction') || path.includes('likes_and_reactions')) {
      const targetId = card.attrs['target-id'] ?? (card.attrs['target-type'] === 'post' ? card.attrs['post-id'] : undefined);
      const kind = card.attrs['reaction-type'] ?? card.attrs.reaction ?? card.attrs.kind;
      if (!targetId || !kind) { this.warn(`${this.path}: reaction target or type was not structurally identified`); return; }
      const actorName = card.attrs.actor ?? card.attrs['actor-name'] ?? heading;
      const actor = actorName ? this.person(actorName, href) : undefined;
      const reaction: Reaction = { id: `reaction:facebook:html:${hashText(`${this.path}:${card.ordinal}:${targetId}:${kind}:${actorName ?? ''}`)}`, targetType: card.attrs['target-type'] === 'post' || card.attrs['target-type'] === 'comment' ? card.attrs['target-type'] : 'post', targetId, personId: actor?.id, personName: actor?.displayName, kind, createdAt: date, source: this.source(card.ordinal) };
      this.push('reactions', reaction); return;
    }
    if (path.includes('/album') || path.includes('albums') || path.includes('your_photos') || path.includes('your_videos')) {
      card.media.forEach((item, index) => this.albumMedia.push({ ...item, caption: body || undefined }));
      return;
    }
    if (path.includes('/posts/') || path.includes('your_posts')) {
      const owner = path.includes('your_posts') || path.includes('your_facebook_activity/posts');
      const author = heading ? (owner ? this.archiveOwner(heading, href) : this.person(heading, href)) : undefined;
      const id = `post:facebook:html:${hashText(`${this.path}:${card.ordinal}`)}`;
      const media = card.media.map((item, index) => this.mediaFor(item, 'post', id, index));
      const links = [...new Set(card.links.map(link => isExternalHtmlReference(link) ? safeExternalUrl(link) : resolveArchiveRelativePath(this.path, link)).filter((link): link is string => !!link))];
      const post: Post = { id, authorId: owner ? 'owner' : author?.id, authorName: heading || author?.displayName, title: heading || undefined, text: body || undefined, createdAt: date, links, mediaCount: media.length, commentCount: this.countLabel(card.allText, 'comment'), reactionCount: this.countLabel(card.allText, 'reaction'), media, source: this.source(card.ordinal) };
      this.push('posts', post); media.forEach(item => this.push('media', item));
      this.extractInlineInteractions(card, id, date);
    }
  }

  private countLabel(text: string, label: string) { const match = text.match(new RegExp(`(?:${label}s?|reactions?)\\s*[:·-]?\\s*(\\d+)`, 'i')) ?? text.match(new RegExp(`(\\d+)\\s+${label}s?`, 'i')); return match ? Number(match[1]) : 0; }
  private extractInlineInteractions(card: Card, postId: string, date?: string) {
    const reactionKind = card.attrs['reaction-type'] ?? card.attrs['reaction'];
    const actor = card.attrs.actor ?? card.attrs['actor-name'];
    if (reactionKind && actor) { const person = this.person(actor, card.profileHref); const reaction: Reaction = { id: `reaction:facebook:html:${hashText(`${this.path}:${card.ordinal}:${reactionKind}:${actor}`)}`, targetType: 'post', targetId: postId, personId: person.id, personName: person.displayName, kind: reactionKind, createdAt: date, source: this.source(card.ordinal) }; this.push('reactions', reaction); }
    const commentText = card.attrs.comment ?? card.attrs['comment-text'];
    if (commentText) { const name = card.attrs['comment-author'] ?? 'Unknown person'; const person = this.person(name); const comment: Comment = { id: `comment:facebook:html:${hashText(`${this.path}:${card.ordinal}:${commentText}`)}`, postId, authorId: person.id, authorName: person.displayName, text: cleanText(commentText), createdAt: date, source: this.source(card.ordinal) }; this.push('comments', comment); }
  }

  private mediaFor(item: MediaRef, ownerType: Media['ownerType'], ownerId: string, index: number): Media { return { id: `media:facebook:html:${hashText(`${this.path}:${ownerId}:${index}:${item.path}`)}`, path: item.path, mediaType: item.mediaType, filename: item.filename, caption: item.caption, ownerType, ownerId, source: this.source(index) }; }

  private finalizePageRecords() {
    const path = this.path.toLowerCase();
    if (path.includes('profile_information') || path.includes('profile_v2') || path.includes('personal_information')) {
      const name = this.rows.find(row => /^(name|full name|profile name)$/i.test(row.label))?.value || this.pageTitle;
      if (name) {
        const owner = personFromIdentity(name, this.profileHref, this.path); owner.id = 'owner'; owner.isArchiveOwner = true; owner.identityConfidence = 'exact'; owner.sourcePaths = [this.path];
        this.people.set(owner.id, owner); this.push('people', owner);
        const facts: ProfileFact[] = this.rows.filter(row => row.value && !/^(name|full name|profile name)$/i.test(row.label)).map((row, index) => ({ id: `profile-fact:facebook:html:${hashText(`${this.path}:${index}:${row.label}`)}`, category: categoryForFact(row.label), label: row.label, value: row.value, source: this.source(index) }));
        const joinedFact = facts.find(fact => /registration|joined|created/i.test(fact.label ?? ''));
        const profile: Profile = { id: `profile:facebook:html:${hashText(this.path)}`, personId: 'owner', displayName: name, profileUrl: owner.profileUrl, username: owner.username, facebookId: owner.facebookId, bio: facts.find(fact => fact.category === 'bio')?.value, joinedAt: parseDate(joinedFact?.value), relationship: facts.find(fact => fact.category === 'relationship')?.value, facts, source: this.source(0) };
        this.data.profile = profile; this.data.profileFacts.push(...facts);
        return;
      }
      this.warn(`${this.path}: profile table did not contain a recognizable name`);
    }
    if (path.includes('/album') || path.includes('albums') || path.includes('your_photos') || path.includes('your_videos')) {
      const title = this.pageTitle || this.rows.find(row => /^(album|title|name)$/i.test(row.label))?.value || this.path.split('/').at(-1)?.replace(/\.(?:html?|json)$/i, '') || 'Facebook album';
      const albumId = `album:facebook:html:${hashText(this.path)}`;
      const media = [...new Map(this.albumMedia.map(item => [item.path, item])).values()].map((item, index) => this.mediaFor(item, 'album', albumId, index));
      const album: Album = { id: albumId, title: cleanText(title), ownerId: 'owner', mediaIds: media.map(item => item.id), source: this.source(0) };
      this.push('albums', album); media.forEach(item => this.push('media', item));
    }
  }

  private eof() { while (this.stack.length) this.closeFrame(this.stack.pop()!); }

  private push<K extends keyof Pick<NormalizedArchiveData, 'people' | 'profileFacts' | 'posts' | 'comments' | 'reactions' | 'connections' | 'albums' | 'conversations' | 'messages' | 'media'>>(key: K, value: NonNullable<NormalizedArchiveData[K]>[number]) {
    if (this.retainRecords) (this.data[key] as unknown as unknown[]).push(value);
    (this.batch[key] as unknown as unknown[]).push(value);
    this.totalRecords++; this.batchRecords++; this.maxBuffered = Math.max(this.maxBuffered, this.batchRecords);
    const lowerPath = this.path.toLowerCase();
    const section = hasPathSegment(lowerPath, 'messages') ? 'Messages' : lowerPath.includes('connections/') ? 'Friends' : lowerPath.includes('comment') ? 'Comments' : lowerPath.includes('reaction') || lowerPath.includes('likes_and_reactions') ? 'Reactions' : lowerPath.includes('/album') || lowerPath.includes('albums') ? 'Albums' : lowerPath.includes('your_photos') || lowerPath.includes('your_videos') ? 'Photos' : hasPathSegment(lowerPath, 'posts') || lowerPath.includes('your_posts') ? 'Posts' : undefined;
    if (section) this.sectionRecordCounts[section] = (this.sectionRecordCounts[section] ?? 0) + 1;
    if (this.options.onBatch && this.batchRecords >= HTML_RECORD_BATCH_SIZE) { this.tokenizer.pause(); this.paused = true; }
  }

  private async flushBatch() {
    if (!this.options.onBatch || !this.batchRecords) return;
    const next = { ...emptyData(), people: this.batch.people.splice(0), profileFacts: this.batch.profileFacts.splice(0), posts: this.batch.posts.splice(0), comments: this.batch.comments.splice(0), reactions: this.batch.reactions.splice(0), connections: this.batch.connections.splice(0), albums: this.batch.albums.splice(0), conversations: this.batch.conversations.splice(0), messages: this.batch.messages.splice(0), media: this.batch.media.splice(0) };
    this.batchRecords = 0;
    await this.options.onBatch(next);
  }
}

/** Parse a complete HTML string. Tests and small files use this convenience;
 * production import uses parseFacebookHtmlEntry below to avoid materializing
 * a ZIP entry as one string. */
export async function parseFacebookHtmlDocument(html: string, sourcePath: string, options: HtmlParserOptions = {}): Promise<HtmlParseResult> {
  const parser = new StreamingFacebookHtmlParser(sourcePath, options);
  const chunkSize = Math.max(1, options.chunkSize ?? 64 * 1024);
  for (let offset = 0; offset < html.length; offset += chunkSize) await parser.feed(html.slice(offset, offset + chunkSize), false);
  await parser.finish();
  return parser.result;
}

export interface HtmlEntryLike { getData(writer: WritableStream<Uint8Array>): Promise<unknown> }

/** Stream a ZIP entry through TextDecoder and parse5. zip.js writes bounded
 * Uint8Array chunks to the WritableStream; no full HTML string is retained. */
export async function parseFacebookHtmlEntry(entry: HtmlEntryLike, sourcePath: string, options: HtmlParserOptions = {}): Promise<HtmlParseResult> {
  const parser = new StreamingFacebookHtmlParser(sourcePath, options);
  const decoder = new TextDecoder('utf-8', { fatal: false });
  await entry.getData(new WritableStream<Uint8Array>({
    write: async chunk => {
      options.checkCancelled?.();
      await parser.feed(decoder.decode(chunk, { stream: true }), false);
    },
    close: async () => {
      const tail = decoder.decode();
      if (tail) await parser.feed(tail, false);
      await parser.finish();
    },
  }));
  return parser.result;
}

export const facebookHtmlAdapter = { platform: 'facebook' as const, format: 'html' as const, parserVersion: FACEBOOK_PARSER_VERSION, supports: isHtmlPath };
