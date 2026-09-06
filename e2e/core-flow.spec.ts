import { test, expect } from '@playwright/test';
import { BlobWriter, TextReader, ZipWriter } from '@zip.js/zip.js';

test('imports and browses a synthetic archive with stats, pagination, search, and media metadata', async ({ page }) => {
  const today = new Date();
  const memoryTimestamp = Math.floor(Date.UTC(today.getUTCFullYear() - 10, today.getUTCMonth(), today.getUTCDate(), 12) / 1000);
  const posts = Array.from({ length: 22 }, (_, index) => ({
    timestamp: index === 0 ? memoryTimestamp : 1700000000 + index * 86400,
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
  await page.getByRole('link', { name: 'People', exact: true }).click();
  await expect(page.getByRole('link', { name: /Synthetic User/ }).first()).toBeVisible();

  await page.getByRole('link', { name: 'Home', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Synthetic post 20', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /Open synthetic.jpg/ })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText('A lovely memory')).toBeVisible();
  await expect(page.getByText('Love · Archive Friend')).toBeVisible();
  await page.getByRole('link', { name: 'Open post' }).first().click();
  await expect(page).toHaveURL(/\/posts\//);
  await expect(page.getByText('A lovely memory')).toBeVisible();
  await page.getByRole('main').getByRole('link', { name: 'Home', exact: true }).click();
  await page.getByRole('button', { name: /Open synthetic.jpg/ }).click();
  await expect(page.getByRole('dialog', { name: 'Media viewer' })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Load older posts' }).click();
  await expect(page.getByRole('heading', { name: 'Synthetic post 1', exact: true })).toBeVisible();

  await page.goto('/memories');
  await expect(page.getByRole('heading', { name: 'Memories', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: /Posted .*Synthetic post 1/ })).toBeVisible({ timeout: 10_000 });
  await page.getByRole('link', { name: /Posted .*Synthetic post 1/ }).click();
  await expect(page).toHaveURL(/\/posts\//);
  await page.getByRole('main').getByRole('link', { name: 'Home', exact: true }).click();

  await page.goto('/activity');
  await expect(page.getByRole('heading', { name: 'Activity', exact: true })).toBeVisible();
  await expect(page.getByText('Posted “Synthetic post 1”', { exact: true })).toBeVisible({ timeout: 10_000 });
  await page.getByRole('combobox', { name: 'Activity type' }).selectOption('comment');
  await expect(page.getByText(/A lovely memory/)).toBeVisible({ timeout: 10_000 });
  await page.getByRole('link', { name: /Open post record/ }).first().click();
  await expect(page).toHaveURL(/\/posts\//);

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
  await expect(page).toHaveURL(/\/posts\//);

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
  await page.getByRole('link', { name: 'Archive', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Reconnect media' })).toBeVisible({ timeout: 15_000 });
  await page.locator('input[type=file]').setInputFiles({ name: 'synthetic-facebook.zip', mimeType: 'application/zip', buffer: Buffer.from(await blob.arrayBuffer()) });
  await expect(page.getByText(/Archive reconnected/)).toBeVisible({ timeout: 15_000 });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.locator('header .mobile-nav a[href="/home"]').evaluate((element) => (element as HTMLElement).click());
  await expect(page.getByRole('heading', { name: 'Home', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('imports a multi-part Facebook archive as one logical set and reconnects parts in batches', async ({ page }) => {
  const makeZip = async (entries: Record<string, unknown | string>) => {
    const writer = new ZipWriter(new BlobWriter('application/zip'));
    for (const [path, value] of Object.entries(entries)) await writer.add(path, new TextReader(typeof value === 'string' ? value : JSON.stringify(value)));
    return writer.close();
  };
  const partOne = await makeZip({
    'profile_information/profile_information.json': { profile_v2: { name: 'Multipart User', username: 'multipart_user' } },
    'your_facebook_activity/posts/your_posts__1.json': [{ timestamp: 1700000100, title: 'Part one post', data: [{ post: 'A post whose photo lives in another ZIP part.' }], attachments: [{ data: [{ media: { uri: 'photos/cross-part.jpg', mime_type: 'image/jpeg' } }, { media: { uri: 'photos/local-part.jpg', mime_type: 'image/jpeg' } }] }] }],
    'photos/local-part.jpg': 'synthetic image bytes in part one',
  });
  const partTwo = await makeZip({
    'messages/inbox/shared_chat/message_1.json': { title: 'Shared multipart chat', participants: [{ name: 'Multipart User' }, { name: 'Archive Friend' }], messages: [{ sender_name: 'Archive Friend', timestamp_ms: 1700000200000, content: 'Message chunk one' }] },
    'photos/cross-part.jpg': 'synthetic image bytes',
  });
  const partThree = await makeZip({
    'messages/inbox/shared_chat/message_2.json': { title: 'Shared multipart chat', participants: [{ name: 'Multipart User' }, { name: 'Archive Friend' }], messages: [{ sender_name: 'Multipart User', timestamp_ms: 1700000300000, content: 'Message chunk two' }] },
  });
  const files = [
    { name: 'facebook-export-part-1.zip', mimeType: 'application/zip', buffer: Buffer.from(await partOne.arrayBuffer()) },
    { name: 'facebook-export-part-2.zip', mimeType: 'application/zip', buffer: Buffer.from(await partTwo.arrayBuffer()) },
    { name: 'facebook-export-part-3.zip', mimeType: 'application/zip', buffer: Buffer.from(await partThree.arrayBuffer()) },
  ];
  await page.goto('/');
  await page.locator('input[type=file]').setInputFiles(files);
  await expect(page.getByText('3 ZIP parts selected')).toBeVisible();
  await page.getByRole('button', { name: /Inspect archive set/ }).click();
  await expect(page).toHaveURL(/\/archive$/, { timeout: 15_000 });
  await expect(page.getByText('3 ZIP parts', { exact: true }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Start local import' }).click();
  await expect(page.getByRole('button', { name: /Imported/ })).toBeVisible({ timeout: 30_000 });
  await page.getByRole('link', { name: 'Home' }).click();
  await expect(page.getByRole('heading', { name: 'Part one post', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /Open cross-part.jpg/ })).toBeVisible();
  await page.getByRole('link', { name: 'Messages' }).click();
  await expect(page.getByRole('link', { name: /Shared multipart chat/ })).toBeVisible();
  await page.getByRole('link', { name: /Shared multipart chat/ }).click();
  await expect(page.getByText('Message chunk one')).toBeVisible();
  await expect(page.getByText('Message chunk two')).toBeVisible();
  await page.reload();
  await page.getByRole('link', { name: 'Archive' }).click();
  await expect(page.getByRole('heading', { name: 'Reconnect media' })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('3 ZIP parts', { exact: true }).first()).toBeVisible();
  await page.locator('input[type=file]').setInputFiles([files[1], files[2]]);
  await expect(page.getByText(/Archive reconnected: 2 matched, 1 still missing/)).toBeVisible({ timeout: 15_000 });
  await page.getByRole('link', { name: 'Home' }).click();
  await expect(page.getByRole('button', { name: /Open cross-part.jpg/ })).toBeVisible();
  await expect(page.getByText('Archive part not connected.')).toBeVisible();
  await page.getByRole('link', { name: 'Archive' }).click();
  await page.locator('input[type=file]').setInputFiles([files[0]]);
  await expect(page.getByText(/Archive reconnected: 1 matched/)).toBeVisible({ timeout: 15_000 });
  await page.getByRole('link', { name: 'Home' }).click();
  await expect(page.getByRole('button', { name: /Open local-part.jpg/ })).toBeVisible();
});

test('keeps valid records when one selected ZIP part is malformed', async ({ page }) => {
  const writer = new ZipWriter(new BlobWriter('application/zip'));
  await writer.add('profile_information/profile_information.json', new TextReader(JSON.stringify({ profile_v2: { name: 'Resilient User' } })));
  await writer.add('your_facebook_activity/posts/your_posts.json', new TextReader(JSON.stringify([{ title: 'Valid part survives', data: [{ post: 'Imported despite a broken sibling ZIP.' }] }])));
  const valid = { name: 'valid-part.zip', mimeType: 'application/zip', buffer: Buffer.from(await (await writer.close()).arrayBuffer()) };
  const duplicate = { name: 'valid-part-copy.zip', mimeType: 'application/zip', buffer: valid.buffer };
  const malformed = { name: 'broken-part.zip', mimeType: 'application/zip', buffer: Buffer.from('not a ZIP archive') };

  await page.goto('/');
  await page.locator('input[type=file]').setInputFiles([valid, duplicate, malformed]);
  await page.getByRole('button', { name: /Inspect archive set/ }).click();
  await expect(page).toHaveURL(/\/archive$/, { timeout: 15_000 });
  await page.getByRole('button', { name: 'Start local import' }).click();
  await expect(page.getByRole('button', { name: /Imported/ })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/broken-part\.zip: ZIP could not be inspected/)).toBeVisible();
  await expect(page.getByText(/valid-part-copy\.zip: duplicate ZIP part selected/)).toBeVisible();
  await page.getByRole('link', { name: 'Home' }).click();
  await expect(page.getByRole('heading', { name: 'Valid part survives', exact: true })).toBeVisible();
});

test('cancels and resumes a multipart import after reconnecting the ZIP set', async ({ page }) => {
  test.setTimeout(90_000);
  const makeZip = async (entries: Record<string, unknown | string>) => {
    const writer = new ZipWriter(new BlobWriter('application/zip'));
    for (const [path, value] of Object.entries(entries)) await writer.add(path, new TextReader(typeof value === 'string' ? value : JSON.stringify(value)));
    return writer.close();
  };
  const partOne = await makeZip({
    'profile_information/profile_information.json': { profile_v2: { name: 'Resume User', username: 'resume_user' } },
    'your_facebook_activity/posts/your_posts.json': [{ title: 'Resume post', data: [{ post: 'A post saved before cancellation.' }] }],
  });
  const partTwoEntries: Record<string, unknown> = {};
  for (let index = 1; index <= 1_200; index++) partTwoEntries[`messages/inbox/resume_chat/message_${index}.json`] = { title: 'Resumable chat', participants: [{ name: 'Resume User' }, { name: 'Archive Friend' }], messages: [{ sender_name: index % 2 ? 'Archive Friend' : 'Resume User', timestamp_ms: 1700000000000 + index, content: index === 1_200 ? 'The final resumable message' : `Resumable message ${index}` }] };
  const partTwo = await makeZip(partTwoEntries);
  const files = [
    { name: 'resume-export-part-1.zip', mimeType: 'application/zip', buffer: Buffer.from(await partOne.arrayBuffer()) },
    { name: 'resume-export-part-2.zip', mimeType: 'application/zip', buffer: Buffer.from(await partTwo.arrayBuffer()) },
  ];

  await page.goto('/');
  await page.locator('input[type=file]').setInputFiles(files);
  await page.getByRole('button', { name: /Inspect archive set/ }).click();
  await expect(page).toHaveURL(/\/archive$/, { timeout: 15_000 });
  await page.getByRole('button', { name: 'Start local import' }).click();
  await expect(page.getByText(/Part 2 of 2/)).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Cancel import' }).click();
  await expect(page.getByText(/Import cancelled/)).toBeVisible({ timeout: 30_000 });

  await page.reload();
  await page.getByRole('link', { name: 'Archive', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Incomplete import found' })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/1 completed/)).toBeVisible();
  await page.locator('input[type=file]').setInputFiles(files);
  await expect(page.getByText(/Archive reconnected: 2 matched/)).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: 'Resume import' }).click();
  await expect(page.getByText(/Local import complete|Archive source disconnected/)).toBeVisible({ timeout: 60_000 });

  await page.getByRole('link', { name: 'Home', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Resume post', exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Messages', exact: true }).click();
  await expect(page.getByRole('link', { name: /Resumable chat/ })).toBeVisible({ timeout: 15_000 });
  await page.getByRole('link', { name: /Resumable chat/ }).click();
  await expect(page.getByText('The final resumable message')).toBeVisible({ timeout: 15_000 });

  await page.getByRole('link', { name: 'Archive', exact: true }).click();
  await page.getByRole('button', { name: 'Rebuild search index' }).first().click();
  await expect(page.getByText('Local search index rebuilt.')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('heading', { name: 'Archive coverage' })).toBeVisible();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export diagnostics' }).click();
  const diagnostics = await download;
  expect(diagnostics.suggestedFilename()).toBe('socialvault-diagnostics.json');
  await page.getByRole('link', { name: 'Search', exact: true }).click();
  await page.getByRole('textbox', { name: 'Search archive' }).fill('final resumable');
  await expect(page.getByText('The final resumable message')).toBeVisible({ timeout: 15_000 });
});
