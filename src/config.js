require('dotenv').config();

function requireEnv(name) {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required environment variable: ${name}`);
  return val;
}

function normalizePrivateKey(raw) {
  // Strip surrounding quotes that some Railway/shell environments add
  let key = raw.trim().replace(/^["']|["']$/g, '');
  // Convert literal \n sequences to real newlines (Railway stores keys this way)
  if (key.includes('\\n')) {
    key = key.replace(/\\n/g, '\n');
  }
  return key;
}

module.exports = {
  google: {
    serviceAccountEmail: requireEnv('GOOGLE_SERVICE_ACCOUNT_EMAIL'),
    privateKey: normalizePrivateKey(requireEnv('GOOGLE_PRIVATE_KEY')),
    spreadsheetId: requireEnv('SPREADSHEET_ID'),
    outputDocId: requireEnv('OUTPUT_DOC_ID'),
  },
  gemini: {
    apiKey: requireEnv('GEMINI_API_KEY'),
    modelName: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
  },
};
