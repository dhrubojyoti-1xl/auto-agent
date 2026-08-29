/**
 * ============================================================================
 * 01_Schema.gs — every sheet, every column, in one place.
 * ============================================================================
 * Column order here IS the physical column order in the spreadsheet.
 * Never read a column by hard-coded index elsewhere; use col(sheetName, 'X').
 * ============================================================================
 */

const SHEETS = {
  CONFIG:        'Config',
  TASKS:         'Tasks',
  REPORTS:       'Reports',
  DATA_QUALITY:  'Data_Quality',
  EMPLOYEES:     'Employees',
  DEPARTMENTS:   'Departments',
  CATEGORIES:    'Task_Categories',
  STATUS:        'Statuses',
  STATUS_ALIAS:  'Status_Alias_Map',
  HEADER_ALIAS:  'Header_Alias_Map',
  DAILY:         'Daily_Summary',
  WEEKLY:        'Weekly_Summary',
  MONTHLY:       'Monthly_Summary',
  DEPT_SUMMARY:  'Department_Summary',
  EMP_SUMMARY:   'Employee_Summary',
  REPEATED:      'Repeated_Tasks',
  SLOW:          'Slow_Tasks',
  AI_REPORTS:    'AI_Reports',
  AI_DATASET:    'AI_Dataset',
  LOG:           'System_Log'
};

/** Canonical statuses. Order = display order on the dashboard. */
const STATUSES = ['Completed', 'In Progress', 'Pending', 'Blocked', 'Cancelled', 'Not Started'];

const SCHEMA = {};

SCHEMA[SHEETS.CONFIG] = {
  headers: ['Key', 'Value', 'Description'],
  freeze: 1
};

SCHEMA[SHEETS.TASKS] = {
  headers: [
    'Task_ID',              // TSK-<8 hex> — stable primary key
    'Report_ID',            // FK -> Reports.Report_ID (which email produced it)
    'Date',                 // real Date value, the business date of the task
    'Department',           // normalised department name
    'Employee_Name',        // normalised employee name (canonical spelling)
    'Employee_ID',          // FK -> Employees.Employee_ID
    'Task',                 // task text as reported (whitespace-cleaned only)
    'Task_Normalized',      // lowercased/punctuation-stripped, for matching
    'Task_Category',        // FK -> Task_Categories.Category_Name ('' if unknown)
    'Task_Status',          // one of STATUSES
    'Priority',             // High | Medium | Low | '' (optional input)
    'Start_Date',           // optional
    'Start_Time',           // optional HH:mm
    'Completion_Date',      // optional
    'Completion_Time',      // optional HH:mm
    'Expected_Duration',    // hours, from Task_Categories or the email
    'Actual_Duration',      // hours, computed from start/completion stamps
    'Duration_Basis',       // Reported | Derived | Insufficient Data
    'Link',                 // first URL found in the row
    'Source_Email_ID',      // Gmail message id — the idempotency anchor
    'Source_Email_Date',    // when the email was received
    'Imported_At',          // when this row was written
    'Data_Quality_Status',  // OK | Partial | Review
    'Data_Quality_Notes',   // why it is Partial/Review
    'Duplicate_Flag',       // TRUE only for rows deliberately kept as dupes
    'Task_Fingerprint',     // deterministic dedupe key (see 05_Ingest.gs)
    'Repeated_Task_Flag',   // set by analysis pass
    'Repeat_Classification',// Recurring / Potential Duplication / Highly Repetitive / Needs Review
    'Slow_Task_Flag',       // TRUE | FALSE | 'INSUFFICIENT_DATA'
    'Slow_Variance_Hours',  // Actual - Expected (blank when insufficient data)
    'Notes'
  ],
  freeze: 1,
  formats: {
    'Date': 'yyyy-mm-dd', 'Start_Date': 'yyyy-mm-dd', 'Completion_Date': 'yyyy-mm-dd',
    'Source_Email_Date': 'yyyy-mm-dd hh:mm', 'Imported_At': 'yyyy-mm-dd hh:mm:ss',
    'Expected_Duration': '0.00', 'Actual_Duration': '0.00', 'Slow_Variance_Hours': '0.00'
  }
};

SCHEMA[SHEETS.REPORTS] = {
  headers: [
    'Report_ID', 'Email_ID', 'Thread_ID', 'Email_Subject', 'Sender', 'Sender_Domain',
    'Department', 'Report_Date', 'Received_At', 'Processing_Status',
    'Tables_Found', 'Rows_Extracted', 'Rows_Inserted', 'Rows_Skipped_Idempotent',
    'Rows_Rejected', 'Error_Message', 'Processed_At', 'Run_ID'
  ],
  freeze: 1,
  formats: { 'Report_Date': 'yyyy-mm-dd', 'Received_At': 'yyyy-mm-dd hh:mm',
             'Processed_At': 'yyyy-mm-dd hh:mm:ss' }
};

SCHEMA[SHEETS.DATA_QUALITY] = {
  headers: [
    'Rejection_ID', 'Report_ID', 'Email_ID', 'Email_Subject', 'Sender',
    'Table_Index', 'Row_Index', 'Rejection_Reason', 'Rejection_Detail',
    'Raw_Date', 'Raw_Employee', 'Raw_Task', 'Raw_Status', 'Raw_Link',
    'Raw_Row_JSON', 'Logged_At', 'Resolution_Status'
  ],
  freeze: 1,
  formats: { 'Logged_At': 'yyyy-mm-dd hh:mm:ss' }
};

SCHEMA[SHEETS.EMPLOYEES] = {
  headers: ['Employee_ID', 'Employee_Name', 'Name_Aliases', 'Department', 'Active',
            'Joining_Date', 'Role', 'Email'],
  freeze: 1,
  formats: { 'Joining_Date': 'yyyy-mm-dd' }
};

SCHEMA[SHEETS.DEPARTMENTS] = {
  headers: ['Department_ID', 'Department_Name', 'Name_Aliases', 'Manager',
            'Manager_Email', 'Sender_Domains', 'Active'],
  freeze: 1
};

SCHEMA[SHEETS.CATEGORIES] = {
  headers: ['Category_ID', 'Category_Name', 'Match_Keywords', 'Expected_Duration',
            'Active', 'Notes'],
  freeze: 1,
  formats: { 'Expected_Duration': '0.00' }
};

SCHEMA[SHEETS.STATUS] = {
  headers: ['Status', 'Active', 'Counts_As_Completed', 'Is_Terminal', 'Sort_Order'],
  freeze: 1
};

SCHEMA[SHEETS.STATUS_ALIAS] = {
  headers: ['Alias', 'Canonical_Status'],
  freeze: 1
};

SCHEMA[SHEETS.HEADER_ALIAS] = {
  headers: ['Alias', 'Canonical_Field'],
  freeze: 1
};

SCHEMA[SHEETS.DAILY] = {
  headers: ['Period_Key', 'Date', 'Department', 'Total_Tasks', 'Completed', 'In_Progress',
            'Pending', 'Blocked', 'Cancelled', 'Not_Started', 'Completion_Rate',
            'Pending_Rate', 'Slow_Tasks', 'Repeated_Tasks', 'Employees_Reporting',
            'Prev_Completion_Rate', 'Completion_Rate_PP_Change', 'Updated_At'],
  freeze: 1,
  formats: { 'Date': 'yyyy-mm-dd', 'Completion_Rate': '0.0', 'Pending_Rate': '0.0',
             'Prev_Completion_Rate': '0.0', 'Completion_Rate_PP_Change': '+0.0;-0.0;0.0',
             'Updated_At': 'yyyy-mm-dd hh:mm:ss' }
};

SCHEMA[SHEETS.WEEKLY] = {
  headers: ['Period_Key', 'Week_Start', 'Week_End', 'Week_Label', 'Department',
            'Total_Tasks', 'Completed', 'In_Progress', 'Pending', 'Blocked', 'Cancelled',
            'Not_Started', 'Completion_Rate', 'Pending_Rate', 'Slow_Tasks',
            'Repeated_Tasks', 'Employees_Reporting', 'Prev_Completion_Rate',
            'Completion_Rate_PP_Change', 'Updated_At'],
  freeze: 1,
  formats: { 'Week_Start': 'yyyy-mm-dd', 'Week_End': 'yyyy-mm-dd',
             'Completion_Rate': '0.0', 'Pending_Rate': '0.0', 'Prev_Completion_Rate': '0.0',
             'Completion_Rate_PP_Change': '+0.0;-0.0;0.0', 'Updated_At': 'yyyy-mm-dd hh:mm:ss' }
};

SCHEMA[SHEETS.MONTHLY] = {
  headers: ['Period_Key', 'Month_Start', 'Month_Label', 'Department', 'Total_Tasks',
            'Completed', 'In_Progress', 'Pending', 'Blocked', 'Cancelled', 'Not_Started',
            'Completion_Rate', 'Pending_Rate', 'Slow_Tasks', 'Repeated_Tasks',
            'Employees_Reporting', 'Prev_Completion_Rate', 'Completion_Rate_PP_Change',
            'Updated_At'],
  freeze: 1,
  formats: { 'Month_Start': 'yyyy-mm-dd', 'Completion_Rate': '0.0', 'Pending_Rate': '0.0',
             'Prev_Completion_Rate': '0.0', 'Completion_Rate_PP_Change': '+0.0;-0.0;0.0',
             'Updated_At': 'yyyy-mm-dd hh:mm:ss' }
};

SCHEMA[SHEETS.DEPT_SUMMARY] = {
  headers: ['Department', 'Total_Tasks', 'Completed', 'In_Progress', 'Pending', 'Blocked',
            'Cancelled', 'Not_Started', 'Completion_Rate', 'Slow_Tasks', 'Repeated_Tasks',
            'Employees_Reporting', 'First_Report_Date', 'Last_Report_Date',
            'Last_7d_Tasks', 'Prev_7d_Tasks', 'Last_7d_Completion_Rate',
            'Prev_7d_Completion_Rate', 'WoW_PP_Change', 'Updated_At'],
  freeze: 1,
  formats: { 'First_Report_Date': 'yyyy-mm-dd', 'Last_Report_Date': 'yyyy-mm-dd',
             'Completion_Rate': '0.0', 'Last_7d_Completion_Rate': '0.0',
             'Prev_7d_Completion_Rate': '0.0', 'WoW_PP_Change': '+0.0;-0.0;0.0',
             'Updated_At': 'yyyy-mm-dd hh:mm:ss' }
};

SCHEMA[SHEETS.EMP_SUMMARY] = {
  headers: ['Employee_Name', 'Employee_ID', 'Department', 'Total_Tasks', 'Completed',
            'In_Progress', 'Pending', 'Blocked', 'Cancelled', 'Not_Started',
            'Completion_Rate', 'Slow_Tasks', 'Repeated_Tasks', 'Distinct_Days_Reported',
            'First_Report_Date', 'Last_Report_Date', 'Last_7d_Tasks', 'Prev_7d_Tasks',
            'Last_7d_Completion_Rate', 'Prev_7d_Completion_Rate', 'WoW_PP_Change',
            'Last_30d_Tasks', 'Prev_30d_Tasks', 'Data_Sufficiency', 'Updated_At'],
  freeze: 1,
  formats: { 'First_Report_Date': 'yyyy-mm-dd', 'Last_Report_Date': 'yyyy-mm-dd',
             'Completion_Rate': '0.0', 'Last_7d_Completion_Rate': '0.0',
             'Prev_7d_Completion_Rate': '0.0', 'WoW_PP_Change': '+0.0;-0.0;0.0',
             'Updated_At': 'yyyy-mm-dd hh:mm:ss' }
};

SCHEMA[SHEETS.REPEATED] = {
  headers: ['Repeat_Key', 'Employee', 'Department', 'Task', 'Normalized_Task',
            'Occurrence_Count', 'Distinct_Dates', 'Max_Same_Day_Count', 'First_Date', 'Last_Date',
            'Dates', 'Completed_Count', 'Open_Count', 'Classification', 'Classification_Reason',
            'Updated_At'],
  freeze: 1,
  formats: { 'First_Date': 'yyyy-mm-dd', 'Last_Date': 'yyyy-mm-dd',
             'Updated_At': 'yyyy-mm-dd hh:mm:ss' }
};

SCHEMA[SHEETS.SLOW] = {
  headers: ['Task_ID', 'Date', 'Department', 'Employee', 'Task', 'Task_Category',
            'Task_Status', 'Expected_Duration', 'Actual_Duration', 'Variance_Hours',
            'Variance_Pct', 'Duration_Basis', 'Link', 'Updated_At'],
  freeze: 1,
  formats: { 'Date': 'yyyy-mm-dd', 'Expected_Duration': '0.00', 'Actual_Duration': '0.00',
             'Variance_Hours': '0.00', 'Variance_Pct': '0.0', 'Updated_At': 'yyyy-mm-dd hh:mm:ss' }
};

SCHEMA[SHEETS.AI_REPORTS] = {
  headers: ['Report_ID', 'Report_Type', 'Period_Start', 'Period_End', 'Generated_At',
            'Generator', 'Model', 'Status', 'Summary', 'Human_Report', 'AI_JSON',
            'Validation_Error'],
  freeze: 1,
  formats: { 'Period_Start': 'yyyy-mm-dd', 'Period_End': 'yyyy-mm-dd',
             'Generated_At': 'yyyy-mm-dd hh:mm:ss' }
};

SCHEMA[SHEETS.AI_DATASET] = {
  headers: ['Generated_At', 'Report_Type', 'Period_Start', 'Period_End',
            'Prompt_For_Manual_Paste', 'Dataset_JSON', 'Paste_AI_JSON_Response_Here',
            'Import_Status'],
  freeze: 1,
  formats: { 'Generated_At': 'yyyy-mm-dd hh:mm:ss', 'Period_Start': 'yyyy-mm-dd',
             'Period_End': 'yyyy-mm-dd' }
};

SCHEMA[SHEETS.LOG] = {
  headers: ['Timestamp', 'Run_ID', 'Level', 'Component', 'Action', 'Status', 'Message',
            'Email_ID', 'Report_ID', 'Details'],
  freeze: 1,
  formats: { 'Timestamp': 'yyyy-mm-dd hh:mm:ss' }
};

/** Ordered list used by setup so tabs are created in a sensible order. */
const SHEET_ORDER = [
  SHEETS.CONFIG, SHEETS.TASKS, SHEETS.REPORTS, SHEETS.DATA_QUALITY,
  SHEETS.EMPLOYEES, SHEETS.DEPARTMENTS, SHEETS.CATEGORIES, SHEETS.STATUS,
  SHEETS.STATUS_ALIAS, SHEETS.HEADER_ALIAS,
  SHEETS.DAILY, SHEETS.WEEKLY, SHEETS.MONTHLY, SHEETS.DEPT_SUMMARY, SHEETS.EMP_SUMMARY,
  SHEETS.REPEATED, SHEETS.SLOW, SHEETS.AI_REPORTS, SHEETS.AI_DATASET, SHEETS.LOG
];

/** Canonical parser fields a table column can map to. */
const FIELDS = {
  DATE: 'Date', EMPLOYEE: 'Employee_Name', DEPARTMENT: 'Department', TASK: 'Task',
  CATEGORY: 'Task_Category', STATUS: 'Task_Status', PRIORITY: 'Priority',
  START_DATE: 'Start_Date', START_TIME: 'Start_Time',
  COMPLETION_DATE: 'Completion_Date', COMPLETION_TIME: 'Completion_Time',
  EXPECTED_DURATION: 'Expected_Duration', ACTUAL_DURATION: 'Actual_Duration',
  LINK: 'Link', NOTES: 'Notes', EMPLOYEE_ID: 'Employee_ID'
};

/** Fields that MUST be present and valid or the row is rejected. */
const REQUIRED_FIELDS = [FIELDS.DATE, FIELDS.EMPLOYEE, FIELDS.TASK, FIELDS.STATUS];
