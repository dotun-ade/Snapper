const fs = require('fs');
const path = require('path');

const STATE_FILE = path.join(process.cwd(), 'state.json');

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
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
}

module.exports = { readState, writeState };
