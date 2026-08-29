# Attachment formats

What is actually implemented and tested. Nothing here is aspirational.

| Format | Status | How |
|---|---|---|
| Inline HTML table | **supported** | `src/lib/core/html-table.ts` |
| Plain-text `a \| b \| c` | **supported** | same file, pipe-table fallback |
| `.xlsx` | **supported** | exceljs |
| `.xlsm` | **supported** | same reader (macro-enabled workbooks use the same OOXML container) |
| `.csv` | **supported** | hand-written RFC 4180 parser |
| `.tsv` | **supported** | same parser, tab delimiter |
| `.xls` (old binary) | **not supported** | exceljs cannot read it; `attachmentToTables` returns `[]` and the message is recorded as not-a-report rather than failing |
| `.pdf` | **not supported** | no PDF table extraction is implemented |
| Images | **ignored by design** | no OCR |

## How a spreadsheet becomes tasks

```
Gmail attachment → downloaded server-side into memory
  → attachmentToTables() → Table[]  (the same shape the HTML parser emits)
  → mapHeaderRow()  → is this a report?
  → the SAME validation, normalisation, fingerprinting as an inline table
```

Because the shapes converge, a report sent as CSV and the same report sent as
XLSX produce **identical fingerprints** — asserted in
`tests/attachments.test.ts`. The format it arrives in cannot create a duplicate.

## Details that matter

**Every worksheet is a candidate.** Workbooks routinely hold one sheet per
department. Sheets that are not reports simply fail header mapping, so there is
no guessing.

**Excel dates are read as dates** and emitted as `yyyy-mm-dd`. Stringifying
through a locale is how `03/04` flips between March and April.

**The CSV parser is hand-written** because the awkward cases are the whole job:
quoted fields containing the delimiter, escaped `""` quotes, and embedded
newlines. `split(',')` mangles exactly the rows people care about — task
descriptions with commas in them. Delimiter is sniffed from the first five lines.

**A UTF-8 BOM is stripped**, or the first header never maps.

**Size limit:** `MAX_ATTACHMENT_BYTES` (default 8 MB). Larger attachments are
skipped rather than pulled into a serverless function's memory.

## An email with both a body table and an attachment

Each becomes its own document (`gmail:<id>` and `gmail:<id>:<filename>`), ingested
separately. Rows that genuinely repeat across the two are caught by the
fingerprint, so no duplicates — and the source of every row stays traceable in
`documents.attachment_name`.
