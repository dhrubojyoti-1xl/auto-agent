/**
 * The first screen anyone sees has to fit on a phone.
 *
 * The sign-in card was laid out at a hard 400px. On a 375px handset — an
 * iPhone SE, an iPhone 13 mini, most Androids in portrait — the card and the
 * Sign in button ran off the right edge, and the page scrolled sideways. It was
 * measured at 401px of scroll width against a 375px viewport before the fix.
 *
 * A width in a stylesheet cannot be asserted without a browser, but the one
 * that caused this was written inline, and that can be.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (/\.tsx$/.test(name)) out.push(full);
  }
  return out;
}

const FILES = sourceFiles(join(process.cwd(), 'src/app'))
  .map(f => ({ file: f.replace(process.cwd() + '/', ''), text: readFileSync(f, 'utf8') }));

describe('nothing is laid out wider than a phone', () => {
  it('no inline pixel width exceeds a 375px viewport', () => {
    // width: 400 and width: '400px' both. maxWidth is fine — that is the fix.
    const tooWide: string[] = [];
    for (const { file, text } of FILES) {
      for (const m of text.matchAll(/(?<!max)[Ww]idth:\s*'?(\d{3,4})(?:px)?'?/g)) {
        const px = Number(m[1]);
        const before = text.slice(Math.max(0, m.index! - 10), m.index!);
        if (/max/i.test(before)) continue;
        if (px > 360) tooWide.push(`${file}: width ${px}`);
      }
    }
    expect(tooWide, tooWide.join('; ')).toEqual([]);
  });

  it('the sign-in card is capped, not fixed', () => {
    const login = FILES.find(f => f.file.endsWith('login/page.tsx'))!;
    expect(login.text).toMatch(/maxWidth:\s*400/);
    expect(login.text).toMatch(/width:\s*'100%'/);
  });

  it('every table sits inside something that can scroll sideways', () => {
    // A wide table may scroll within its own box; the page body may not. Each
    // <table> must therefore have a scrolling ancestor in the same file.
    const unwrapped: string[] = [];
    for (const { file, text } of FILES) {
      if (!text.includes('<table>')) continue;
      const hasWrapper = text.includes('table-wrap') || text.includes("overflowX: 'auto'");
      if (!hasWrapper) unwrapped.push(file);
    }
    expect(unwrapped, unwrapped.join('; ')).toEqual([]);
  });
});
