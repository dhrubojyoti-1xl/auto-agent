/**
 * Auth unit tests. The end-to-end behaviour (401s, redirects) is verified
 * against the running server in tests/http.test.ts.
 */
import { describe, expect, it, beforeAll } from 'vitest';

beforeAll(() => {
  process.env.SESSION_SECRET = 'test-secret-at-least-16-chars-long';
  process.env.APP_PASSWORD = 'correct horse battery staple';
  process.env.INGEST_TOKEN = 'ingest-token-value';
});

describe('session tokens', () => {
  it('accepts a token it issued', async () => {
    const { issueToken, verifyToken } = await import('../src/lib/auth');
    expect(verifyToken(issueToken())).toBe(true);
  });

  it('rejects a tampered token', async () => {
    const { issueToken, verifyToken } = await import('../src/lib/auth');
    const t = issueToken();
    const [issued, nonce, mac] = t.split('.');
    // Flip the last character to something it definitely is not, otherwise the
    // "tampered" MAC can coincidentally equal the original and the test flakes.
    const flipped = mac.slice(0, -1) + (mac.slice(-1) === 'A' ? 'B' : 'A');
    expect(flipped).not.toBe(mac);
    expect(verifyToken(`${issued}.${nonce}.${flipped}`)).toBe(false);
    expect(verifyToken(`${issued}.${nonce}x.${mac}`)).toBe(false);
    expect(verifyToken(`${Number(issued) + 1}.${nonce}.${mac}`)).toBe(false);
  });

  it('rejects rubbish', async () => {
    const { verifyToken } = await import('../src/lib/auth');
    [undefined, '', 'x', 'a.b', 'a.b.c.d'].forEach(v => {
      expect(verifyToken(v as string | undefined)).toBe(false);
    });
  });

  it('rejects an expired token', async () => {
    const { verifyToken } = await import('../src/lib/auth');
    const { createHmac } = await import('crypto');
    const old = String(Date.now() - 8 * 24 * 3600 * 1000);
    const payload = `${old}.deadbeef`;
    const mac = createHmac('sha256', process.env.SESSION_SECRET as string)
      .update(payload).digest('base64url');
    expect(verifyToken(`${payload}.${mac}`)).toBe(false);
  });
});

describe('password check', () => {
  it('accepts the configured password and nothing else', async () => {
    const { checkPassword } = await import('../src/lib/auth');
    expect(checkPassword('correct horse battery staple')).toBe(true);
    expect(checkPassword('Correct horse battery staple')).toBe(false);
    expect(checkPassword('')).toBe(false);
    expect(checkPassword('correct horse battery stapl')).toBe(false);
  });
});

describe('ingest token', () => {
  it('accepts the bearer token and nothing else', async () => {
    const { checkIngestToken } = await import('../src/lib/auth');
    expect(checkIngestToken('Bearer ingest-token-value')).toBe(true);
    expect(checkIngestToken('ingest-token-value')).toBe(true);
    expect(checkIngestToken('Bearer wrong')).toBe(false);
    expect(checkIngestToken(null)).toBe(false);
    expect(checkIngestToken('')).toBe(false);
  });
});

describe('middleware public paths', () => {
  it('only login, ingest and health are public', async () => {
    const src = await import('fs').then(fs =>
      fs.readFileSync(new URL('../src/middleware.ts', import.meta.url), 'utf8'));
    const match = src.match(/const PUBLIC_PATHS = \[([^\]]+)\]/);
    expect(match).toBeTruthy();
    const paths = (match as RegExpMatchArray)[1]
      .split(',').map(s => s.trim().replace(/['"]/g, '')).filter(Boolean);
    expect(paths.sort()).toEqual(['/api/health', '/api/ingest', '/api/login', '/login']);
  });

  it('middleware lives inside src/, where Next.js will actually load it', async () => {
    // With a src/ directory, a middleware.ts at the project root is silently
    // ignored — which once left every dashboard page publicly readable.
    const { existsSync } = await import('fs');
    expect(existsSync(new URL('../src/middleware.ts', import.meta.url))).toBe(true);
    expect(existsSync(new URL('../middleware.ts', import.meta.url))).toBe(false);
  });
});
