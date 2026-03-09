require('dotenv').config();

function requireEnv(name) {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required environment variable: ${name}`);
  return val;
}

module.exports = {
  google: {
    serviceAccountEmail: requireEnv('GOOGLE_SERVICE_ACCOUNT_EMAIL'),
    // Railway stores private keys with \\n — fix at read time
    privateKey: requireEnv('GOOGLE_PRIVATE_KEY').replace(/\\n/g, '\n'),
    spreadsheetId: requireEnv('SPREADSHEET_ID'),
    outputDocId: requireEnv('OUTPUT_DOC_ID'),
  },
  gemini: {
    apiKey: requireEnv('GEMINI_API_KEY'),
    modelName: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
  },
};
