# Snapper — Sales Analyst, ICP Intelligence

**Snapper** is a Sales Analyst agent that builds and maintains a structured Ideal Customer Profile (ICP) knowledge base from CRM data. It reads every lead that has ever entered the pipeline, looks for patterns across geography, product interest, industry, deal size, and conversion behaviour, and writes its findings to a living document that gets smarter every day.

Snapper does not make recommendations. Its job is to gather signal accurately and surface it clearly — so the humans doing strategy actually have something real to work with.

---

## What Snapper does

1. **Reads the CRM**
   Connects to the Leads tab of a Google Sheet and pulls every relevant field: entry date, status, primary and secondary products, industry, source, country, estimated TTV, use case, and notes.

2. **Analyses the data**
   Sends the leads to Gemini in structured batches. For each batch, Snapper extracts patterns across status distribution, product demand, geography, lead source, deal size, and data completeness. It always distinguishes between three tiers: all leads, leads that reached Integrating or beyond, and leads that went Live — because that distinction is where the real ICP signal lives.

3. **Writes an ICP analysis document**
   Synthesises everything into a clear, structured Google Doc covering eight analysis areas. The document is written in prose with supporting counts and percentages, not raw data dumps.

4. **Stays current**
   Runs daily. Each day, Snapper reads the full sheet and compares it against a snapshot of the last known state. It picks up two things: leads that are new, and leads whose status changed — for example, a lead that was Engaged six months ago and is now Live. Both feed into the update. If nothing moved, Snapper logs that and goes quiet.

---

## How runs work

### First run — Bootstrap

Snapper processes the entire lead history in batches of 1,000 rows to stay within API rate limits. It makes up to four Gemini requests (one per batch, plus a synthesis), waits 15 seconds between each, and writes a full ICP analysis document when done.

After a successful bootstrap, Snapper saves its current understanding of the ICP as structured JSON in `state.json` and switches itself to incremental mode for every future run.

### Daily runs — Incremental

Snapper reads the full sheet on every run and compares it against a status snapshot stored from the previous run. It looks for two things:

- **New leads** — rows that weren't in the sheet last time
- **Status changes** — existing leads whose status is different from what was recorded (e.g. Engaged → Live, Integrating → Transacting)

If either list is non-empty, Snapper sends both to Gemini alongside the existing ICP summary and asks for an updated summary plus a short prose note on what shifted. The note is appended to the Google Doc. If nothing changed, Snapper logs that and exits cleanly — no Gemini requests, no writes, no noise.

**Gemini request budget:** 4 on first run, 1 per day thereafter (or 0 if nothing changed).

---

## Analysis areas

Every section distinguishes between **All Leads**, **Integrating+**, and **Live**:

1. **Geographic distribution** — countries by tier, strongest lead-to-live conversion rates
2. **Product demand** — most requested products, common combinations, broken down by tier
3. **Industry breakdown** — which industries appear most, which convert best
4. **Source analysis** — Inbound / Referral / Events / Outbound, by tier
5. **TTV distribution** — spread of estimated deal value across tiers
6. **Use case patterns** — themes among leads that converted vs those that did not
7. **Stall and drop-off patterns** — where leads go quiet and what they have in common
8. **Data quality summary** — field-by-field population rates across the full dataset

---

## Environment variables

| Variable | Description |
|---|---|
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Full service account JSON (paste the entire file contents). Preferred over individual key vars — avoids key-encoding issues on Railway. |
| `SPREADSHEET_ID` | Google Sheet ID (from the URL). |
| `OUTPUT_DOC_ID` | Google Doc ID where Snapper writes its analysis. |
| `GEMINI_API_KEY` | Gemini API key. |
| `GEMINI_MODEL` | Optional. Defaults to `gemini-2.5-flash`. |

> **Note:** `GOOGLE_SERVICE_ACCOUNT_JSON` is the recommended approach. If absent, Snapper falls back to `GOOGLE_SERVICE_ACCOUNT_EMAIL` + `GOOGLE_PRIVATE_KEY` individually — but this is less reliable on Railway due to how multi-line env vars are stored.

---

## Google setup

### Sheets
1. The CRM must have a tab named **Leads** with the expected column layout (Entry Date in col E, Status in col H, etc. — see `src/sheets.js` for the full mapping).
2. Share the sheet with the service account email (Viewer access is sufficient).

### Docs
1. Create a Google Doc and copy its ID from the URL.
2. Share it with the service account email (Editor access required).
3. The doc can be empty on first run — Snapper will write the full analysis. Do not pre-populate it.

### Service account
1. Create a service account in Google Cloud with the **Google Sheets API** and **Google Docs API** enabled.
2. Download the JSON key file.
3. Paste the entire file contents into `GOOGLE_SERVICE_ACCOUNT_JSON` in Railway.

---

## State

Snapper stores its run state in `state.json` in the project root:

```json
{
  "runMode": "incremental",
  "lastRunDate": "2026-03-09",
  "icpSummary": { ... },
  "rowStatuses": {
    "0": "Live",
    "1": "Integrating",
    "2": "Engaged",
    ...
  }
}
```

- `runMode` — `"bootstrap"` on first run, `"incremental"` thereafter
- `lastRunDate` — ISO date of the last successful run
- `icpSummary` — structured JSON summary of the current ICP understanding (passed to Gemini on each incremental run)
- `rowStatuses` — snapshot of every lead's status at the time of the last run, keyed by row index; used to detect status changes between runs

**State is only written after a fully successful run.** If Sheets, Gemini, or Docs fails at any point, `state.json` is left unchanged so the next run picks up cleanly. Any output that could not be written to the doc is logged to console so it is not lost.

---

## Deploying on Railway

1. Create a Node.js service and connect the GitHub repo.
2. Set all required environment variables.
3. Set the **Start Command** to `npm start`.
4. Add a **Cron** trigger — daily is recommended (e.g. `0 7 * * *`).
5. Deploy. The first run will bootstrap the full lead history. Every subsequent run is incremental.

### Running locally

```bash
npm install
```

Create a `.env` file with the variables above, then:

```bash
npm start
```

To force a re-bootstrap (e.g. after the CRM structure changes), reset `state.json`:

```json
{
  "runMode": "bootstrap",
  "lastRunDate": null,
  "icpSummary": null,
  "rowStatuses": null
}
```
