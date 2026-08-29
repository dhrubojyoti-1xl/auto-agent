/**
 * ============================================================================
 * DEPARTMENT REPORT AUTOMATION  —  00_Config.gs
 * ============================================================================
 * SINGLE source of configuration. Nothing else in the project should contain
 * a tunable constant.
 *
 * Two layers:
 *   1. DEFAULT_CONFIG below (edit once at install time).
 *   2. The "Config" sheet in the spreadsheet (Key / Value) which OVERRIDES the
 *      defaults at runtime, so an operator can change behaviour without
 *      touching code. Use getConfig() everywhere, never DEFAULT_CONFIG.
 *
 * Secrets are NEVER stored here or in the sheet. See 08_AI.gs / setApiKey().
 * ============================================================================
 */

const DEFAULT_CONFIG = {

  // --- Spreadsheet ---------------------------------------------------------
  // Leave blank when the script is BOUND to the spreadsheet (recommended).
  // Fill in only if you run the script as a standalone project.
  SPREADSHEET_ID: '',
  TIMEZONE: 'Asia/Kolkata',

  // --- Gmail ingestion -----------------------------------------------------
  // Any thread matching SEARCH_QUERY is a candidate. Gmail search syntax.
  // Examples:
  //   'label:DAILY_REPORT -label:REPORT_PROCESSED'
  //   'subject:("daily report" OR "department report") newer_than:7d'
  //   'from:(@yourcompany.com) subject:"daily report" newer_than:14d'
  SEARCH_QUERY: 'label:DAILY_REPORT -label:REPORT_PROCESSED newer_than:30d',

  REPORT_LABEL:    'DAILY_REPORT',       // you (or a Gmail filter) apply this
  PROCESSED_LABEL: 'REPORT_PROCESSED',   // applied by the script on success
  ERROR_LABEL:     'REPORT_ERROR',       // applied when the email hard-fails
  REVIEW_LABEL:    'REPORT_REVIEW',      // applied when some rows were rejected

  MAX_EMAILS_PER_RUN: 50,
  MAX_RUNTIME_MS: 4 * 60 * 1000,         // stop cleanly before the 6-min limit

  // Extra detection rules applied AFTER the Gmail search. All are optional;
  // an empty array means "do not filter on this dimension".
  ALLOWED_SENDER_DOMAINS: [],            // e.g. ['1xl.com','partner.com']
  ALLOWED_SENDERS: [],                   // e.g. ['ops@1xl.com']
  SUBJECT_MUST_CONTAIN_ANY: [],          // e.g. ['daily report','dept report']
  REQUIRE_KNOWN_TABLE_HEADER: true,      // email must contain a mappable table

  // --- Parsing -------------------------------------------------------------
  DATE_ORDER: 'DMY',                     // 'DMY' or 'MDY' for ambiguous n/n/n
  MIN_TASK_LENGTH: 3,
  MAX_ROWS_PER_EMAIL: 2000,
  PARSE_PLAINTEXT_PIPE_TABLES: true,     // also accept "a | b | c" text tables
  MIN_HEADER_MATCHES: 3,                 // header cells that must be recognised

  // --- Data quality --------------------------------------------------------
  REJECT_UNKNOWN_STATUS: true,           // false = import as 'Unclassified'
  REJECT_UNKNOWN_EMPLOYEE: false,        // false = auto-add to Employees sheet
  AUTO_CREATE_EMPLOYEES: true,
  AUTO_CREATE_DEPARTMENTS: true,
  DEFAULT_DEPARTMENT: 'Unassigned',

  // --- Analysis ------------------------------------------------------------
  SLOW_TASK_MULTIPLIER: 1.5,             // actual > expected * this  => slow
  REPEAT_LOOKBACK_DAYS: 30,
  REPEAT_RECURRING_MIN: 3,               // >= this many distinct dates => recurring
  REPEAT_HIGH_MIN: 8,                    // >= this many occurrences  => highly repetitive
  REPEAT_SAME_DAY_REVIEW_MIN: 3,         // >= this many on ONE day  => needs review
  SIMILARITY_THRESHOLD: 0.88,            // token-set similarity for near matches

  // --- AI ------------------------------------------------------------------
  AI_ENABLED: false,                     // core system works with this false
  AI_PROVIDER: 'manual',                 // 'gemini' | 'custom_http' | 'manual'
  AI_MODEL: 'gemini-2.0-flash',
  AI_ENDPOINT: '',                       // only for AI_PROVIDER='custom_http'
  AI_MAX_RETRIES: 1,
  AI_TIMEOUT_NOTE: 'UrlFetchApp has no timeout option; keep payloads small.',

  // --- Reporting -----------------------------------------------------------
  MANAGEMENT_EMAIL: '',                  // blank = do not email the summary
  EMAIL_DAILY_REPORT: false,
  EMAIL_WEEKLY_REPORT: false,
  WEEK_START: 'MONDAY',

  // --- Triggers (hour of day, local TIMEZONE) ------------------------------
  TRIGGER_INGEST_EVERY_MINUTES: 30,      // 0 disables; else 5|10|15|30|60
  TRIGGER_DAILY_HOUR: 9,
  TRIGGER_WEEKLY_DAY: 'MONDAY',
  TRIGGER_WEEKLY_HOUR: 9,
  TRIGGER_MONTHLY_DAY: 1,
  TRIGGER_MONTHLY_HOUR: 9,

  // --- Housekeeping --------------------------------------------------------
  LOG_LEVEL: 'INFO',                     // DEBUG | INFO | WARN | ERROR
  LOG_MAX_ROWS: 20000                    // trimmed oldest-first beyond this
};

/** Config sheet keys that must be coerced to a type other than string. */
const CONFIG_TYPES = {
  MAX_EMAILS_PER_RUN: 'int', MAX_RUNTIME_MS: 'int', MIN_TASK_LENGTH: 'int',
  MAX_ROWS_PER_EMAIL: 'int', MIN_HEADER_MATCHES: 'int',
  REPEAT_LOOKBACK_DAYS: 'int', REPEAT_RECURRING_MIN: 'int',
  REPEAT_HIGH_MIN: 'int', REPEAT_SAME_DAY_REVIEW_MIN: 'int',
  AI_MAX_RETRIES: 'int', TRIGGER_INGEST_EVERY_MINUTES: 'int',
  TRIGGER_DAILY_HOUR: 'int', TRIGGER_WEEKLY_HOUR: 'int',
  TRIGGER_MONTHLY_DAY: 'int', TRIGGER_MONTHLY_HOUR: 'int',
  LOG_MAX_ROWS: 'int',
  SLOW_TASK_MULTIPLIER: 'float', SIMILARITY_THRESHOLD: 'float',
  REQUIRE_KNOWN_TABLE_HEADER: 'bool', PARSE_PLAINTEXT_PIPE_TABLES: 'bool',
  REJECT_UNKNOWN_STATUS: 'bool', REJECT_UNKNOWN_EMPLOYEE: 'bool',
  AUTO_CREATE_EMPLOYEES: 'bool', AUTO_CREATE_DEPARTMENTS: 'bool',
  AI_ENABLED: 'bool', EMAIL_DAILY_REPORT: 'bool', EMAIL_WEEKLY_REPORT: 'bool',
  ALLOWED_SENDER_DOMAINS: 'list', ALLOWED_SENDERS: 'list',
  SUBJECT_MUST_CONTAIN_ANY: 'list'
};

var __CONFIG_CACHE = null;

/**
 * Returns the effective configuration (defaults + Config sheet overrides).
 * Cached for the life of one execution.
 */
function getConfig() {
  if (__CONFIG_CACHE) return __CONFIG_CACHE;
  const cfg = {};
  Object.keys(DEFAULT_CONFIG).forEach(function (k) { cfg[k] = DEFAULT_CONFIG[k]; });
  try {
    const ss = openSpreadsheet_();
    const sh = ss.getSheetByName(SHEETS.CONFIG);
    if (sh && sh.getLastRow() > 1) {
      const rows = sh.getRange(2, 1, sh.getLastRow() - 1, 2).getValues();
      rows.forEach(function (r) {
        const key = String(r[0] || '').trim();
        if (!key || !(key in cfg)) return;
        cfg[key] = coerceConfigValue_(key, r[1]);
      });
    }
  } catch (e) {
    // Config sheet not created yet (first run of setup) — defaults are fine.
  }
  __CONFIG_CACHE = cfg;
  return cfg;
}

function coerceConfigValue_(key, raw) {
  const t = CONFIG_TYPES[key] || 'string';
  const s = String(raw === null || raw === undefined ? '' : raw).trim();
  switch (t) {
    case 'int':   return s === '' ? DEFAULT_CONFIG[key] : parseInt(s, 10);
    case 'float': return s === '' ? DEFAULT_CONFIG[key] : parseFloat(s);
    case 'bool':  return /^(true|yes|1|y)$/i.test(s);
    case 'list':  return s === '' ? [] : s.split(',').map(function (x) { return x.trim(); })
                                          .filter(function (x) { return x; });
    default:      return s;
  }
}

/** Clears the in-execution config cache (used by tests). */
function resetConfigCache() { __CONFIG_CACHE = null; }
