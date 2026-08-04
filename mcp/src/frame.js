'use strict';

const { drawMarkGridOnScreenshot } = require('../../runwave/controller/src/grid-overlay');
const { readPng } = require('./image');
const { frameBlocks, gridNote, stateText, textBlock } = require('./result');

// The overlay writes the PNG larger than the capture by a fixed margin per
// side. gridLabelStyle is private, so the margin is recovered from the file
// itself rather than reimplementing the label metrics.
function overlayMargin(file, viewport) {
  try {
    const png = readPng(file);
    const margin = Math.round((png.width - Number(viewport.width)) / 2);
    return margin > 0 ? margin : 0;
  } catch {
    return 0;
  }
}

// Draws the overlay onto an existing capture and reports the margin it added.
function applyGrid(session, file) {
  drawMarkGridOnScreenshot(file, session.config);
  return overlayMargin(file, session.config.viewport);
}

// Screenshots are taken clean. The grid is drawn only when a caller asks for
// it, so the deliverable frame is never annotated.
async function captureFrame(session, { name, grid = false }) {
  const dir = session.actionDir(name);
  const file = await session.browser.screenshot(dir, name);
  if (!grid) return { file, margin: 0 };
  return { file, margin: applyGrid(session, file) };
}

// Assembles the per-turn payload: frame, trimmed state, and any coordinate
// caveat the model needs in order to aim correctly.
function frameResult({ file, margin, state, scale, fullRes, region, label, extra = [] }) {
  const { blocks, image } = frameBlocks(file, { scale, fullRes, region, label });
  const notes = [stateText(state)];
  const caveat = gridNote(image, margin);
  if (caveat) notes.push(caveat);
  for (const note of extra) if (note) notes.push(note);
  return {
    content: [...blocks, textBlock(notes.join('\n'))],
    image,
  };
}

module.exports = {
  applyGrid,
  captureFrame,
  frameResult,
  overlayMargin,
};
