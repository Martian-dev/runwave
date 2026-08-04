'use strict';

const path = require('path');

const DEFAULT_VIEWPORT = { width: 1280, height: 720 };

// Runwave scatters clicks within a cell to vary playtest footage. An agent
// aiming at a target needs the opposite: the same cell must mean the same pixel
// so a saved action trace replays identically.
const CELL_SAMPLE_MODE = 'center';

function normalizeViewport(viewport) {
  const width = Number(viewport && viewport.width);
  const height = Number(viewport && viewport.height);
  return {
    width: Number.isFinite(width) && width > 0 ? Math.round(width) : DEFAULT_VIEWPORT.width,
    height: Number.isFinite(height) && height > 0 ? Math.round(height) : DEFAULT_VIEWPORT.height,
  };
}

// The daemon hands createSession its raw CLI input, which is why grid-cell
// actions fail there when no viewport was passed. Building the config
// explicitly closes that gap: viewport is always present and always numeric.
function buildSessionConfig(options = {}) {
  const viewport = normalizeViewport(options.viewport);
  return {
    kind: 'web',
    ...(options.url ? { url: options.url } : {}),
    ...(options.gameDir ? { gameDir: path.resolve(options.gameDir) } : {}),
    ...(options.port ? { port: Number(options.port) } : {}),
    viewport,
    deviceScaleFactor: 1,
    // No recording: no gstreamer, no PulseAudio, no headed Chromium.
    record: false,
    headless: true,
    // Overlay is opt-in per call. It enlarges the PNG by a margin per side,
    // which desyncs image coordinates from input coordinates.
    gridScreenshots: false,
    fullPageScreenshots: false,
    // The agent asks for frames explicitly; interval captures would spend
    // context on frames nobody requested.
    autoCaptures: false,
    markGridSampleMode: CELL_SAMPLE_MODE,
    ...(options.markGridRows ? { markGridRows: Number(options.markGridRows) } : {}),
    ...(options.markGridCols ? { markGridCols: Number(options.markGridCols) } : {}),
    ...(options.stateExpression ? { stateExpression: String(options.stateExpression) } : {}),
    waitAfterLoad: Number(options.waitAfterLoad ?? 700),
  };
}

module.exports = {
  CELL_SAMPLE_MODE,
  DEFAULT_VIEWPORT,
  buildSessionConfig,
  normalizeViewport,
};
