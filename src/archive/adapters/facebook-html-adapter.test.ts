import { describe, expect, it } from 'vitest';
import { HTML_RECORD_BATCH_SIZE, parseFacebookHtmlDocument, parseFacebookHtmlEntry } from './facebook-html-adapter';
import { resolveArchiveRelativePath } from './html-path';

const profile = (name = 'Röman & Friends') => `<!doctype html><html><body><h1>Profile information</h1><table class="_a6_n"><tr><th>Name</th><td>${name}</td></tr><tr><th>Work</th><td>Local history lab</td></tr><tr><th>Education</th><td>Example University</td></tr><tr><th>Registration date</th><td>Wednesday, January 2, 2010 at 9:40 PM UTC+08:00</td></tr></table><a href="https://www.facebook.com/profile.php?id=12345">profile</a></body></html>`;
const post = (index = 1) => `<section class="_a6-g"><h2 class="_2ph_ _a6-h _a6-i">Archive owner</h2><div class="_2ph_ _a6-p">A post &amp; its <b>entities</b> ${index}</div><div class="_a72d">January ${index}, 2020</div><a href="../media/photo-${index}.jpg"><img src="../media/photo-${index}.jpg" alt="photo"></a></section>`;
const message = (name: string, text: string, index: number) => `<section class="_a6-g"><h2 class="_2ph_ _a6-h _a6-i">${name}</h2><div class="_2ph_ _a6-p">${text}</div><div class="_a72d">February ${index}, 2021</div></section>`;

describe('Facebook HTML adapter', () => {
  it('normalizes profile tables and facts without exposing raw HTML', async () => {
    const result = await parseFacebookHtmlDocument(profile(), 'personal_information/profile_information/profile_information.html', { chunkSize: 17 });
    expect(result.profile?.displayName).toBe('Röman & Friends');
    expect(result.profile?.joinedAt).toContain('2010');
    expect(result.profile?.personId).toBe('owner');
    expect(result.profileFacts.map(item => item.category)).toEqual(expect.arrayContaining(['work', 'education']));
    expect(result.people.some(person => person.isArchiveOwner)).toBe(true);
  });

  it('parses entities, local media, and source references in posts', async () => {
    const result = await parseFacebookHtmlDocument(`<h1>Posts</h1>${post(1).replace('</section>', '<a href="https://example.com/story">story</a></section>')}`, 'your_facebook_activity/posts/your_posts_1.html', { chunkSize: 11 });
    expect(result.posts).toHaveLength(1);
    expect(result.posts[0].text).toContain('A post & its entities');
    expect(result.media[0].path).toBe('your_facebook_activity/media/photo-1.jpg');
    expect(result.posts[0].links).toEqual(expect.arrayContaining(['https://example.com/story', 'your_facebook_activity/media/photo-1.jpg']));
    expect(result.posts[0].createdAt).toBe('2020-01-01T00:00:00.000Z');
    expect(result.posts[0].source.path).toContain('your_posts_1.html');
  });

  it('groups Messenger messages by folder and preserves Unicode text', async () => {
    const result = await parseFacebookHtmlDocument(`<h1>Chat</h1>${message('Жан', '你好 &amp; привет', 2)}${message('Mia', 'second', 3)}`, 'your_facebook_activity/messages/inbox/thread-1/message_1.html', { chunkSize: 13 });
    expect(result.conversations).toHaveLength(1);
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0].text).toContain('你好 & привет');
    expect(result.messages[0].senderName).toBe('Жан');
    expect(result.messages[0].source.index).toBe(0);
  });

  it('supports connection types and conservative inline interactions', async () => {
    const html = `<section class="_a6-g" data-reaction-type="LOVE" data-actor="Alex" data-comment="Nice"><h2 class="_2ph_ _a6-h _a6-i">Alex</h2><div class="_a72d">March 3, 2022</div></section>`;
    const result = await parseFacebookHtmlDocument(html, 'connections/friends/your_friends.html', { chunkSize: 8 });
    expect(result.connections[0].type).toBe('friend');
    expect(result.connections[0].displayName).toBe('Alex');
  });

  it('requires explicit targets for comments and reactions', async () => {
    const comments = await parseFacebookHtmlDocument('<section class="_a6-g" data-post-id="post-1"><h2 class="_2ph_ _a6-h">Mia</h2><div class="_2ph_ _a6-p">Helpful &amp; kind</div><div class="_a72d">April 4, 2022</div></section>', 'your_facebook_activity/comments/comments.html');
    expect(comments.comments).toHaveLength(1);
    expect(comments.comments[0]).toMatchObject({ postId: 'post-1', text: 'Helpful & kind', authorName: 'Mia' });
    const reactions = await parseFacebookHtmlDocument('<section class="_a6-g" data-target-type="post" data-target-id="post-1" data-reaction-type="LOVE"><h2 class="_2ph_ _a6-h">Mia</h2><div class="_a72d">April 4, 2022</div></section>', 'your_facebook_activity/reactions/likes_and_reactions.html');
    expect(reactions.reactions).toHaveLength(1);
    expect(reactions.reactions[0]).toMatchObject({ targetId: 'post-1', kind: 'LOVE' });
    const orphan = await parseFacebookHtmlDocument('<section class="_a6-g"><h2 class="_2ph_ _a6-h">Mia</h2><div class="_2ph_ _a6-p">Unlinked</div></section>', 'your_facebook_activity/comments/comments.html');
    expect(orphan.comments).toHaveLength(0);
    expect(orphan.warnings.join(' ')).toMatch(/target or text/);
  });

  it('keeps unnamed Messenger identities stable across chunks in one thread', async () => {
    const first = await parseFacebookHtmlDocument(message('Same sender', 'one', 1), 'messages/inbox/thread-a/message_1.html');
    const second = await parseFacebookHtmlDocument(message('Same sender', 'two', 2), 'messages/inbox/thread-a/message_2.html');
    expect(first.messages[0].senderId).toBe(second.messages[0].senderId);
  });

  it('normalizes album media membership without loading the binary', async () => {
    const result = await parseFacebookHtmlDocument('<h1>Summer album</h1><section class="_a6-g"><div class="_2ph_ _a6-p">Caption</div><img src="../photos/%E2%9C%A8.jpg"></section>', 'your_facebook_activity/albums/summer.html', { chunkSize: 19 });
    expect(result.albums).toHaveLength(1);
    expect(result.albums[0].mediaIds).toHaveLength(1);
    expect(result.media[0]).toMatchObject({ path: 'your_facebook_activity/photos/✨.jpg', ownerType: 'album' });
  });

  it('reports structural diagnostics without copying private values', async () => {
    const result = await parseFacebookHtmlDocument(profile('Private Fixture Name'), 'personal_information/profile_information/profile_information.html');
    expect(JSON.stringify(result.diagnostics)).not.toContain('Private Fixture Name');
    expect(JSON.stringify(result.diagnostics)).not.toContain('profile.php?id=12345');
  });

  it('ignores script, style, and template text when normalizing visible records', async () => {
    const html = `<section class="_a6-g"><script>secret-token</script><style>.private{display:none}</style><template>hidden fixture</template><div class="_2ph_ _a6-p">Visible post text</div></section>`;
    const result = await parseFacebookHtmlDocument(html, 'your_facebook_activity/posts/your_posts.html');
    expect(result.posts[0].text).toBe('Visible post text');
    expect(result.posts[0].text).not.toMatch(/secret|private|hidden/i);
  });

  it('parses ZIP byte chunks without requiring a complete entry string', async () => {
    const bytes = new TextEncoder().encode(`<section class="_a6-g"><h2 class="_2ph_ _a6-h _a6-i">Chunked sender</h2><div class="_2ph_ _a6-p">Chunked 你好 message</div></section>`);
    const entry = { getData: async (writer: WritableStream<Uint8Array>) => { const stream = writer.getWriter(); await stream.write(bytes.slice(0, 23)); await stream.write(bytes.slice(23)); await stream.close(); } };
    const result = await parseFacebookHtmlEntry(entry, 'messages/inbox/chunked/message_1.html');
    expect(result.messages[0].text).toBe('Chunked 你好 message');
  });

  it('honors cancellation between streamed chunks', async () => {
    let checks = 0;
    const html = Array.from({ length: 400 }, (_, index) => post((index % 28) + 1)).join('');
    await expect(parseFacebookHtmlDocument(html, 'your_facebook_activity/posts/your_posts_1.html', {
      chunkSize: 64,
      checkCancelled: () => { checks++; if (checks > 4) throw new Error('cancelled'); },
    })).rejects.toThrow('cancelled');
    expect(checks).toBeGreaterThan(4);
  });

  it('streams large pages in bounded batches', async () => {
    let batches = 0; let maxBatch = 0; let records = 0;
    const html = Array.from({ length: HTML_RECORD_BATCH_SIZE * 2 + 40 }, (_, index) => post((index % 28) + 1)).join('');
    const result = await parseFacebookHtmlDocument(html, 'your_facebook_activity/posts/your_posts_1.html', {
      chunkSize: 4096,
      onBatch: batch => { batches++; const count = batch.posts.length + batch.people.length + batch.media.length; records += count; maxBatch = Math.max(maxBatch, count); },
    });
    expect(batches).toBeGreaterThan(1);
    expect(maxBatch).toBeLessThanOrEqual(HTML_RECORD_BATCH_SIZE + 2);
    expect(result.maxBufferedRecords).toBeLessThanOrEqual(HTML_RECORD_BATCH_SIZE + 2);
    expect(records).toBeGreaterThan(200);
    expect(result.posts).toHaveLength(0);
  });
});

describe('HTML archive path safety', () => {
  it('resolves relative local references and rejects remote/traversal values', () => {
    expect(resolveArchiveRelativePath('posts/page.html', '../media/a%20b.jpg')).toBe('media/a b.jpg');
    expect(resolveArchiveRelativePath('posts/page.html', '../../escape.jpg')).toBeUndefined();
    expect(resolveArchiveRelativePath('posts/page.html', 'https://facebook.com/photo.jpg')).toBeUndefined();
    expect(resolveArchiveRelativePath('posts/page.html', 'javascript:alert(1)')).toBeUndefined();
  });
});
