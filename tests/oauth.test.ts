/**
 * Google OAuth and token-at-rest encryption.
 */
import { beforeAll, describe, expect, it } from 'vitest';

beforeAll(() => {
  process.env.TOKEN_ENCRYPTION_KEY = 'a-test-encryption-key-of-sufficient-length';
  process.env.GOOGLE_CLIENT_ID = 'client-id-123';
  process.env.GOOGLE_CLIENT_SECRET = 'client-secret-456';
  delete process.env.GOOGLE_REDIRECT_URI;
});

describe('refresh-token encryption', () => {
  it('round-trips, and the ciphertext reveals nothing', async () => {
    const { encryptSecret, decryptSecret } = await import('../src/lib/crypto');
    const secret = '1//0gFAKE-refresh-token-value';
    const enc = encryptSecret(secret);
    expect(enc).not.toContain(secret);
    expect(enc.startsWith('v1.')).toBe(true);
    expect(decryptSecret(enc)).toBe(secret);
  });

  it('uses a fresh IV, so the same token encrypts differently each time', async () => {
    const { encryptSecret } = await import('../src/lib/crypto');
    expect(encryptSecret('same')).not.toBe(encryptSecret('same'));
  });

  it('refuses tampered ciphertext instead of returning garbage', async () => {
    const { encryptSecret, decryptSecret } = await import('../src/lib/crypto');
    const enc = encryptSecret('secret-value');
    const parts = enc.split('.');
    const flipped = parts[3].slice(0, -1) + (parts[3].slice(-1) === 'A' ? 'B' : 'A');
    expect(() => decryptSecret([parts[0], parts[1], parts[2], flipped].join('.')))
      .toThrow();
    expect(() => decryptSecret('nonsense')).toThrow(/Malformed/);
  });

  it('fails loudly when no key is configured', async () => {
    const saved = process.env.TOKEN_ENCRYPTION_KEY;
    process.env.TOKEN_ENCRYPTION_KEY = 'short';
    const { encryptSecret } = await import('../src/lib/crypto');
    expect(() => encryptSecret('x')).toThrow(/TOKEN_ENCRYPTION_KEY/);
    process.env.TOKEN_ENCRYPTION_KEY = saved;
  });
});

describe('authorisation URL', () => {
  it('requests offline access and forces consent, or there is no refresh token', async () => {
    const { buildAuthUrl } = await import('../src/lib/google-oauth');
    const url = new URL(buildAuthUrl('https://app.example.com', 'state-abc'));
    const p = url.searchParams;
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(p.get('access_type')).toBe('offline');
    expect(p.get('prompt')).toBe('consent');
    expect(p.get('response_type')).toBe('code');
    expect(p.get('state')).toBe('state-abc');
    expect(p.get('redirect_uri')).toBe('https://app.example.com/api/auth/google/callback');
  });

  it('asks for read-only Gmail and nothing that can modify a mailbox', async () => {
    const { buildAuthUrl, GOOGLE_SCOPES } = await import('../src/lib/google-oauth');
    const scopes = new URL(buildAuthUrl('https://app.example.com', 's'))
      .searchParams.get('scope')!.split(' ');
    expect(scopes).toContain('https://www.googleapis.com/auth/gmail.readonly');
    expect(GOOGLE_SCOPES.some(s => /gmail\.(modify|send|compose|labels)/.test(s))).toBe(false);
    expect(scopes.some(s => /gmail\.(modify|send|compose|labels)/.test(s))).toBe(false);
  });

  it('honours an explicit GOOGLE_REDIRECT_URI', async () => {
    process.env.GOOGLE_REDIRECT_URI = 'https://fixed.example.com/cb';
    const { redirectUri } = await import('../src/lib/google-oauth');
    expect(redirectUri('https://ignored.example.com')).toBe('https://fixed.example.com/cb');
    delete process.env.GOOGLE_REDIRECT_URI;
  });
});

describe('id_token decoding', () => {
  it('extracts the Google subject and email', async () => {
    const { decodeIdToken } = await import('../src/lib/google-oauth');
    const payload = Buffer.from(JSON.stringify({
      sub: '1234', email: 'manager@company.com', name: 'A Manager'
    })).toString('base64url');
    const out = decodeIdToken(`header.${payload}.sig`);
    expect(out.sub).toBe('1234');
    expect(out.email).toBe('manager@company.com');
  });

  it('rejects a malformed token', async () => {
    const { decodeIdToken } = await import('../src/lib/google-oauth');
    expect(() => decodeIdToken('nonsense')).toThrow();
  });
});

describe('Gmail candidate query', () => {
  it('is broad, and excludes only what cannot be a team report', async () => {
    const { buildGmailQuery } = await import('../src/lib/core/detect');
    const q = buildGmailQuery('2026-08-01');
    expect(q).toContain('after:2026/08/01');
    expect(q).toContain('-in:chats');
    expect(q).toContain('-category:promotions');
    // Crucially it does NOT filter on labels or subject: detection is by content.
    expect(q).not.toContain('label:');
    expect(q).not.toContain('subject:');
  });
});
