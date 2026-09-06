import { describe, expect, it } from 'vitest';
import { compareFacebookChunkPaths, diagnosticWarningCategory, normalizeFacebookMediaPath, parseFacebookConversationWithMedia, parseFacebookPostsWithMedia, parseFacebookProfile, parseFacebookTimestamp, shapeSignature } from './facebook-parser';

describe('Facebook compatibility hardening', () => {
  it('accepts only unambiguous timestamp forms and keeps UTC output', () => {
    expect(parseFacebookTimestamp(1_700_000_000)).toBe('2023-11-14T22:13:20.000Z');
    expect(parseFacebookTimestamp('1700000000000')).toBe('2023-11-14T22:13:20.000Z');
    expect(parseFacebookTimestamp('2024-05-06')).toBe('2024-05-06T00:00:00.000Z');
    expect(parseFacebookTimestamp('2024')).toBe('2024-01-01T00:00:00.000Z');
    expect(parseFacebookTimestamp('05/06/2024')).toBeUndefined();
    expect(parseFacebookTimestamp('not-a-date')).toBeUndefined();
  });

  it('unwraps personal-information profile arrays and preserves escaped Unicode', () => {
    const profile = parseFacebookProfile([{ personal_information: [{ display_name: 'Áda 你好 مرحبا 👋', user_id: '42', about_me: 'Mabuhay' }] }], 'personal_information/profile.json');
    expect(profile).toMatchObject({ displayName: 'Áda 你好 مرحبا 👋', facebookId: '42', bio: 'Mabuhay' });
  });

  it('handles post wrappers and attachment-only records', () => {
    const parsed = parseFacebookPostsWithMedia({ posts_v2: { entries: [{ title: 'Only a photo', attachments: [{ media: { uri: 'photos/%E2%9C%A8.jpg', mime_type: 'image/jpeg' } }] }] } }, 'your_facebook_activity/posts/your_posts_1.json');
    expect(parsed.posts).toHaveLength(1);
    expect(parsed.posts[0].text).toBeUndefined();
    expect(parsed.media[0].path).toBe('photos/✨.jpg');
  });

  it('handles nested Messenger message data and numeric chunk order', () => {
    const parsed = parseFacebookConversationWithMedia({ thread: { participants: [{ name: 'Филип' }], messages_data: [{ sender: { name: 'Филип' }, content: 'Привет 👋', timestamp: 1700000000 }] } }, 'messages/message_requests/chat/message_10.json');
    expect(parsed.messages[0]).toMatchObject({ senderName: 'Филип', text: 'Привет 👋' });
    expect(parsed.conversation?.participantNames).toContain('Филип');
    expect(compareFacebookChunkPaths('message_2.json', 'message_10.json')).toBeLessThan(0);
  });

  it('keeps diagnostics structural and classifies repeated warnings', () => {
    expect(normalizeFacebookMediaPath('nested\\photo%20one.jpg')).toBe('nested/photo one.jpg');
    expect(shapeSignature({ messages_data: [{ sender_name: 'private', content: 'secret' }] })).toContain('messages_data');
    expect(shapeSignature({ messages_data: [{ sender_name: 'private', content: 'secret' }] })).not.toContain('secret');
    expect(diagnosticWarningCategory('messages/chat.json: unsupported Facebook JSON shape')).toBe('unsupported-shape');
  });
});
