require('dotenv').config();

const { readState, writeState } = require('./state');
const { readAllLeads } = require('./sheets');
const { writeBootstrapDocument, appendToDocument } = require('./docs');
const { analyzeAllBatches, synthesize, runIncrementalUpdate } = require('./gemini');

const BATCH_DELAY_MS = 15_000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function todayIso() {
  return new Date().toISOString().split('T')[0];
}

/**
 * Strip markdown symbols from Gemini prose output before writing to Google Docs.
 * The prompts explicitly ask for plain text, but this is a safety net in case
 * the model adds formatting anyway.
 */
function stripMarkdown(text) {
  return text
    .replace(/^#{1,6} /gm, '')           // ## Heading → Heading
    .replace(/\*\*(.+?)\*\*/g, '$1')     // **bold** → bold
    .replace(/\*(.+?)\*/g, '$1')         // *italic* → italic
    .replace(/`(.+?)`/g, '$1')           // `code` → code
    .replace(/^[ \t]*[*-] /gm, '');      // - item / * item → item (plain)
}

/**
 * Build a row-index → status snapshot from a full rows array.
 * Stored in state.json so incremental runs can detect status changes.
 */
function buildRowStatuses(rows) {
  const map = {};
  rows.forEach((row, idx) => {
    map[String(idx)] = row.status;
  });
  return map;
}

/**
 * Diff current rows against the stored status snapshot.
 * Returns:
 *   newLeads      — rows at an index not previously seen
 *   changedLeads  — rows where status differs from the stored value
 *                   (includes a `previousStatus` field)
 */
function diffLeads(currentRows, storedStatuses) {
  const newLeads = [];
  const changedLeads = [];

  currentRows.forEach((row, idx) => {
    const key = String(idx);
    if (!(key in storedStatuses)) {
      newLeads.push(row);
    } else if (row.status !== storedStatuses[key]) {
      changedLeads.push({ ...row, previousStatus: storedStatuses[key] || 'unknown' });
    }
  });

  return { newLeads, changedLeads };
}

async function bootstrap(runDate) {
  console.log('Reading all leads from Leads tab...');
  let rows;
  try {
    rows = await readAllLeads();
  } catch (err) {
    console.error('Sheets API error — aborting:', err.message);
    process.exit(1);
  }
  console.log(`Read ${rows.length} rows.`);

  let batchSummaries, icpSummary;
  try {
    ({ batchSummaries, icpSummary } = await analyzeAllBatches(rows));
  } catch (err) {
    console.error('Batch analysis failed — aborting:', err.message);
    process.exit(1);
  }

  console.log(`Waiting ${BATCH_DELAY_MS / 1000}s before synthesis request...`);
  await sleep(BATCH_DELAY_MS);
  console.log('Running synthesis...');

  let prose;
  try {
    prose = await synthesize(batchSummaries, rows.length, runDate);
  } catch (err) {
    console.error('Synthesis request failed — aborting.');
    console.error('Error:', err.message);
    console.log('\n=== BATCH SUMMARIES (do not lose these) ===');
    console.log(JSON.stringify(batchSummaries, null, 2));
    process.exit(1);
  }

  console.log('Writing to Google Doc...');
  try {
    await writeBootstrapDocument(stripMarkdown(prose));
  } catch (err) {
    console.error('Docs API write failed — aborting. Do not update state.');
    console.error('Error:', err.message);
    console.log('\n=== FULL ANALYSIS OUTPUT (do not lose this) ===');
    console.log(prose);
    process.exit(1);
  }

  writeState({
    lastRunDate: runDate,
    icpSummary,
    runMode: 'incremental',
    rowStatuses: buildRowStatuses(rows),
  });

  console.log(`Bootstrap complete. Processed ${rows.length} rows. State saved.`);
}

async function incremental(runDate, state) {
  // ── Migration ────────────────────────────────────────────────────────────
  // First run after this update: state has an icpSummary but no rowStatuses
  // snapshot. Build the snapshot silently (no Gemini call) so the next run
  // can diff correctly. The existing analysis doc is untouched.
  if (!state.rowStatuses) {
    console.log('Building initial row status snapshot (one-time migration, no Gemini call)...');
    let allRows;
    try {
      allRows = await readAllLeads();
    } catch (err) {
      console.error('Sheets API error — aborting:', err.message);
      process.exit(1);
    }
    writeState({ ...state, rowStatuses: buildRowStatuses(allRows) });
    console.log(`Snapshot built for ${allRows.length} rows. Next run will be fully incremental.`);
    process.exit(0);
  }

  // ── Normal incremental run ────────────────────────────────────────────────
  // Read every row so we can detect both new leads AND status changes on
  // existing leads (e.g. a lead that was "Engaged" last month and is now "Live").
  console.log('Reading all leads to detect new rows and status changes...');
  let allRows;
  try {
    allRows = await readAllLeads();
  } catch (err) {
    console.error('Sheets API error — aborting:', err.message);
    process.exit(1);
  }

  const { newLeads, changedLeads } = diffLeads(allRows, state.rowStatuses);

  if (newLeads.length === 0 && changedLeads.length === 0) {
    console.log('No new leads or status changes since last run. Nothing to do.');
    process.exit(0);
  }

  console.log(`Found ${newLeads.length} new lead(s) and ${changedLeads.length} status change(s).`);

  let updatedIcpSummary, updateNote;
  try {
    ({ updatedIcpSummary, updateNote } = await runIncrementalUpdate(
      state.icpSummary,
      newLeads,
      changedLeads,
      runDate
    ));
  } catch (err) {
    console.error('Gemini incremental request failed — aborting. State unchanged.');
    console.error('Error:', err.message);
    process.exit(1);
  }

  console.log('Appending update to Google Doc...');
  try {
    await appendToDocument(stripMarkdown(updateNote));
  } catch (err) {
    console.error('Docs API append failed — aborting. State unchanged.');
    console.error('Error:', err.message);
    console.log('\n=== UPDATE NOTE (do not lose this) ===');
    console.log(updateNote);
    process.exit(1);
  }

  writeState({
    lastRunDate: runDate,
    icpSummary: updatedIcpSummary,
    runMode: 'incremental',
    rowStatuses: buildRowStatuses(allRows),
  });

  console.log(
    `Incremental update complete. ` +
    `${newLeads.length} new lead(s), ${changedLeads.length} status change(s). State saved.`
  );
}

async function main() {
  const runDate = todayIso();
  const state = readState();

  console.log(`Snapper starting — ${runDate} — mode: ${state.runMode}`);

  if (state.runMode === 'bootstrap') {
    await bootstrap(runDate);
  } else {
    await incremental(runDate, state);
  }
}

main().catch((err) => {
  console.error('Unhandled error:', err);
  process.exit(1);
});
