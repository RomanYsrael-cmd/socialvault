import { describe, expect, it } from 'vitest';
import { detectArchive, detectArchiveSet } from '.';

describe('Facebook media-only archive detection', () => {
  const media = [
    { filename: 'your_facebook_activity/photos/album/image-1.jpg', directory: false },
    { filename: 'your_facebook_activity/videos/video-1.mp4', directory: false },
  ];

  it('marks a strict Facebook media-only part as metadata-only eligible', () => {
    const result = detectArchive(media);
    expect(result.supported).toBe(false);
    expect(result.metadataOnlyEligible).toBe(true);
  });

  it('does not treat an unrelated media collection as an archive part', () => {
    expect(detectArchive([{ filename: 'photos/image.jpg', directory: false }]).metadataOnlyEligible).toBe(false);
  });

  it('preserves the metadata-only signal when aggregating parts', () => {
    const result = detectArchiveSet([media, [{ filename: 'personal_information/profile_information/profile_information.html', directory: false }]]);
    expect(result.metadataOnlyEligible).toBe(false);
  });
});
