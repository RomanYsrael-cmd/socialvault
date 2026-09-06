import { describe, expect, it } from 'vitest';
import { facebookProfileTarget, safeFacebookUrl } from './security';
describe('safe external profile links', () => {
  it('allows exact Facebook hosts and rejects lookalikes', () => {
    expect(safeFacebookUrl('https://www.facebook.com/example')).toContain('facebook.com');
    expect(safeFacebookUrl('https://evil.example/facebook.com')).toBeUndefined();
    expect(safeFacebookUrl('javascript:alert(1)')).toBeUndefined();
  });
  it('uses exact identity before a name search fallback', () => {
    expect(facebookProfileTarget({ facebookId: '12345', displayName: 'Archive Person' })).toMatchObject({ kind: 'exact', url: 'https://www.facebook.com/12345' });
    expect(facebookProfileTarget({ displayName: 'Archive Person' })).toMatchObject({ kind: 'search' });
    expect(facebookProfileTarget({})).toBeUndefined();
  });
});
