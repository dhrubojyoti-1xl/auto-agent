'use client';
import { useEffect, useState, type ReactNode } from 'react';

/**
 * A chart card whose reader can pick how it is drawn.
 *
 * Asked for in the 28-09-2026 review: bars are not always the clearest view —
 * department names are cut to ten characters under a vertical bar, and a long
 * list is easier to scan as a table. Every view is drawn on the server; this
 * only chooses which one is visible, so switching is instant and costs nothing.
 *
 * The choice is remembered per chart in this browser only. Storage can be
 * unavailable (private windows, blocked site data), in which case the default
 * view simply comes back.
 */
export default function ChartSwitch({ id, title, caption, views }: {
  id: string;
  title: string;
  caption?: ReactNode;
  views: { key: string; label: string; node: ReactNode }[];
}) {
  const storageKey = `chart-view:${id}`;
  const [view, setView] = useState(views[0]?.key ?? '');

  // Read after mount, so the server's HTML and the first client render agree.
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(storageKey);
      if (saved && views.some(v => v.key === saved)) setView(saved);
    } catch { /* storage unavailable: keep the default */ }
  }, [storageKey, views]);

  const choose = (key: string) => {
    setView(key);
    try { window.localStorage.setItem(storageKey, key); } catch { /* ignore */ }
  };

  const current = views.find(v => v.key === view) ?? views[0];
  return (
    <>
      <div className="chart-top">
        <div>
          <h3>{title}</h3>
          {caption && <p className="cap">{caption}</p>}
        </div>
        {views.length > 1 && (
          <select className="chart-switch" aria-label={`Chart type for ${title}`}
                  value={current?.key} onChange={e => choose(e.target.value)}>
            {views.map(v => <option key={v.key} value={v.key}>{v.label}</option>)}
          </select>
        )}
      </div>
      {current?.node}
    </>
  );
}
