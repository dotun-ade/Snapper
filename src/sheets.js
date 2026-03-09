const { google } = require('googleapis');
const { google: googleConfig } = require('./config');

// Column indices (0-based) for the Leads tab
const COL = {
  ENTRY_DATE: 4,        // E
  STATUS: 7,            // H
  PRIMARY_PRODUCT: 8,   // I
  SECONDARY_PRODUCTS: 9, // J
  INDUSTRY: 10,         // K
  SOURCE: 11,           // L
  COUNTRY: 12,          // M
  TTV: 13,              // N
  USE_CASE: 16,         // Q
  NOTES: 20,            // U
};

/**
 * Returns a GoogleAuth client built from individual env-var credentials.
 * Using GoogleAuth (rather than JWT directly) avoids the OpenSSL 3.x
 * DECODER::unsupported error that occurs when JWT tries to parse the PEM
 * key on Node 18+.
 */
function getAuthClient() {
  return new google.auth.GoogleAuth({
    credentials: {
      client_email: googleConfig.serviceAccountEmail,
      private_key: googleConfig.privateKey,
    },
    scopes: [
      'https://www.googleapis.com/auth/spreadsheets.readonly',
      'https://www.googleapis.com/auth/documents',
    ],
  });
}

function getSheetsClient() {
  return google.sheets({ version: 'v4', auth: getAuthClient() });
}

function get(row, idx) {
  const val = row[idx];
  if (val == null) return '';
  return String(val).trim();
}

function parseRow(rawRow) {
  return {
    entryDate: get(rawRow, COL.ENTRY_DATE),
    status: get(rawRow, COL.STATUS),
    primaryProduct: get(rawRow, COL.PRIMARY_PRODUCT),
    secondaryProducts: get(rawRow, COL.SECONDARY_PRODUCTS),
    industry: get(rawRow, COL.INDUSTRY),
    source: get(rawRow, COL.SOURCE),
    country: get(rawRow, COL.COUNTRY),
    ttv: get(rawRow, COL.TTV),
    useCase: get(rawRow, COL.USE_CASE),
    notes: get(rawRow, COL.NOTES),
  };
}

/**
 * Parse an entry date string in various formats that may appear in the CRM.
 * Returns a Date object or null.
 */
function parseEntryDate(dateStr) {
  if (!dateStr || typeof dateStr !== 'string') return null;
  const s = dateStr.trim();
  if (!s) return null;

  // ISO: YYYY-MM-DD or YYYY-MM-DDTHH:MM:SS
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    const d = new Date(s);
    if (!isNaN(d.getTime())) return d;
  }

  // DD/MM/YYYY (common in Nigerian/UK CRMs)
  const dmy = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (dmy) {
    const d = new Date(`${dmy[3]}-${dmy[2].padStart(2, '0')}-${dmy[1].padStart(2, '0')}`);
    if (!isNaN(d.getTime())) return d;
  }

  // MM/DD/YYYY fallback
  const mdy = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (mdy) {
    const d = new Date(`${mdy[3]}-${mdy[1].padStart(2, '0')}-${mdy[2].padStart(2, '0')}`);
    if (!isNaN(d.getTime())) return d;
  }

  // General Date parse as last resort
  const d = new Date(s);
  if (!isNaN(d.getTime())) return d;

  return null;
}

/**
 * Read all rows from the Leads tab, skipping the header row.
 * Returns an array of parsed row objects (never skips rows with missing fields).
 */
async function readAllLeads() {
  const sheets = getSheetsClient();
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: googleConfig.spreadsheetId,
    range: 'Leads!A:U', // A–U covers all needed columns (up to index 20)
  });

  const rows = response.data.values || [];
  // Row 0 is the header; skip it
  return rows.slice(1).map(parseRow);
}

/**
 * Read rows where Entry Date >= sinceDate (ISO string YYYY-MM-DD).
 * Rows with unparseable or blank Entry Date are excluded from incremental runs.
 */
async function readLeadsSince(sinceDateStr) {
  const since = new Date(sinceDateStr);
  since.setHours(0, 0, 0, 0);

  const all = await readAllLeads();
  return all.filter((row) => {
    const d = parseEntryDate(row.entryDate);
    return d !== null && d >= since;
  });
}

module.exports = { readAllLeads, readLeadsSince, getAuthClient };
