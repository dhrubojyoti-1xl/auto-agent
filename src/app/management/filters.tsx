'use client';
import { useRouter } from 'next/navigation';
import type { Grain } from '@/lib/queries';

export default function Filters({
  departments, employees, grain, department, employee, from, to, minDate, maxDate
}: {
  departments: string[]; employees: string[]; grain: Grain;
  department?: string; employee?: string; from?: string; to?: string;
  minDate: string | null; maxDate: string | null;
}) {
  const router = useRouter();
  const go = (patch: Record<string, string>) => {
    const p = new URLSearchParams();
    Object.entries({ grain, department: department ?? '', employee: employee ?? '',
                     from: from ?? '', to: to ?? '', ...patch })
      .forEach(([k, v]) => { if (v && v !== 'all') p.set(k, String(v)); });
    router.push(`/management?${p.toString()}`);
  };

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
      {(department || employee || from || to) && (
        <button className="secondary"
          onClick={() => router.push(`/management?grain=${grain}`)}>Clear</button>
      )}
    </div>
  );
}
