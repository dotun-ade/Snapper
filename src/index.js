require('dotenv').config();

const { readState, writeState } = require('./state');
const { readAllLeads, readLeadsSince } = require('./sheets');
const { writeBootstrapDocument, appendToDocument } = require('./docs');
const { analyzeAllBatches, synthesize, runIncrementalUpdate } = require('./gemini');

const BATCH_DELAY_MS = 15_000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function todayIso() {
  return new Date().toISOString().split('T')[0];
}

async function bootstrap(runDate) {
  // 1. Read all leads from the sheet
  console.log('Reading all leads from Leads tab...');
  let rows;
  try {
    rows = await readAllLeads();
  } catch (err) {
    console.error('Sheets API error — aborting:', err.message);
    process.exit(1);
  }
  console.log(`Read ${rows.length} rows.`);

  // 2. Batch analysis (analyzeAllBatches handles delays between batches)
  let batchSummaries, icpSummary;
  try {
    ({ batchSummaries, icpSummary } = await analyzeAllBatches(rows));
  } catch (err) {
    console.error('Batch analysis failed — aborting:', err.message);
    process.exit(1);
  }

  // 3. Synthesis request (separate so batch summaries can be logged if it fails)
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

  // 4. Write to Google Doc
  console.log('Writing to Google Doc...');
  try {
    await writeBootstrapDocument(prose);
  } catch (err) {
    console.error('Docs API write failed — aborting. Do not update state.');
    console.error('Error:', err.message);
    console.log('\n=== FULL ANALYSIS OUTPUT (do not lose this) ===');
    console.log(prose);
    // Do not update state.json — next run will retry
    process.exit(1);
  }

  // 5. Persist state only after full success
  writeState({
    lastRunDate: runDate,
    icpSummary,
    runMode: 'incremental',
  });

  console.log(`Bootstrap complete. Processed ${rows.length} rows. State saved.`);
}

async function incremental(runDate, state) {
  if (!state.lastRunDate) {
    console.error('Incremental mode but lastRunDate missing from state.json — re-run bootstrap.');
    process.exit(1);
  }

  // 1. Read new leads
  console.log(`Reading leads with Entry Date >= ${state.lastRunDate}...`);
  let newRows;
  try {
    newRows = await readLeadsSince(state.lastRunDate);
  } catch (err) {
    console.error('Sheets API error — aborting:', err.message);
    process.exit(1);
  }

  if (newRows.length === 0) {
    console.log(`No new leads since ${state.lastRunDate}. Nothing to do.`);
    process.exit(0);
  }
  console.log(`Found ${newRows.length} new lead(s).`);

  // 2. Gemini incremental update
  let updatedIcpSummary, updateNote;
  try {
    ({ updatedIcpSummary, updateNote } = await runIncrementalUpdate(
      state.icpSummary,
      newRows,
      runDate
    ));
  } catch (err) {
    console.error('Gemini incremental request failed — aborting. State unchanged.');
    console.error('Error:', err.message);
    process.exit(1);
  }

  // 3. Append update note to Google Doc
  console.log('Appending update to Google Doc...');
  try {
    await appendToDocument(updateNote);
  } catch (err) {
    console.error('Docs API append failed — aborting. State unchanged.');
    console.error('Error:', err.message);
    console.log('\n=== UPDATE NOTE (do not lose this) ===');
    console.log(updateNote);
    // Do not update state.json — next run will retry
    process.exit(1);
  }

  // 4. Persist state only after full success
  writeState({
    lastRunDate: runDate,
    icpSummary: updatedIcpSummary,
    runMode: 'incremental',
  });

  console.log(`Incremental update complete. ${newRows.length} new lead(s) processed. State saved.`);
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
