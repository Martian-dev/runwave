'use strict';

const { imageBlock } = require('./image');
const { compactState } = require('./state');

function textBlock(text) {
  return { type: 'text', text };
}

function errorResult(error) {
  return {
    isError: true,
    content: [textBlock(String((error && error.message) || error))],
  };
}

// Every frame goes back as an image block for the model and a path for tooling
// that wants the original PNG on disk.
function frameBlocks(file, options = {}) {
  const image = imageBlock(file, options);
  const scaleNote = image.scale === 1
    ? `${image.width}x${image.height}`
    : `${image.width}x${image.height}, downscaled ${image.scale}x from ${image.sourceWidth}x${image.sourceHeight}`;
  const label = options.label ? `${options.label} ` : '';
  return {
    blocks: [image.block, textBlock(`${label}frame (${scaleNote})\npath: ${file}`)],
    image,
  };
}

function stateText(raw) {
  const state = compactState(raw);
  return Object.keys(state).length ? `state: ${JSON.stringify(state)}` : 'state: {}';
}

// Coordinate space warning matters: with the grid on, the saved PNG is larger
// than the viewport by a margin per side, so pixels read off the image do not
// match pixels sent back as x/y.
function gridNote(image, margin) {
  if (!margin) return null;
  return `grid overlay is on. The image includes a ${margin}px label margin on every side, so image pixel (px, py) is viewport (px - ${margin}, py - ${margin}). Prefer overlay_row/overlay_col targets while the grid is on.`;
}

function pauseNote(mode) {
  if (mode === 'manual') {
    return 'game_status: paused by manual override; call resume_game before act or reset_game.';
  }
  return 'game_status: paused at this frame; act or reset_game resumes only for its controlled duration.';
}

module.exports = {
  errorResult,
  frameBlocks,
  gridNote,
  pauseNote,
  stateText,
  textBlock,
};
