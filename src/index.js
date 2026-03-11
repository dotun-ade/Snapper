require('dotenv').config();

const { readState, writeState } = require('./state');
const { readAllLeads } = require('./sheets');
const { writeBootstrapDocument } = require('./docs');
const { analyzeAllBatches, synthesize } = require('./gemini');

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
 * Full run: read all leads, batch-analyse with Gemini, synthesize to prose,
 * then fully overwrite the Google Doc. Runs twice daily (e.g. 5am and 6pm UTC);
 * each run uses 5 Gemini calls (4 batch + 1 synthesis), so 10/day total.
 */
async function fullRun(runDate, usage) {
  console.log('Reading all leads from Leads tab...');
  let rows;
  try {
    rows = await readAllLeads();
  } catch (err) {
    console.error('Sheets API error — aborting:', err.message);
    process.exit(1);
  }
  console.log(`Read ${rows.length} rows.`);

  let batchSummaries;
  try {
    ({ batchSummaries } = await analyzeAllBatches(rows, usage));
  } catch (err) {
    console.error('Batch analysis failed — aborting:', err.message);
    process.exit(1);
  }

  console.log(`Waiting ${BATCH_DELAY_MS / 1000}s before synthesis request...`);
  await sleep(BATCH_DELAY_MS);
  console.log('Running synthesis...');

  let prose;
  try {
    prose = await synthesize(batchSummaries, rows.length, runDate, usage);
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
    lastGeminiCallDate: runDate,
    geminiCallsOnLastRunDate: usage.count,
  });

  console.log(`Full run complete. Processed ${rows.length} rows. State saved.`);
}

async function main() {
  const runDate = todayIso();
  const state = readState();

  // Track Gemini API calls per calendar day (budget 20). Persisted so both
  // daily runs (e.g. 5am and 6pm UTC) share the same count.
  const usage = {
    count:
      state.lastGeminiCallDate === runDate ? (state.geminiCallsOnLastRunDate || 0) : 0,
  };
  console.log(
    `Snapper starting — ${runDate} — full run. Gemini calls today: ${usage.count} / 20`
  );

  await fullRun(runDate, usage);
}

main().catch((err) => {
  console.error('Unhandled error:', err);
  process.exit(1);
});
