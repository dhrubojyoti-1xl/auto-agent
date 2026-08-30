/**
 * Shared types for the reporting engine.
 *
 * The engine is PURE: it never touches a database, a network or a clock it was
 * not given. Everything it needs arrives as arguments. That is what lets the
 * same code run in a Next.js route handler, in a test, and (as the Apps Script
 * original) inside Google Sheets.
 */

export const STATUSES = [
  'Completed', 'In Progress', 'Pending', 'Blocked', 'Not Started', 'Cancelled'
] as const;
export type TaskStatus = typeof STATUSES[number];

export const REQUIRED_FIELDS = ['date', 'employee', 'task', 'status'] as const;

/** A canonical field a report column can map to. */
export type Field =
  | 'date' | 'employee' | 'employeeId' | 'department' | 'task' | 'category'
  | 'status' | 'priority' | 'startDate' | 'startTime' | 'completionDate'
  | 'completionTime' | 'expectedDuration' | 'actualDuration' | 'link' | 'notes';

export interface Cell { text: string; href: string }
export interface Table {
  index: number;
  rows: Cell[][];
  source: 'html' | 'text';
  /** Worksheet name, when the table came from a workbook. Evidence for the department. */
  sheetName?: string;
}
/**
 * How one column came to be mapped, kept so a decision can be explained and
 * audited rather than merely trusted.
 */
export interface ColumnDecision {
  column: number;
  header: string;
  field: Field;
  confidence: number;
  evidence: string;
  source: 'alias' | 'header semantics' | 'values';
}

export interface HeaderMap {
  headerRowIndex: number;
  mapping: Partial<Record<Field, number>>;
  matches: number;
  partialHeader?: boolean;
  /** Columns resolved from their contents rather than their heading. */
  decisions?: ColumnDecision[];
}

export interface Employee {
  id: string;
  name: string;
  aliases: string[];
  department: string;
  active: boolean;
}
export interface Department {
  id: string;
  name: string;
  aliases: string[];
  senderDomains: string[];
}
export interface Category {
  id: string;
  name: string;
  keywords: string[];
  /** Hours. null means "nobody has stated an expectation" — never treat as 0. */
  expectedDuration: number | null;
}

/** Everything the engine needs to know about the organisation. */
export interface Masters {
  employees: Employee[];
  departments: Department[];
  categories: Category[];
  /** normalised alias -> canonical status */
  statusAliases: Record<string, string>;
  /** normalised alias -> canonical field */
  headerAliases: Record<string, Field>;
}

export interface EngineConfig {
  dateOrder: 'DMY' | 'MDY';
  minTaskLength: number;
  minHeaderMatches: number;
  maxRowsPerDocument: number;
  rejectUnknownStatus: boolean;
  autoCreateEmployees: boolean;
  defaultDepartment: string;
  slowTaskMultiplier: number;
  repeatLookbackDays: number;
  repeatRecurringMin: number;
  repeatHighMin: number;
  repeatSameDayReviewMin: number;
  similarityThreshold: number;
  weekStart: 'MONDAY' | 'SUNDAY';
}

export const DEFAULT_ENGINE_CONFIG: EngineConfig = {
  dateOrder: 'DMY',
  minTaskLength: 3,
  minHeaderMatches: 3,
  maxRowsPerDocument: 2000,
  rejectUnknownStatus: true,
  autoCreateEmployees: true,
  defaultDepartment: 'Unassigned',
  slowTaskMultiplier: 1.5,
  repeatLookbackDays: 30,
  repeatRecurringMin: 3,
  repeatHighMin: 8,
  repeatSameDayReviewMin: 3,
  similarityThreshold: 0.88,
  weekStart: 'MONDAY'
};

export type DurationBasis = 'Reported' | 'Derived' | 'Insufficient Data';
export type SlowFlag = 'TRUE' | 'FALSE' | 'INSUFFICIENT_DATA';
export type RepeatClassification =
  | 'Recurring / Legitimate' | 'Potential Duplication'
  | 'Highly Repetitive' | 'Needs Review';

export interface TaskRecord {
  taskId: string;
  reportId: string;
  date: string;                 // yyyy-mm-dd, business date, never a timestamp
  department: string;
  employeeName: string;
  employeeId: string;
  task: string;
  taskNormalized: string;
  taskCategory: string;
  taskStatus: TaskStatus;
  priority: string;
  startDate: string | null;
  startTime: string | null;
  completionDate: string | null;
  completionTime: string | null;
  expectedDuration: number | null;
  actualDuration: number | null;
  durationBasis: DurationBasis;
  link: string;
  sourceDocumentId: string;
  sourceDocumentDate: string;
  dataQualityStatus: 'OK' | 'Partial' | 'Review';
  dataQualityNotes: string;
  taskFingerprint: string;
  /** Which stream of work the column this came from described. */
  workKind?: string;
  notes: string;
}

export type RejectionReason =
  | 'MISSING_REQUIRED_FIELD' | 'INVALID_DATE' | 'UNKNOWN_STATUS'
  | 'UNKNOWN_EMPLOYEE' | 'TASK_TOO_SHORT' | 'TASK_NOT_MEANINGFUL'
  | 'DUPLICATE_ACROSS_DOCUMENTS';

export interface RejectedRow {
  reportId: string;
  documentId: string;
  tableIndex: number;
  rowIndex: number;
  reason: RejectionReason;
  detail: string;
  raw: Record<string, string>;
}

/** A document is an email, one attachment of an email, or a pasted report. */
export interface SourceDocument {
  documentId: string;
  subject: string;
  sender: string;
  receivedAt: string;           // ISO
  html?: string;
  text?: string;
  /**
   * Pre-parsed tables, used when the content did not arrive as HTML or text —
   * an XLSX attachment, for example. When present these are used verbatim and
   * html/text are ignored, so a spreadsheet and an inline table travel through
   * exactly the same validation, normalisation and deduplication path.
   */
  tables?: Table[];
  /** Filename when this document is an attachment rather than a body. */
  attachmentName?: string;
  /**
   * The covering text of the email this document came from.
   *
   * A spreadsheet arrives with a sentence — "Sales team update for yesterday"
   * — and that sentence is often the only statement of which department the
   * report is for and which day it covers. Carrying it onto the attachment
   * keeps the two halves of one report together.
   */
  contextText?: string;
}

export interface IngestResult {
  /**
   * Every department the accepted rows belong to. One report may span several;
   * `department` is set only when they all agree.
   */
  departments?: string[];
  reportId: string;
  status: 'SUCCESS' | 'PARTIAL' | 'NO_DATA';
  department: string;
  reportDate: string | null;
  tablesFound: number;
  rowsExtracted: number;
  accepted: TaskRecord[];
  rejected: RejectedRow[];
  skippedIdempotent: number;
  newEmployees: Employee[];
  message: string;
}
