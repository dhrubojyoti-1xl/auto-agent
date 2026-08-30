/**
 * Charts, drawn as inline SVG.
 *
 * No charting dependency on purpose: these render on the server inside React
 * Server Components, so the dashboard paints with data already in the HTML —
 * no loading spinner, no client bundle, and nothing to pay for. Every chart
 * handles the empty case explicitly, because a dashboard that silently shows
 * an empty box is worse than one that says "no data yet".
 */

const PALETTE = ['#1f6feb', '#1a7f4b', '#a2680a', '#b3261e', '#6b46c1', '#0f766e'];

/**
 * A chart with nothing worth drawing says what it would show and why it
 * cannot, at a height that does not leave a hole in the page. Stretching two
 * data points across a full-size canvas is how a dashboard looks broken while
 * being technically correct.
 */
function EmptyState({ label, height = 180 }: { label: string; height?: number }) {
  return (
    <div className="chart-empty" style={{ height }}>
      <span>{label}</span>
    </div>
  );
}

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / mag;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * mag;
}

/**
 * Axis values that are distinct whole numbers.
 *
 * Five evenly spaced fractions of a small maximum collapse into each other
 * once rounded: a chart peaking at two tasks printed "0 0 1 1 1" up its side,
 * which is worse than no axis at all. When the range is small enough to count,
 * the ticks are simply the integers in it.
 */
function axisTicks(maxY: number, wanted = 5): number[] {
  if (maxY <= wanted) {
    return Array.from({ length: maxY + 1 }, (_, i) => i);
  }
  const raw = Array.from({ length: wanted }, (_, i) =>
    Math.round((maxY * i) / (wanted - 1)));
  return [...new Set(raw)];
}

/*
 * Every <title> below is given ONE pre-joined string child, never a sequence
 * of interpolations. React treats <title> as document metadata wherever it
 * appears — including inside <svg>, where it is really a tooltip — and metadata
 * titles accept a single string child only. Passing several children made the
 * server render <title></title> while the browser filled it in, which broke
 * hydration on every page with a chart and left the tooltips empty until React
 * re-rendered the whole tree on the client.
 */
function shortDate(iso: string): string {
  const M = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const [, m, d] = iso.split('-').map(Number);
  return `${d} ${M[(m || 1) - 1]}`;
}

/* ------------------------------------------------------------------ */
/* Line / area — trends over time                                      */
/* ------------------------------------------------------------------ */
export interface Series { name: string; points: { x: string; y: number }[] }

export function LineChart({
  series, height = 220, yLabel = '', suffix = '', empty = 'No data for this period'
}: { series: Series[]; height?: number; yLabel?: string; suffix?: string; empty?: string }) {
  const withData = series.filter(s => s.points.length > 0);
  if (!withData.length || withData.every(s => s.points.length < 2)) {
    // A single point cannot show a trend; say so rather than drawing a dot.
    return <EmptyState label={withData.length ? 'Only one day of data so far — a trend needs at least two' : empty} height={height} />;
  }
  const W = 720, H = height, padL = 46, padR = 14, padT = 14, padB = 34;
  const xs = Array.from(new Set(withData.flatMap(s => s.points.map(p => p.x)))).sort();
  const maxY = niceMax(Math.max(...withData.flatMap(s => s.points.map(p => p.y)), 1));
  const xAt = (x: string) => padL + (xs.indexOf(x) / Math.max(xs.length - 1, 1)) * (W - padL - padR);
  const yAt = (y: number) => H - padB - (y / maxY) * (H - padT - padB);
  const ticks = axisTicks(maxY);
  const labelEvery = Math.ceil(xs.length / 8);

  return (
    <div className="chart-wrap">
      <svg viewBox={`0 0 ${W} ${H}`} className="chart" role="img"
           aria-label={`${yLabel || 'Values'} over ${xs.length} periods`}>
        {ticks.map(t => (
          <g key={t}>
            <line x1={padL} x2={W - padR} y1={yAt(t)} y2={yAt(t)} className="grid" />
            <text x={padL - 8} y={yAt(t) + 4} className="axis" textAnchor="end">{t}{suffix}</text>
          </g>
        ))}
        {xs.map((x, i) => i % labelEvery === 0 && (
          <text key={x} x={xAt(x)} y={H - 12} className="axis" textAnchor="middle">{shortDate(x)}</text>
        ))}
        {withData.map((s, si) => {
          const pts = s.points.slice().sort((a, b) => a.x.localeCompare(b.x));
          const d = pts.map((p, i) => `${i ? 'L' : 'M'}${xAt(p.x).toFixed(1)},${yAt(p.y).toFixed(1)}`).join(' ');
          const area = `${d} L${xAt(pts[pts.length - 1].x).toFixed(1)},${yAt(0)} L${xAt(pts[0].x).toFixed(1)},${yAt(0)} Z`;
          return (
            <g key={s.name}>
              {withData.length === 1 && <path d={area} fill={PALETTE[si]} opacity="0.10" />}
              <path d={d} fill="none" stroke={PALETTE[si % PALETTE.length]} strokeWidth="2"
                    strokeLinejoin="round" strokeLinecap="round" />
              {/* A dot per point turns a busy line into a caterpillar. They
                  earn their place only on a short series; on a long one the
                  hover bands below carry the values instead. */}
              {pts.length <= 14 && pts.map(p => (
                <circle key={p.x} cx={xAt(p.x)} cy={yAt(p.y)} r="3"
                        fill={PALETTE[si % PALETTE.length]}>
                  <title>{`${shortDate(p.x)}: ${p.y}${suffix}` +
                          (s.name !== 'value' ? ` (${s.name})` : '')}</title>
                </circle>
              ))}
              {/* The last point is always marked: it is the one a reader
                  looks for, and it anchors the direct label beside it. */}
              {pts.length > 14 && (
                <circle cx={xAt(pts[pts.length - 1].x)} cy={yAt(pts[pts.length - 1].y)}
                        r="3.5" fill={PALETTE[si % PALETTE.length]} />
              )}
            </g>
          );
        })}
        {/* One invisible band per period, so hovering anywhere in a column
            reports every series at that point rather than requiring the
            reader to hit a 3px dot. */}
        {xs.map(x => {
          const w = (W - padL - padR) / Math.max(xs.length, 1);
          const lines = withData.map(s => {
            const p = s.points.find(pt => pt.x === x);
            return p ? `${s.name !== 'value' ? s.name + ': ' : ''}${p.y}${suffix}` : null;
          }).filter(Boolean);
          return (
            <rect key={'hb-' + x} x={xAt(x) - w / 2} y={padT} width={w} height={H - padT - padB}
                  fill="transparent" className="hoverband">
              <title>{`${shortDate(x)}\n${lines.join('\n')}`}</title>
            </rect>
          );
        })}
      </svg>
      {withData.length > 1 && (
        <div className="legend">
          {withData.map((s, i) => (
            <span key={s.name}>
              <i style={{ background: PALETTE[i % PALETTE.length] }} />{s.name}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Grouped / stacked bars — comparisons                                */
/* ------------------------------------------------------------------ */
export interface BarRow { label: string; values: { name: string; value: number }[] }

export function BarChart({
  rows, height = 240, stacked = false, suffix = '', empty = 'Nothing to compare yet'
}: { rows: BarRow[]; height?: number; stacked?: boolean; suffix?: string; empty?: string }) {
  if (!rows.length) return <EmptyState label={empty} height={height} />;
  const names = Array.from(new Set(rows.flatMap(r => r.values.map(v => v.name))));
  const W = 720, H = height, padL = 46, padR = 14, padT = 14, padB = 44;
  const maxY = niceMax(stacked
    ? Math.max(...rows.map(r => r.values.reduce((a, v) => a + v.value, 0)), 1)
    : Math.max(...rows.flatMap(r => r.values.map(v => v.value)), 1));
  const bandW = (W - padL - padR) / rows.length;
  const barW = stacked ? Math.min(bandW * 0.55, 54)
                       : Math.min((bandW * 0.7) / Math.max(names.length, 1), 34);
  const yAt = (y: number) => H - padB - (y / maxY) * (H - padT - padB);
  const ticks = axisTicks(maxY);

  return (
    <div className="chart-wrap">
      <svg viewBox={`0 0 ${W} ${H}`} className="chart" role="img" aria-label="Comparison">
        {ticks.map(t => (
          <g key={t}>
            <line x1={padL} x2={W - padR} y1={yAt(t)} y2={yAt(t)} className="grid" />
            <text x={padL - 8} y={yAt(t) + 4} className="axis" textAnchor="end">{t}{suffix}</text>
          </g>
        ))}
        {rows.map((r, ri) => {
          const cx = padL + bandW * ri + bandW / 2;
          let acc = 0;
          return (
            <g key={r.label}>
              {r.values.map((v, vi) => {
                const idx = names.indexOf(v.name);
                if (stacked) {
                  const y0 = yAt(acc); acc += v.value; const y1 = yAt(acc);
                  return v.value > 0 ? (
                    <rect key={v.name} x={cx - barW / 2} y={y1} width={barW} height={Math.max(y0 - y1, 0)}
                          fill={PALETTE[idx % PALETTE.length]} rx="2">
                      <title>{`${r.label} — ${v.name}: ${v.value}${suffix}`}</title>
                    </rect>
                  ) : null;
                }
                const x = cx - (names.length * barW) / 2 + vi * barW;
                return (
                  <rect key={v.name} x={x} y={yAt(v.value)} width={Math.max(barW - 3, 2)}
                        height={Math.max(yAt(0) - yAt(v.value), 0)}
                        fill={PALETTE[idx % PALETTE.length]} rx="2">
                    <title>{`${r.label} — ${v.name}: ${v.value}${suffix}`}</title>
                  </rect>
                );
              })}
              <text x={cx} y={H - 14} className="axis" textAnchor="middle">
                {r.label.length > 11 ? r.label.slice(0, 10) + '…' : r.label}
                <title>{r.label}</title>
              </text>
            </g>
          );
        })}
      </svg>
      {names.length > 1 && (
        <div className="legend">
          {names.map((n, i) => (
            <span key={n}><i style={{ background: PALETTE[i % PALETTE.length] }} />{n}</span>
          ))}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Donut — status distribution                                         */
/* ------------------------------------------------------------------ */
export function DonutChart({
  slices, size = 200, empty = 'No tasks yet'
}: { slices: { name: string; value: number }[]; size?: number; empty?: string }) {
  const data = slices.filter(s => s.value > 0);
  const total = data.reduce((a, s) => a + s.value, 0);
  if (!total) return <EmptyState label={empty} height={size} />;

  const r = size / 2 - 6, cx = size / 2, cy = size / 2, thickness = 26;
  let angle = -Math.PI / 2;
  const arcs = data.map((s, i) => {
    const sweep = (s.value / total) * Math.PI * 2;
    const a0 = angle, a1 = angle + sweep;
    angle = a1;
    const large = sweep > Math.PI ? 1 : 0;
    const p = (a: number, rad: number) => `${(cx + rad * Math.cos(a)).toFixed(2)},${(cy + rad * Math.sin(a)).toFixed(2)}`;
    return {
      name: s.name, value: s.value, colour: PALETTE[i % PALETTE.length],
      pct: Math.round((s.value / total) * 1000) / 10,
      d: `M${p(a0, r)} A${r},${r} 0 ${large} 1 ${p(a1, r)} L${p(a1, r - thickness)} A${r - thickness},${r - thickness} 0 ${large} 0 ${p(a0, r - thickness)} Z`
    };
  });

  return (
    <div className="chart-wrap donut">
      <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size} role="img"
           aria-label="Status distribution">
        {arcs.map(a => (
          <path key={a.name} d={a.d} fill={a.colour}>
            <title>{`${a.name}: ${a.value} (${a.pct}%)`}</title>
          </path>
        ))}
        <text x={cx} y={cy - 2} textAnchor="middle" className="donut-total">{total}</text>
        <text x={cx} y={cy + 16} textAnchor="middle" className="axis">tasks</text>
      </svg>
      <div className="legend column">
        {arcs.map(a => (
          <span key={a.name}>
            <i style={{ background: a.colour }} />{a.name}
            <b>{a.value}</b><em>{a.pct}%</em>
          </span>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Horizontal bars — rankings (employees, slow tasks)                  */
/* ------------------------------------------------------------------ */
export function RankChart({
  rows, suffix = '', empty = 'Nothing to show yet', max
}: { rows: { label: string; value: number; note?: string }[]; suffix?: string; empty?: string; max?: number }) {
  if (!rows.length) return <EmptyState label={empty} height={140} />;
  const top = max ?? Math.max(...rows.map(r => r.value), 1);
  return (
    <div className="rank">
      {rows.map((r, i) => (
        <div className="rank-row" key={r.label + i}>
          <div className="rank-label" title={r.label}>{r.label}</div>
          <div className="rank-track">
            <div className="rank-fill"
                 style={{ width: `${Math.max((r.value / top) * 100, 1.5)}%`,
                          background: PALETTE[i % PALETTE.length] }} />
          </div>
          <div className="rank-value">{r.value}{suffix}{r.note && <em> {r.note}</em>}</div>
        </div>
      ))}
    </div>
  );
}
