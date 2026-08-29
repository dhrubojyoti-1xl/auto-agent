# Connecting Gmail (what the manager actually does)

This is the entire end-user experience.

## Once

1. Open the app.
2. **Continue with Google.**
3. Choose the Google account that receives the department reports.
4. Google shows what is being requested. Leave **"Read your email messages and
   settings"** ticked — without it there is nothing to collect.
5. Approve.

You land on the Inbox page, the first sync starts by itself, and reports appear
on the Overview page within a minute or two.

## Then — nothing

Departments keep emailing reports exactly as they do today. The assistant:

- checks the inbox on a schedule
- reads each new message and any spreadsheet or CSV attached
- decides whether it is a report by looking for Date / Employee / Task / Status
  columns — **no labels, no filters, no rules to maintain**
- normalises statuses, names, dates and departments
- quarantines rows it cannot trust, with a reason, instead of guessing
- refuses to import the same report twice, however often it is re-sent
- updates the dashboard and regenerates the management summary

There is **no** labelling, forwarding, uploading, copy-pasting, script-running
or "process" button in the daily loop.

## What it can and cannot do to your mailbox

| | |
|---|---|
| Read messages and attachments | yes — this is the whole job |
| Send email | **no** |
| Delete or archive | **no** |
| Apply or change labels | **no** |
| Modify anything at all | **no** |

The app holds `gmail.readonly`, which Google will not honour for any write
operation. Revoke any time at <https://myaccount.google.com/permissions>; the
Inbox page then shows `REAUTH_REQUIRED` and collection stops.

## If a report is not picked up

Open **Data quality**. Every message the assistant examined is listed, including
the ones it decided were not reports and why. The usual causes:

| What you see | Meaning | Fix |
|---|---|---|
| Message not listed at all | outside the sync window (14 days by default) or not yet synced | press **Sync now** |
| `NO_DATA` | no table with Date/Employee/Task/Status columns | check the report actually has those column headings |
| `UNKNOWN_STATUS` | a status spelling nobody has mapped | add it to the status alias list |
| `INVALID_DATE` | unparseable date | check `DATE_ORDER` matches how the team writes dates |
| `MISSING_REQUIRED_FIELD` | a blank cell in Date/Employee/Task/Status | fix at source; the other rows still imported |

## Frequency

The scheduled sync runs daily on a Vercel Hobby plan, hourly on Pro. **Sync now**
is always available, and any external scheduler can drive
`GET /api/cron/sync` with the `CRON_SECRET` bearer token. See
[DEPLOYMENT.md](DEPLOYMENT.md).
