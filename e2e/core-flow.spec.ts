import { test, expect } from '@playwright/test';
import { BlobWriter, TextReader, ZipWriter } from '@zip.js/zip.js';

test('imports and browses a synthetic archive with stats, pagination, search, and media metadata', async ({ page }) => {
  const posts = Array.from({ length: 22 }, (_, index) => ({
    timestamp: 1700000000 + index * 86400,
    title: index === 21 ? 'Searchable post' : `Synthetic post ${index + 1}`,
    data: [{ post: index === 21 ? 'A unique bicycle memory for search.' : `Synthetic post body ${index + 1}.` }],
    ...(index === 21 ? { attachments: [{ data: [{ media: { uri: 'photos/synthetic.jpg', mime_type: 'image/jpeg', description: 'Synthetic photo metadata' } }] }], comments: [{ comment: 'A lovely memory', author: { id: 77, name: 'Archive Friend' }, timestamp: 1700000000 }], reactions: [{ type: 'Love', actor: { id: 77, name: 'Archive Friend' } }] } : {}),
  }));
  const writer = new ZipWriter(new BlobWriter('application/zip'));
  await writer.add('profile_information/profile_information.json', new TextReader(JSON.stringify({ profile_v2: { name: 'Synthetic User', username: 'synthetic_user', bio: 'A fictional archive profile', work: [{ company: 'Archive Co', position: 'Historian' }], education: [{ school: 'Local University' }], relationship_status: 'In a relationship' } })));
  await writer.add('your_facebook_activity/posts/your_posts__1.json', new TextReader(JSON.stringify(posts)));
  await writer.add('messages/inbox/synthetic_chat/message_1.json', new TextReader(JSON.stringify({ title: 'Synthetic chat', participants: [{ name: 'Synthetic User' }, { name: 'Archive Friend' }], messages: [{ sender_name: 'Archive Friend', timestamp_ms: 1700000000000, content: 'A unique lantern message for search.', photos: [{ uri: 'messages/synthetic_chat/lantern.png', mime_type: 'image/png' }] }] })));
  await writer.add('friends/your_friends.json', new TextReader(JSON.stringify([{ id: 77, name: 'Archive Friend', timestamp: 1700000000 }])));
  await writer.add('photos_and_videos/albums.json', new TextReader(JSON.stringify([{ name: 'Synthetic summer', photos: [{ uri: 'photos/synthetic.jpg', mime_type: 'image/jpeg' }] }])));
  await writer.add('photos/synthetic.jpg', new TextReader('synthetic media fixture'));
  await writer.add('messages/synthetic_chat/lantern.png', new TextReader('synthetic media fixture'));
  const blob = await writer.close();

  await page.goto('/');
  await page.locator('input[type=file]').setInputFiles({ name: 'synthetic-facebook.zip', mimeType: 'application/zip', buffer: Buffer.from(await blob.arrayBuffer()) });
  await expect(page.getByText('synthetic-facebook.zip')).toBeVisible();
  await page.getByRole('button', { name: /Inspect archive/ }).click();
  await expect(page).toHaveURL(/\/archive$/, { timeout: 15_000 });
  await page.getByRole('button', { name: 'Start local import' }).click();
  await expect(page.getByRole('button', { name: /Imported/ })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('22', { exact: true })).toBeVisible();
  await expect(page.getByText('1', { exact: true }).first()).toBeVisible();

  await page.getByRole('link', { name: 'Profile' }).click();
  await expect(page.getByRole('heading', { name: 'Synthetic User', exact: true })).toBeVisible();
  await expect(page.getByText('Archive Co')).toBeVisible();
  await page.getByRole('link', { name: /Open archive profile/ }).click();
  await expect(page.getByRole('heading', { name: 'Synthetic User', exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'People' }).click();
  await expect(page.getByRole('link', { name: /Synthetic User/ }).first()).toBeVisible();

  await page.getByRole('link', { name: 'Home' }).click();
  await expect(page.getByRole('heading', { name: 'Synthetic post 20', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /Open synthetic.jpg/ })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText('A lovely memory')).toBeVisible();
  await expect(page.getByText('Love · Archive Friend')).toBeVisible();
  await page.getByRole('button', { name: /Open synthetic.jpg/ }).click();
  await expect(page.getByRole('dialog', { name: 'Media viewer' })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Load older posts' }).click();
  await expect(page.getByRole('heading', { name: 'Synthetic post 1', exact: true })).toBeVisible();

  await page.getByRole('link', { name: 'Messages' }).click();
  await expect(page.getByRole('link', { name: /Synthetic chat/ })).toBeVisible();
  await page.getByRole('link', { name: /Synthetic chat/ }).click();
  await expect(page.getByText('A unique lantern message for search.')).toBeVisible();

  await page.getByRole('link', { name: 'Friends' }).click();
  await expect(page.getByRole('link', { name: 'Archive Friend' })).toBeVisible();
  await page.getByRole('link', { name: 'Albums' }).click();
  await expect(page.getByRole('link', { name: 'Synthetic summer' })).toBeVisible();
  await page.getByRole('link', { name: 'Synthetic summer' }).click();
  await expect(page.getByText('synthetic.jpg').first()).toBeVisible();

  await page.getByRole('link', { name: 'Search', exact: true }).click();
  await page.getByRole('textbox', { name: 'Search archive' }).fill('bicycle memory');
  await expect(page.getByRole('link', { name: /A unique bicycle memory for search/ })).toBeVisible({ timeout: 10_000 });
  await page.getByRole('link', { name: /A unique bicycle memory for search/ }).click();
  await expect(page).toHaveURL(/\/home$/);

  await page.getByRole('link', { name: 'Search', exact: true }).click();
  await page.getByRole('textbox', { name: 'Search archive' }).fill('lantern message');
  await expect(page.getByRole('link', { name: /A unique lantern message for search/ })).toBeVisible({ timeout: 10_000 });
  await page.getByRole('link', { name: /A unique lantern message for search/ }).click();
  await expect(page).toHaveURL(/\/messages\//);
  await expect(page.locator('article.message-match')).toContainText('A unique lantern message for search.');

  await page.getByRole('link', { name: 'Photos' }).click();
  await expect(page.getByText('synthetic.jpg').first()).toBeVisible();
  await expect(page.getByText(/metadata only/i)).toBeVisible();

  await page.reload();
  await page.getByRole('link', { name: 'Archive' }).click();
  await expect(page.getByRole('heading', { name: 'Reconnect media' })).toBeVisible({ timeout: 15_000 });
  await page.locator('input[type=file]').setInputFiles({ name: 'synthetic-facebook.zip', mimeType: 'application/zip', buffer: Buffer.from(await blob.arrayBuffer()) });
  await expect(page.getByText(/Archive reconnected/)).toBeVisible({ timeout: 15_000 });
});
