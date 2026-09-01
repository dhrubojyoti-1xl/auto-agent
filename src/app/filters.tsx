'use client';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

/**
 * One filter bar for every page that lists work.
 *
 * It used to live inside the management page and hard-code its own URL, which
 * is why the two pages a manager reaches for when something looks wrong —
 * repeated work and slow work — had no filters at all. Picking a department on
 * the dashboard narrowed everything, then clicking through to the detail showed
 * the whole organisation again, with nothing on screen admitting the filter had
 * been dropped.
 *
 * `grain` and `search` are optional because not every page has them: aggregates
 * have a period, lists have a text box, and neither should grow the other's
 * controls just to look symmetrical.
 */
export default function Filters({
  basePath = '/management',
  departments, employees, grain, department, employee, from, to, search,
  minDate, maxDate, showSearch = false
}: {
  basePath?: string;
  departments: string[]; employees: string[]; grain?: string;
  department?: string; employee?: string; from?: string; to?: string; search?: string;
  minDate: string | null; maxDate: string | null;
  showSearch?: boolean;
}) {
  const router = useRouter();

  // Typing must not navigate on every keystroke — each one is a server render.
  const [text, setText] = useState(search ?? '');
  useEffect(() => { setText(search ?? ''); }, [search]);

  const go = (patch: Record<string, string>) => {
    const p = new URLSearchParams();
    Object.entries({
      ...(grain ? { grain } : {}),
      department: department ?? '', employee: employee ?? '',
      from: from ?? '', to: to ?? '', q: search ?? '', ...patch
    }).forEach(([k, v]) => { if (v && v !== 'all') p.set(k, String(v)); });
    router.push(`${basePath}?${p.toString()}`);
  };

  const anyActive = !!(department || employee || from || to || search);

  return (
    <div className="filters">
      <div className="f">
        <label htmlFor="dept">Department</label>
        <select id="dept" value={department ?? 'all'} onChange={e => go({ department: e.target.value })}>
          <option value="all">All departments</option>
          {departments.map(d => <option key={d} value={d}>{d}</option>)}
        </select>
      </div>
      <div className="f">
        <label htmlFor="emp">Employee</label>
        <select id="emp" value={employee ?? 'all'} onChange={e => go({ employee: e.target.value })}>
          <option value="all">All employees</option>
          {employees.map(e => <option key={e} value={e}>{e}</option>)}
        </select>
      </div>
      <div className="f">
        <label htmlFor="from">From</label>
        <input id="from" type="date" value={from ?? ''} min={minDate ?? undefined}
               max={maxDate ?? undefined} onChange={e => go({ from: e.target.value })} />
      </div>
      <div className="f">
        <label htmlFor="to">To</label>
        <input id="to" type="date" value={to ?? ''} min={minDate ?? undefined}
               max={maxDate ?? undefined} onChange={e => go({ to: e.target.value })} />
      </div>
      {showSearch && (
        <div className="f">
          <label htmlFor="q">Task contains</label>
          <form onSubmit={e => { e.preventDefault(); go({ q: text }); }}>
            <input id="q" type="search" value={text} placeholder="e.g. invoice"
                   onChange={e => setText(e.target.value)}
                   onBlur={() => { if (text !== (search ?? '')) go({ q: text }); }} />
          </form>
        </div>
      )}
      {anyActive && (
        <button className="secondary"
          onClick={() => router.push(grain ? `${basePath}?grain=${grain}` : basePath)}>
          Clear
        </button>
      )}
    </div>
  );
}
