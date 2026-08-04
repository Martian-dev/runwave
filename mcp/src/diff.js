'use strict';

const crypto = require('crypto');
const fs = require('fs');

function hashFile(file) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  } catch {
    return null;
  }
}

// "Did anything happen?" is the single most useful signal after an input, and
// the cheapest: no second screenshot, no pixel walk. A false here usually means
// the input never reached the game, which is otherwise easy to misread as the
// game ignoring the move.
function changedSince(previousFile, nextFile) {
  if (!previousFile || !nextFile) return null;
  const before = hashFile(previousFile);
  const after = hashFile(nextFile);
  if (!before || !after) return null;
  return before !== after;
}

module.exports = {
  changedSince,
  hashFile,
};
