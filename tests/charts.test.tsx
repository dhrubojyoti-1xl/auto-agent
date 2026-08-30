/**
 * Charts must survive the streaming server render Next actually uses.
 *
 * React treats <title> as document metadata wherever it appears, including
 * inside <svg> where it is really a tooltip, and such a title accepts a single
 * text child only. Written as <title>{a}: {b}</title> the streaming renderer
 * separates the parts with HTML comments, React warns that "hydration will
 * likely fail and fall back to client rendering", and it did: every page
 * carrying a chart threw a hydration error and re-rendered itself in the
 * browser. renderToStaticMarkup papers over this — it joins the children —
 * so this suite must use the streaming renderer or it proves nothing.
 */
import { describe, expect, it } from 'vitest';
import serverPkg from 'react-dom/server';
import { LineChart, BarChart, DonutChart, RankChart } from '../src/app/charts/charts';

const { renderToPipeableStream } = serverPkg as unknown as {
  renderToPipeableStream: (el: React.ReactElement,
    opts: { onAllReady: () => void }) => { pipe: (w: unknown) => void };
};

function streamRender(el: React.ReactElement): Promise<string> {
  return new Promise(resolve => {
    // The stream writes byte chunks; concatenating them with += would stringify
    // each Uint8Array as a comma-separated list of numbers.
    const chunks: Buffer[] = [];
    const s = renderToPipeableStream(el, {
      onAllReady() {
        s.pipe({
          write(c: Buffer | Uint8Array | string) {
            chunks.push(typeof c === 'string' ? Buffer.from(c, 'utf8') : Buffer.from(c));
          },
          end() { resolve(Buffer.concat(chunks).toString('utf8')); },
          on() {}, once() {}, emit() {}, removeListener() {}, destroy() {}
        });
      }
    });
  });
}

const page = (
  <div>
    <LineChart yLabel="Tasks" series={[{
      name: 'Tasks',
      points: [{ x: '2026-08-01', y: 4 }, { x: '2026-08-02', y: 7 },
               { x: '2026-08-03', y: 2 }]
    }]} />
    <BarChart rows={[
      { label: 'Sales', values: [{ name: 'Completed', value: 5 }, { name: 'Pending', value: 3 }] },
      { label: 'HR', values: [{ name: 'Completed', value: 2 }, { name: 'Pending', value: 6 }] }
    ]} />
    <DonutChart slices={[{ name: 'Completed', value: 8 }, { name: 'Pending', value: 2 }]} />
    <RankChart rows={[{ label: 'Rahul Mehta', value: 12, note: '· 50% done' },
                      { label: 'Kavita Menon', value: 9 }]} />
  </div>
);

describe('charts under the streaming server renderer', () => {
  it('no tooltip is split across text nodes', async () => {
    const html = await streamRender(page);
    const titles = html.match(/<title[^>]*>[\s\S]*?<\/title>/g) || [];
    expect(titles.length).toBeGreaterThan(5);
    for (const t of titles) {
      // A comment separator is React telling us the title had several
      // children, which is exactly what breaks hydration.
      expect(t, t).not.toContain('<!--');
      expect(t.replace(/<\/?title[^>]*>/g, '').trim(), t).not.toBe('');
    }
  });

  it('the server HTML carries the real tooltip text', async () => {
    const html = await streamRender(page);
    expect(html).toContain('<title>1 Aug: 4 (Tasks)</title>');
    expect(html).toContain('<title>Sales — Completed: 5</title>');
    expect(html).toContain('<title>Completed: 8 (80%)</title>');
  });
});

describe('axis labels are readable at small scales', () => {
  it('never repeats a tick value', async () => {
    const html = await streamRender(
      <LineChart yLabel="Tasks" series={[{ name: 'Tasks', points: [
        { x: '2026-08-01', y: 1 }, { x: '2026-08-02', y: 2 }, { x: '2026-08-03', y: 1 }
      ] }]} />);
    // The y-axis previously printed "0 0 1 1 1" for a chart peaking at two.
    const axis = [...html.matchAll(/class="axis"[^>]*>([^<]*)</g)].map(m => m[1]);
    const numeric = axis.filter(t => /^\d+$/.test(t));
    expect(new Set(numeric).size).toBe(numeric.length);
  });

  it('counts in whole numbers when the range is small', async () => {
    const html = await streamRender(
      <LineChart yLabel="Tasks" series={[{ name: 'Tasks', points: [
        { x: '2026-08-01', y: 1 }, { x: '2026-08-02', y: 2 }
      ] }]} />);
    const axis = [...html.matchAll(/class="axis"[^>]*>([^<]*)</g)].map(m => m[1]);
    expect(axis).toContain('0');
    expect(axis).toContain('2');
  });
})
