const { GoogleGenerativeAI } = require('@google/generative-ai');
const { gemini: geminiConfig } = require('./config');

const genAI = new GoogleGenerativeAI(geminiConfig.apiKey);

// Used for the synthesis request — returns prose
const textModel = genAI.getGenerativeModel({ model: geminiConfig.modelName });

// Used for all structured data requests — forces valid JSON output.
// responseMimeType: 'application/json' tells Gemini to return clean JSON
// with no markdown fences and no trailing commas, eliminating all parsing fragility.
const jsonModel = genAI.getGenerativeModel({
  model: geminiConfig.modelName,
  generationConfig: { responseMimeType: 'application/json' },
});

const BATCH_SIZE = 1000;
const BATCH_DELAY_MS = 15_000; // 15 seconds between requests (respect 5 req/min limit)

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Serialise a parsed row into a compact single-line string for the prompt.
 */
function rowToText(row, index) {
  return (
    `Row ${index + 1}: ` +
    `EntryDate=${row.entryDate || 'unknown'}, ` +
    `Status=${row.status || 'unknown'}, ` +
    `PrimaryProduct=${row.primaryProduct || 'unknown'}, ` +
    `SecondaryProducts=${row.secondaryProducts || 'unknown'}, ` +
    `Industry=${row.industry || 'unknown'}, ` +
    `Source=${row.source || 'unknown'}, ` +
    `Country=${row.country || 'unknown'}, ` +
    `TTV=${row.ttv || 'unknown'}, ` +
    `UseCase=${row.useCase || 'unknown'}, ` +
    `Notes=${row.notes || ''}`
  );
}

function rowsToText(rows) {
  return rows.map(rowToText).join('\n');
}

/**
 * Send a single batch of rows to Gemini for structured pattern extraction.
 * Uses jsonModel so the response is always valid JSON — no fence stripping needed.
 */
async function analyzeBatch(rows, batchNumber, totalBatches) {
  const prompt = [
    `You are analysing a batch of CRM leads for AnKorp, a fintech infrastructure company offering banking,`,
    `payments, and card-issuing APIs. Core products: deposit accounts, virtual accounts, sub-accounts,`,
    `virtual USD cards, payin/payout. All products except virtual USD cards are Naira-only.`,
    ``,
    `This is batch ${batchNumber} of ${totalBatches} (${rows.length} rows).`,
    ``,
    `Status tiers to distinguish:`,
    `- "all": every lead in this batch`,
    `- "integrating_plus": leads with status Integrating or Live`,
    `- "live": leads with status Live`,
    ``,
    `Return a JSON object with the following structure:`,
    `{`,
    `  "status_distribution": { "StatusValue": count },`,
    `  "product_interest": { "primary": { "Product": count }, "secondary": { "Product": count } },`,
    `  "industry": { "Industry": count },`,
    `  "country": { "Country": count },`,
    `  "lead_source": { "Inbound": count, "Referral": count, "Events": count, "Outbound": count, "Unknown": count },`,
    `  "ttv_distribution": { "populated": count, "blank": count, "ranges": { "<10k": count, "10k-50k": count, "50k-250k": count, "250k+": count } },`,
    `  "use_case_themes": ["theme1", "theme2"],`,
    `  "stall_patterns": { "stall_statuses": { "Status": count }, "correlations": ["observation1"] },`,
    `  "data_completeness": { "fieldName": { "populated": count, "total": count } },`,
    `  "tier_breakdown": {`,
    `    "all": { "count": n, "top_countries": [], "top_products": [], "top_industries": [], "top_sources": [] },`,
    `    "integrating_plus": { "count": n, "top_countries": [], "top_products": [], "top_industries": [], "top_sources": [] },`,
    `    "live": { "count": n, "top_countries": [], "top_products": [], "top_industries": [], "top_sources": [] }`,
    `  }`,
    `}`,
    ``,
    `Rules:`,
    `- Map raw source values to: Inbound, Referral, Events, Outbound, or Unknown`,
    `- Parse TTV numerically where possible; treat non-numeric or blank as blank`,
    `- data_completeness covers: entryDate, status, primaryProduct, secondaryProducts, industry, source, country, ttv, useCase, notes`,
    `- Do not skip or disqualify rows because fields are blank`,
    ``,
    `Leads data:`,
    rowsToText(rows),
  ].join('\n');

  const result = await jsonModel.generateContent(prompt);
  return JSON.parse(result.response.text());
}

/**
 * Merge batch summary objects into a single combined ICP summary.
 * Used to produce the icpSummary stored in state.json.
 */
function mergeBatchSummaries(summaries, totalRows) {
  const merged = {
    totalRows,
    batchCount: summaries.length,
    status_distribution: {},
    product_interest: { primary: {}, secondary: {} },
    industry: {},
    country: {},
    lead_source: {},
    ttv_distribution: { populated: 0, blank: 0, ranges: { '<10k': 0, '10k-50k': 0, '50k-250k': 0, '250k+': 0 } },
    use_case_themes: [],
    stall_patterns: { stall_statuses: {}, correlations: [] },
    data_completeness: {},
    tier_breakdown: {
      all: { count: 0, top_countries: [], top_products: [], top_industries: [], top_sources: [] },
      integrating_plus: { count: 0, top_countries: [], top_products: [], top_industries: [], top_sources: [] },
      live: { count: 0, top_countries: [], top_products: [], top_industries: [], top_sources: [] },
    },
  };

  function addCounts(target, source) {
    if (!source || typeof source !== 'object') return;
    for (const [k, v] of Object.entries(source)) {
      if (typeof v === 'number') target[k] = (target[k] || 0) + v;
    }
  }

  for (const s of summaries) {
    if (!s || typeof s !== 'object') continue;

    addCounts(merged.status_distribution, s.status_distribution);

    if (s.product_interest) {
      addCounts(merged.product_interest.primary, s.product_interest.primary);
      addCounts(merged.product_interest.secondary, s.product_interest.secondary);
    }

    addCounts(merged.industry, s.industry);
    addCounts(merged.country, s.country);
    addCounts(merged.lead_source, s.lead_source);

    if (s.ttv_distribution) {
      merged.ttv_distribution.populated += s.ttv_distribution.populated || 0;
      merged.ttv_distribution.blank += s.ttv_distribution.blank || 0;
      if (s.ttv_distribution.ranges) {
        addCounts(merged.ttv_distribution.ranges, s.ttv_distribution.ranges);
      }
    }

    if (Array.isArray(s.use_case_themes)) {
      merged.use_case_themes.push(...s.use_case_themes);
    }

    if (s.stall_patterns) {
      addCounts(merged.stall_patterns.stall_statuses, s.stall_patterns.stall_statuses);
      if (Array.isArray(s.stall_patterns.correlations)) {
        merged.stall_patterns.correlations.push(...s.stall_patterns.correlations);
      }
    }

    if (s.data_completeness) {
      for (const [field, data] of Object.entries(s.data_completeness)) {
        if (!merged.data_completeness[field]) {
          merged.data_completeness[field] = { populated: 0, total: 0 };
        }
        merged.data_completeness[field].populated += data.populated || 0;
        merged.data_completeness[field].total += data.total || 0;
      }
    }

    if (s.tier_breakdown) {
      for (const tier of ['all', 'integrating_plus', 'live']) {
        if (s.tier_breakdown[tier]) {
          merged.tier_breakdown[tier].count += s.tier_breakdown[tier].count || 0;
        }
      }
    }
  }

  merged.use_case_themes = [...new Set(merged.use_case_themes)];

  return merged;
}

/**
 * Send the synthesis request to Gemini to produce the full ICP analysis prose document.
 * Uses textModel — this is the one request that returns prose, not JSON.
 */
async function synthesize(batchSummaries, totalRows, runDate) {
  const prompt = [
    `You are writing a full ICP (Ideal Customer Profile) analysis document for AnKorp,`,
    `a fintech infrastructure company offering banking, payments, and card-issuing APIs.`,
    `Core products: deposit accounts, virtual accounts, sub-accounts, virtual USD cards, payin/payout.`,
    `All products except virtual USD cards are Naira-only.`,
    ``,
    `You have been given ${batchSummaries.length} batch analysis summaries representing ${totalRows} total CRM leads.`,
    `Merge them into a single coherent ICP analysis document written in clear prose with supporting counts and percentages.`,
    ``,
    `The document MUST include these sections in order:`,
    ``,
    `1. Geographic Distribution`,
    `   Breakdown by country across all leads, integrating+ leads, and live leads.`,
    `   Flag which countries show the strongest lead-to-live conversion rates.`,
    ``,
    `2. Product Demand`,
    `   Most requested primary products, common product combinations (primary + secondary),`,
    `   broken down by status tier.`,
    ``,
    `3. Industry Breakdown`,
    `   Which industries appear most and which convert best to Live.`,
    ``,
    `4. Source Analysis`,
    `   Inbound vs Referral vs Events vs Outbound, broken down by status tier.`,
    ``,
    `5. TTV Distribution`,
    `   Spread of estimated TTV across status tiers. Note that this field has sparse population.`,
    ``,
    `6. Use Case Patterns`,
    `   Common themes among leads that converted vs those that did not. Note sparse population.`,
    ``,
    `7. Stall and Drop-off Patterns`,
    `   At which status do most leads drop off. Any product/country/industry combinations`,
    `   that correlate with stalling.`,
    ``,
    `8. Data Quality Summary`,
    `   For each key field (Entry Date, Status, Primary Product, Secondary Products, Industry,`,
    `   Source, Country, TTV, Use Case, Notes), the % of rows where it is populated.`,
    ``,
    `Format rules:`,
    `- Start with the header: "AnKorp ICP Analysis — ${runDate}"`,
    `- Write each section with a clear heading`,
    `- Use counts and percentages to support every claim`,
    `- Distinguish clearly between three tiers in every section: All Leads / Integrating+ / Live`,
    `- End with a Metadata block: total rows processed: ${totalRows}, run date: ${runDate}, run mode: Bootstrap`,
    ``,
    `Batch summaries:`,
    JSON.stringify(batchSummaries, null, 2),
  ].join('\n');

  const result = await textModel.generateContent(prompt);
  return result.response.text();
}

/**
 * Run the full bootstrap analysis:
 * 1. Split rows into batches of 1000
 * 2. Analyse each batch (with 15s delay between requests)
 * 3. Return batch summaries and the merged ICP summary JSON
 *
 * The caller is responsible for calling synthesize() separately so that
 * batch summaries can be logged if synthesis fails.
 */
async function analyzeAllBatches(rows) {
  const batches = [];
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    batches.push(rows.slice(i, i + BATCH_SIZE));
  }

  console.log(`Bootstrap: ${rows.length} rows → ${batches.length} batch(es) of up to ${BATCH_SIZE}`);

  const batchSummaries = [];
  for (let i = 0; i < batches.length; i++) {
    if (i > 0) {
      console.log(`Waiting ${BATCH_DELAY_MS / 1000}s before batch ${i + 1}...`);
      await sleep(BATCH_DELAY_MS);
    }
    console.log(`Batch ${i + 1}/${batches.length}: ${batches[i].length} rows`);
    const summary = await analyzeBatch(batches[i], i + 1, batches.length);
    batchSummaries.push(summary);
    console.log(`Batch ${i + 1} complete.`);
  }

  const icpSummary = mergeBatchSummaries(batchSummaries, rows.length);
  return { batchSummaries, icpSummary };
}

/**
 * Run the incremental update.
 * Uses jsonModel — asks Gemini to return a single JSON object with two fields:
 *   updated_summary: the merged ICP summary JSON
 *   update_note:     a plain-text string with the dated prose update
 *
 * This eliminates the delimiter-parsing fragility of the previous approach.
 */
async function runIncrementalUpdate(existingIcpSummary, newRows, runDate) {
  const prompt = [
    `You are updating an ICP analysis for AnKorp, a fintech infrastructure company offering`,
    `banking, payments, and card-issuing APIs (deposit accounts, virtual accounts, sub-accounts,`,
    `virtual USD cards, payin/payout). All products except virtual USD cards are Naira-only.`,
    ``,
    `The existing summary JSON below represents all historical leads processed before ${runDate}.`,
    `The new leads were added since the last run.`,
    ``,
    `Return a JSON object with exactly two fields:`,
    `- "updated_summary": the full updated ICP summary JSON, incorporating the new leads`,
    `- "update_note": a plain-text string starting with "Update — ${runDate}" followed by`,
    `  2-3 paragraphs describing what the new leads changed or reinforced`,
    ``,
    `Existing ICP summary:`,
    JSON.stringify(existingIcpSummary, null, 2),
    ``,
    `New leads (${newRows.length} rows):`,
    rowsToText(newRows),
  ].join('\n');

  const result = await jsonModel.generateContent(prompt);
  const parsed = JSON.parse(result.response.text());

  return {
    updatedIcpSummary: parsed.updated_summary,
    updateNote: parsed.update_note,
  };
}

module.exports = { analyzeAllBatches, synthesize, runIncrementalUpdate };
