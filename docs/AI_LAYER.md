# The AI layer — optional, cheap, and not trusted

The core system does not need AI. `AI_ENABLED` ships as `FALSE` and the daily,
weekly and monthly reports are fully written without it. What the AI adds is
*commentary*: explaining a trend, naming an anomaly, interpreting a repeat
pattern. It is never allowed to produce a number.

---

## 1. The separation of concerns

```
Google Sheets  ──►  buildAiDataset_()  ──►  the model  ──►  validateAiJson_()  ──►  report
   facts            pre-computed JSON      commentary       fact-check gate
```

- **Everything countable is computed before the model is called.** Totals, rates,
  status splits, slow-task variances, repeat classifications, data-quality
  counters — all deterministic.
- The model receives that JSON and nothing else. No raw email, no sheet access.
- The reply is parsed, schema-checked, and **cross-checked against the dataset**.
  Claims about departments, employees, task ids or rates that do not exist in
  the dataset are deleted and recorded in `AI_Reports.Validation_Error`.

---

## 2. Choosing a provider

Set `AI_PROVIDER` on the **Config** sheet.

### `manual` (default — genuinely free, no account, no key)

1. Menu → **Department Reporting → AI (optional) → Build AI dataset + prompt (daily)**.
2. Open the `AI_Dataset` sheet. Copy cell **E** (the prompt) and cell **F**
   (the dataset) into any free chatbot.
3. Paste its JSON reply into cell **G** of the same row.
4. Menu → **Department Reporting → AI (optional) → Import pasted AI JSON**.

The reply goes through exactly the same validation gate as an API reply. If it
is not valid JSON, `Import_Status` becomes `PARSE_FAILED` and nothing is
published.

This mode is honestly semi-automatic — it is one copy-paste per *report*, not
per *email*, and it replaces the daily copy-paste of raw tables that this whole
project exists to eliminate.

### `gemini` (free tier, revocable)

1. Get a key at <https://aistudio.google.com/app/apikey>.
2. Menu → **AI (optional) → Store AI API key**, and paste it (or run `setApiKey()` in the editor). It is stored in
   **Script Properties**, never in a cell and never in code.
3. Config sheet: `AI_ENABLED = TRUE`, `AI_PROVIDER = gemini`,
   `AI_MODEL = gemini-2.0-flash`.

Free-tier quotas and model availability are Google's to change. The code treats
any failure as normal: it retries once, then falls back to the deterministic
report and records why.

### `custom_http` (self-hosted / open-source model)

Any endpoint that speaks the OpenAI `/chat/completions` shape works — llama.cpp
server, vLLM, LM Studio, Ollama behind a compatibility proxy.

**Apps Script cannot reach `localhost`.** Google's servers run the script, so a
model on your laptop is invisible to it. Free routes that do work:

- Expose the local server through a free tunnel (`cloudflared tunnel --url
  http://localhost:11434`) and put the public URL in `AI_ENDPOINT`. The tunnel
  URL changes on restart, so update the Config cell when it does.
- Run the model on a machine that already has a public address.
- Keep `AI_PROVIDER = manual` and paste into your local chat UI. Same result,
  zero infrastructure.

Set `AI_ENDPOINT` (full URL) and, if the server wants one, store a bearer token
via `setApiKey()`.

---

## 3. The exact system prompt

Used verbatim by every provider and by manual mode (`AI_SYSTEM_PROMPT` in
`09_AI.gs`):

```
You are a management reporting analyst. You interpret a pre-computed dataset
about departmental task reporting. You never compute or estimate numbers
yourself.

ABSOLUTE RULES
1. Use ONLY the JSON dataset provided. Nothing else exists.
2. Never invent or alter a task count, completion rate, employee, department,
   category, task, or duration. Every number you write must appear verbatim in
   the dataset.
3. Never call a task slow unless it appears in dataset.slow_tasks.
4. Never call an employee underperforming. Task counts measure reported
   activity, not value or complexity. Where data_sufficiency says
   "Insufficient — do not rank", do not compare that person to anyone.
5. Repetition is not automatically waste. Respect the classification already
   assigned to each repeated task group.
6. Express changes in completion rate as percentage POINTS (e.g. "80% to 85% is
   +5 percentage points"), never as a percentage change.
7. Separate FACT (restating dataset values) from INTERPRETATION (your
   inference). Mark interpretation with the "interpretation" field where the
   schema provides one.
8. If the dataset cannot support a section, write exactly "Insufficient data."
   for it.
9. Output ONE JSON object and nothing else. No prose, no markdown, no code
   fences.
```

followed by the output schema (see §4), then the user message:

```
DATASET (authoritative, pre-computed):
{ ...the JSON... }

Produce the JSON object described in the system rules for the DAILY period
2026-08-28 to 2026-08-28. Output JSON only.
```

Temperature is fixed at 0.2. For Gemini, `responseMimeType: application/json`
is set so the model is constrained to JSON at the API level too.

---

## 4. The JSON contract

```json
{
  "summary": "3-5 sentence executive summary.",
  "overall_completion_rate": 46.2,
  "department_observations": [
    {"department": "Sales", "observation": "", "interpretation": "",
     "confidence": "high|medium|low"}
  ],
  "attention_items": [
    {"item": "", "why_it_matters": "", "supporting_data": "", "suggested_action": ""}
  ],
  "slow_tasks":     [{"task_id": "TSK-…", "comment": ""}],
  "repeated_tasks": [{"employee": "", "task": "", "classification": "", "comment": ""}],
  "trends":         ["", ""],
  "data_quality":   ["", ""]
}
```

Two fields exist purely as anti-hallucination devices:

- `supporting_data` forces the model to quote the dataset numbers it relied on,
  which makes a fabricated claim obvious to a reader.
- `confidence` separates "the data says" from "I think".

---

## 5. What the validator actually enforces

`validateAiJson_()` in `09_AI.gs`:

| Check | On failure |
|---|---|
| Response parses as JSON (bare, or inside ``` fences, or embedded in prose) | retry once; then deterministic fallback |
| `summary` is a non-empty string | error recorded |
| `overall_completion_rate` within 0.11 of the dataset value | **dataset value substituted**, error recorded |
| every `department_observations[].department` exists in the dataset | observation dropped |
| every `slow_tasks[].task_id` exists in `dataset.slow_tasks` | comment dropped |
| every `repeated_tasks` entry matches a real (employee, task) group | comment dropped |
| `confidence` ∈ {high, medium, low} | coerced to `low` |
| numeric slow-task figures | **always taken from the dataset**, never from the model |
| `attention_items` | capped at 10; `trends`/`data_quality` capped at 10 |

Two self-tests cover this:

```
PASS  AI validation rejects an invented department
PASS  AI validation overrides a wrong completion rate
```

Anything dropped is written to `AI_Reports.Validation_Error` and the report
status becomes `OK_AI_PARTIAL`, which the report's PROVENANCE footer states
explicitly.

---

## 6. Failure behaviour

| Situation | What happens |
|---|---|
| `AI_ENABLED = FALSE` | deterministic commentary; status `OK_NO_AI` |
| API error / quota / network | retry once, then deterministic; status `OK_AI_UNAVAILABLE`; reason logged |
| Non-JSON reply twice | same as above |
| Valid JSON, some invented claims | invented parts removed; status `OK_AI_PARTIAL` |
| `manual` mode, nothing pasted yet | report published with deterministic commentary; status `OK_AWAITING_MANUAL_AI` |

**A report is always produced.** The dashboard never waits on a model.

---

## 7. Security

- The key lives in `PropertiesService.getScriptProperties()`. Not in code, not
  in a cell, not in the Config sheet, not in the log.
- `setApiKey()` reads it from a prompt dialog so it never enters the source.
- `clearApiKey()` removes it.
- The dataset sent to a third-party model contains employee names, task text and
  department names. If that is not acceptable under your data policy, use
  `manual` mode with a local model, or add a pseudonymisation step in
  `buildAiDataset_()` before the call — the function is the single choke point,
  by design.
