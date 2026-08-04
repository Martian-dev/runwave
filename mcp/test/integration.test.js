'use strict';

// Drives a real headless Chromium against a real game page through the MCP
// tool surface. Skipped automatically when Chromium's system libraries are
// missing, so the suite still runs on a bare machine.

const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');

const { chromium } = require('playwright');
const { SessionRegistry } = require('../src/registry');
const { captureFrame } = require('../src/frame');
const { changedSince } = require('../src/diff');
const { compactState } = require('../src/state');
const { imageBlock } = require('../src/image');
const { runStep } = require('../../runwave/controller/src/step-runner');

const GAME_URL = pathToFileURL(path.join(__dirname, 'fixtures', 'game', 'index.html')).href;
const VIEWPORT = { width: 640, height: 360 };

async function chromiumUsable() {
  try {
    const browser = await chromium.launch({ headless: true });
    await browser.close();
    return true;
  } catch {
    return false;
  }
}

test('MCP session plays a real browser game', async (t) => {
  if (!(await chromiumUsable())) {
    t.skip('chromium cannot launch here; run "npx playwright install-deps chromium"');
    return;
  }
  const workspace = await fsp.mkdtemp(path.join(os.tmpdir(), 'runwave-mcp-it-'));
  const registry = new SessionRegistry({ workspace });
  t.after(async () => {
    await registry.closeAll();
    await fsp.rm(workspace, { recursive: true, force: true });
  });

  const session = await registry.create({
    url: GAME_URL,
    viewport: VIEWPORT,
    stateExpression: '() => window.gameState',
  });

  await t.test('launch returns a usable downscaled frame', async () => {
    const { file } = await captureFrame(session, { name: 'launch', grid: false });
    session.lastFrame = file;
    const image = imageBlock(file);
    assert.equal(image.sourceWidth, VIEWPORT.width, 'capture must match the viewport exactly');
    assert.equal(image.width, VIEWPORT.width / 2, 'frames are halved by default to save context');
    assert.ok(image.block.data.length > 100, 'image block must carry real base64 payload');
    assert.equal(image.block.mimeType, 'image/png');
  });

  await t.test('state exposes the game canvas and custom state', async () => {
    const state = compactState(await session.browser.state(session.config.stateExpression));
    assert.deepEqual(state.game_area, { x: 0, y: 0, width: VIEWPORT.width, height: VIEWPORT.height });
    assert.equal(state.custom.hits, 0);
    assert.equal(state.webgl, undefined, 'renderer probe must be stripped from per-turn state');
  });

  await t.test('a held key moves the player and the frame changes', async () => {
    const before = await session.browser.state(session.config.stateExpression);
    const previousFrame = session.lastFrame;
    const stepIndex = session.nextStepIndex();
    const actionName = `act-${stepIndex}`;
    const step = await runStep({
      input: {
        action: 'step',
        action_name: actionName,
        actions: [{ type: 'key', start: 0, end: 600, key: 'ArrowRight' }],
        autoCaptures: false,
      },
      config: session.config,
      browser: session.browser,
      outputDir: session.actionDir(actionName),
      nextStepIndex: stepIndex,
      actionName,
      profiler: null,
    });

    assert.equal(step.captures.length, 1, 'one frame per turn unless more are requested');
    const after = step.endState;
    assert.ok(
      after.custom.x > before.custom.x + 20,
      `holding right must move the player: ${before.custom.x} -> ${after.custom.x}`
    );
    assert.equal(changedSince(previousFrame, step.captures[0].path), true);
    session.lastFrame = step.captures[0].path;
  });

  await t.test('a grid cell click lands on the intended target', async () => {
    // The target sits at x 480-560, y 140-220 in a 640x360 viewport. On a 16x16
    // grid that is columns 12-13 and rows 6-9, so cell (7, 12) must hit it.
    const stepIndex = session.nextStepIndex();
    const actionName = `act-${stepIndex}`;
    const step = await runStep({
      input: {
        action: 'step',
        action_name: actionName,
        actions: [{ type: 'click', start: 50, overlay_row: 7, overlay_col: 12 }],
        autoCaptures: false,
      },
      config: session.config,
      browser: session.browser,
      outputDir: session.actionDir(actionName),
      nextStepIndex: stepIndex,
      actionName,
      profiler: null,
    });

    // Cell centre for (row 7, col 12) on a 16x16 grid over 640x360.
    const expected = {
      x: Math.round((12 + 0.5) * (VIEWPORT.width / 16)),
      y: Math.round((7 + 0.5) * (VIEWPORT.height / 16)),
    };
    const click = step.actions.find((item) => item.type === 'click');
    assert.deepEqual({ x: click.x, y: click.y }, expected, 'cell must resolve to its centre');
    assert.ok(click.x >= 480 && click.x <= 560 && click.y >= 140 && click.y <= 220, 'centre must fall inside the target');
    assert.equal(step.endState.custom.hits, 1, 'the click must register on the target');
    assert.equal(step.endState.custom.lit, true);
  });
});
