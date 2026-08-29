/**
 * Canonical master data.
 *
 * This MUST stay identical to the seeds in apps-script/02_Setup.gs — the two
 * implementations have to agree or the same report produces different rows in
 * each. `web/tests/parity.test.ts` asserts that automatically.
 */
import type { Category, Department, Employee, Field, Masters } from './core/types';

export const STATUS_ALIASES: Record<string, string> = {
  'completed': 'Completed', 'complete': 'Completed', 'done': 'Completed',
  'finished': 'Completed', 'closed': 'Completed', 'delivered': 'Completed',
  'completd': 'Completed', 'compeleted': 'Completed', 'yes': 'Completed',
  'ok': 'Completed', 'over': 'Completed', '100%': 'Completed', 'c': 'Completed',
  'in progress': 'In Progress', 'inprogress': 'In Progress', 'in-progress': 'In Progress',
  'progress': 'In Progress', 'ongoing': 'In Progress', 'wip': 'In Progress',
  'working': 'In Progress', 'started': 'In Progress', 'doing': 'In Progress',
  'partially done': 'In Progress', 'partial': 'In Progress', 'ip': 'In Progress',
  'pending': 'Pending', 'waiting': 'Pending', 'not done': 'Pending',
  'incomplete': 'Pending', 'open': 'Pending', 'todo': 'Pending',
  'to do': 'Pending', 'hold': 'Pending', 'on hold': 'Pending', 'p': 'Pending',
  'blocked': 'Blocked', 'stuck': 'Blocked', 'blocker': 'Blocked',
  'dependency': 'Blocked', 'waiting on client': 'Blocked', 'awaiting approval': 'Blocked',
  'not started': 'Not Started', 'notstarted': 'Not Started', 'new': 'Not Started',
  'yet to start': 'Not Started', 'not yet started': 'Not Started', 'ns': 'Not Started',
  'cancelled': 'Cancelled', 'canceled': 'Cancelled', 'dropped': 'Cancelled',
  'not required': 'Cancelled', 'na': 'Cancelled', 'n/a': 'Cancelled'
};

/** Apps Script field names -> the web engine's camelCase field names. */
export const GAS_FIELD_TO_WEB: Record<string, Field> = {
  'Date': 'date', 'Employee_Name': 'employee', 'Employee_ID': 'employeeId',
  'Department': 'department', 'Task': 'task', 'Task_Category': 'category',
  'Task_Status': 'status', 'Priority': 'priority', 'Start_Date': 'startDate',
  'Start_Time': 'startTime', 'Completion_Date': 'completionDate',
  'Completion_Time': 'completionTime', 'Expected_Duration': 'expectedDuration',
  'Actual_Duration': 'actualDuration', 'Link': 'link', 'Notes': 'notes'
};

export const HEADER_ALIASES: Record<string, Field> = {
  'date': 'date', 'task date': 'date', 'report date': 'date', 'dt': 'date',
  'day': 'date', 'work date': 'date',
  'employee': 'employee', 'employee name': 'employee', 'name': 'employee',
  'staff': 'employee', 'team member': 'employee', 'member': 'employee',
  'assigned to': 'employee', 'owner': 'employee', 'resource': 'employee',
  'emp name': 'employee', 'person': 'employee',
  'employee id': 'employeeId', 'emp id': 'employeeId', 'empid': 'employeeId',
  'department': 'department', 'dept': 'department', 'team': 'department',
  'division': 'department', 'function': 'department',
  'task': 'task', 'task name': 'task', 'work': 'task', 'work done': 'task',
  'activity': 'task', 'description': 'task', 'task description': 'task',
  'details': 'task', 'particulars': 'task', 'job': 'task', 'work item': 'task',
  'today task': 'task', "today's task": 'task', 'tasks': 'task',
  'category': 'category', 'task category': 'category', 'type': 'category',
  'task type': 'category',
  'status': 'status', 'task status': 'status', 'current status': 'status',
  'progress': 'status', 'state': 'status', 'completion': 'status',
  'priority': 'priority', 'urgency': 'priority',
  'start date': 'startDate', 'started on': 'startDate',
  'start time': 'startTime', 'start': 'startTime', 'from': 'startTime',
  'completion date': 'completionDate', 'end date': 'completionDate',
  'completed on': 'completionDate',
  'completion time': 'completionTime', 'end time': 'completionTime',
  'finish time': 'completionTime', 'to': 'completionTime',
  'expected duration': 'expectedDuration', 'estimated hours': 'expectedDuration',
  'estimate': 'expectedDuration', 'planned hours': 'expectedDuration',
  'actual duration': 'actualDuration', 'hours spent': 'actualDuration',
  'time taken': 'actualDuration', 'hours': 'actualDuration',
  'link': 'link', 'links': 'link', 'url': 'link', 'reference': 'link',
  'attachment': 'link', 'proof': 'link', 'doc link': 'link',
  'remarks': 'notes', 'notes': 'notes', 'comment': 'notes',
  'comments': 'notes', 'observation': 'notes'
};

export const SEED_DEPARTMENTS: Department[] = [
  { id: 'DEP-01', name: 'Sales', aliases: ['sales team', 'bd', 'business development'], senderDomains: [] },
  { id: 'DEP-02', name: 'Marketing', aliases: ['mktg', 'growth', 'brand'], senderDomains: [] },
  { id: 'DEP-03', name: 'Operations', aliases: ['ops', 'operation', 'service delivery'], senderDomains: [] },
  { id: 'DEP-99', name: 'Unassigned', aliases: [], senderDomains: [] }
];

/**
 * expectedDuration is in HOURS, and null means "nobody has stated an
 * expectation". Never substitute 0 — that would make every task infinitely
 * slow, which is exactly the kind of invented insight this system avoids.
 */
export const SEED_CATEGORIES: Category[] = [
  { id: 'CAT-01', name: 'CRM Update', keywords: ['crm', 'salesforce', 'zoho', 'pipeline update'], expectedDuration: 0.5 },
  { id: 'CAT-02', name: 'Client Call', keywords: ['client call', 'customer call', 'demo call', 'meeting with client'], expectedDuration: 1 },
  { id: 'CAT-03', name: 'Proposal', keywords: ['proposal', 'quotation', 'quote', 'estimate', 'pitch deck'], expectedDuration: 3 },
  { id: 'CAT-04', name: 'Reporting', keywords: ['daily report', 'mis', 'report preparation', 'dashboard update'], expectedDuration: 1 },
  { id: 'CAT-05', name: 'Content Creation', keywords: ['blog', 'social post', 'creative', 'copy', 'newsletter'], expectedDuration: 4 },
  { id: 'CAT-06', name: 'Campaign Setup', keywords: ['campaign', 'ads', 'adwords', 'meta ads', 'google ads'], expectedDuration: 2.5 },
  { id: 'CAT-07', name: 'Order Processing', keywords: ['order', 'dispatch', 'invoice', 'shipment', 'packing'], expectedDuration: 0.75 },
  { id: 'CAT-08', name: 'Vendor Coordination', keywords: ['vendor', 'supplier', 'procurement', 'purchase order'], expectedDuration: 1.5 },
  { id: 'CAT-09', name: 'Support Ticket', keywords: ['ticket', 'support', 'complaint', 'escalation'], expectedDuration: 1 },
  { id: 'CAT-10', name: 'Internal Meeting', keywords: ['standup', 'internal meeting', 'review meeting', 'sync'], expectedDuration: 1 },
  { id: 'CAT-11', name: 'Documentation', keywords: ['sop', 'documentation', 'process doc', 'manual'], expectedDuration: 2 },
  { id: 'CAT-12', name: 'Data Entry', keywords: ['data entry', 'excel', 'sheet update', 'upload'], expectedDuration: 1 },
  { id: 'CAT-99', name: 'Uncategorised', keywords: [], expectedDuration: null }
];

export const SEED_EMPLOYEES: Employee[] = [
  { id: 'EMP-001', name: 'Rahul Mehta', aliases: ['rahul', 'rahul m'], department: 'Sales', active: true },
  { id: 'EMP-002', name: 'Priya Sharma', aliases: ['priya'], department: 'Sales', active: true },
  { id: 'EMP-003', name: 'Imran Khan', aliases: ['imran'], department: 'Sales', active: true },
  { id: 'EMP-004', name: 'Neha Gupta', aliases: ['neha'], department: 'Marketing', active: true },
  { id: 'EMP-005', name: 'Arjun Patel', aliases: ['arjun', 'arjun p'], department: 'Marketing', active: true },
  { id: 'EMP-006', name: 'Sana Qureshi', aliases: ['sana'], department: 'Marketing', active: true },
  { id: 'EMP-007', name: 'Vikas Nair', aliases: ['vikas'], department: 'Operations', active: true },
  { id: 'EMP-008', name: 'Deepa Iyer', aliases: ['deepa'], department: 'Operations', active: true },
  { id: 'EMP-009', name: 'Rohit Verma', aliases: ['rohit'], department: 'Operations', active: true },
  { id: 'EMP-010', name: 'Ayesha Siddiqui', aliases: ['ayesha', 'ayesha s'], department: 'Operations', active: true }
];

export function seedMasters(employees: Employee[] = SEED_EMPLOYEES): Masters {
  return {
    employees,
    departments: SEED_DEPARTMENTS,
    categories: SEED_CATEGORIES,
    statusAliases: STATUS_ALIASES,
    headerAliases: HEADER_ALIASES
  };
}

/** Masters with no employees — mirrors a fresh install before the roster is set. */
export function emptyRosterMasters(): Masters {
  return seedMasters([]);
}
