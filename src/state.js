const fs = require('fs');
const path = require('path');

// Allow the state directory to be configured (e.g. to point at a Railway volume).
// Falls back to the current working directory so local behaviour is unchanged.
const STATE_DIR = process.env.STATE_DIR || process.cwd();
const STATE_FILE = path.join(STATE_DIR, 'state.json');

const DEFAULT_STATE = {
  runMode: 'bootstrap',
  lastRunDate: null,
  icpSummary: null,
};

function readState() {
  if (!fs.existsSync(STATE_FILE)) {
    return { ...DEFAULT_STATE };
  }
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch (err) {
    console.warn('Could not parse state.json, using default bootstrap state:', err.message);
    return { ...DEFAULT_STATE };
  }
}

function writeState(state) {
  // Ensure the state directory exists before writing (important for fresh volumes).
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
}

module.exports = { readState, writeState };
