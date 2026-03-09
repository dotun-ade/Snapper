require('dotenv').config();

function requireEnv(name) {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required environment variable: ${name}`);
  return val;
}

/**
 * Parse service account credentials.
 *
 * Prefers GOOGLE_SERVICE_ACCOUNT_JSON (the full JSON blob — same pattern as
 * Pisces). This avoids every Railway/OpenSSL newline-mangling issue because
 * JSON.parse() handles \n escape sequences natively.
 *
 * Falls back to GOOGLE_SERVICE_ACCOUNT_EMAIL + GOOGLE_PRIVATE_KEY if the
 * JSON var is absent, for backwards compatibility.
 */
function getServiceAccountCredentials() {
  const json = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (json) {
    let sa;
    try {
      sa = JSON.parse(json);
    } catch (err) {
      throw new Error(`GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON: ${err.message}`);
    }
    // Safety: fix escaped newlines in case the JSON was stored minified in Railway
    if (sa.private_key) {
      sa.private_key = sa.private_key.replace(/\\n/g, '\n');
    }
    return { email: sa.client_email, key: sa.private_key };
  }

  // Fallback: individual vars
  const email = requireEnv('GOOGLE_SERVICE_ACCOUNT_EMAIL');
  let key = requireEnv('GOOGLE_PRIVATE_KEY').trim().replace(/^["']|["']$/g, '');
  if (key.includes('\\n')) key = key.replace(/\\n/g, '\n');
  return { email, key };
}

const { email: serviceAccountEmail, key: privateKey } = getServiceAccountCredentials();

module.exports = {
  google: {
    serviceAccountEmail,
    privateKey,
    spreadsheetId: requireEnv('SPREADSHEET_ID'),
    outputDocId: requireEnv('OUTPUT_DOC_ID'),
  },
  gemini: {
    apiKey: requireEnv('GEMINI_API_KEY'),
    modelName: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
  },
};
