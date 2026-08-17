'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { PNG } = require('pngjs');

const { buildSessionConfig, normalizeViewport } = require('../src/config');
const { clampScale, crop, resize } = require('../src/image');
const { compactState } = require('../src/state');
const { action } = require('../src/schema');
const { Session, canonicalReplayAction } = require('../src/session');
const { replayConfigFor, replayStep } = require('../src/replay');
const { normalizeActions } = require('../../runwave/controller/src/action-normalizer');

function solidPng(width, height, color = [10, 20, 30]) {
  const png = new PNG({ width, height });
  for (let i = 0; i < width * height; i += 1) {
    const idx = i << 2;
    png.data[idx] = color[0];
    png.data[idx + 1] = color[1];
    png.data[idx + 2] = color[2];
    png.data[idx + 3] = 255;
  }
  return png;
}

test('session config disables recording and grid overlay by default', () => {
  const config = buildSessionConfig({ url: 'http://127.0.0.1:1/' });
  assert.equal(config.record, false, 'recording must be off so gstreamer is never required');
  assert.equal(config.headless, true);
  assert.equal(config.gridScreenshots, false, 'overlay must be opt-in to keep image and input coordinates aligned');
  assert.equal(config.autoCaptures, false);
  assert.equal(config.pauseController, true);
  assert.equal(config.maxActionSpanMs.click, 2000);
});

test('MCP sessions allow a bounded held mouse button without changing normal Runwave clicks', () => {
  const heldClick = [{ type: 'click', start: 0, end: 1500, x: 10, y: 20 }];
  assert.doesNotThrow(() => normalizeActions(
    heldClick,
    1600,
    { strict: true, config: buildSessionConfig(), aliases: {} }
  ));
  assert.throws(
    () => normalizeActions(heldClick, 1600, { strict: true, config: {}, aliases: {} }),
    /click action duration exceeds 100ms/
  );
});

test('session config always carries a numeric viewport so grid cells resolve', () => {
  // The daemon passes raw CLI input through, which is why cell actions fail
  // there when no viewport was given. Building the config must close that gap.
  const config = buildSessionConfig({ url: 'http://127.0.0.1:1/' });
  assert.equal(typeof config.viewport.width, 'number');
  assert.ok(config.viewport.width > 0 && config.viewport.height > 0);
  const [click] = normalizeActions(
    [{ type: 'click', start: 0, overlay_row: 2, overlay_col: 3 }],
    500,
    { strict: true, config, aliases: {}, roundPoints: true }
  );
  assert.equal(typeof click.x, 'number');
  assert.equal(typeof click.y, 'number');
});

test('grid cell targets resolve to a stable point so traces replay identically', () => {
  const config = buildSessionConfig({ viewport: { width: 1280, height: 720 } });
  const points = new Set();
  for (let i = 0; i < 50; i += 1) {
    const [click] = normalizeActions(
      [{ type: 'click', start: 0, overlay_row: 6, overlay_col: 7 }],
      500,
      { strict: true, config, aliases: {}, roundPoints: true }
    );
    points.add(`${click.x},${click.y}`);
  }
  assert.equal(points.size, 1, `expected one deterministic point, got ${[...points].join(' ')}`);
});

test('playtest scatter is preserved when sample mode is not set', () => {
  const config = buildSessionConfig({ viewport: { width: 1280, height: 720 } });
  delete config.markGridSampleMode;
  const points = new Set();
  for (let i = 0; i < 80; i += 1) {
    const [click] = normalizeActions(
      [{ type: 'click', start: 0, overlay_row: 6, overlay_col: 7 }],
      500,
      { strict: true, config, aliases: {}, roundPoints: true }
    );
    points.add(`${click.x},${click.y}`);
  }
  assert.ok(points.size > 5, 'default runwave behaviour must remain random');
});

test('normalizeViewport falls back on invalid input', () => {
  assert.deepEqual(normalizeViewport({ width: 0, height: -4 }), { width: 1280, height: 720 });
  assert.deepEqual(normalizeViewport({ width: 800, height: 600 }), { width: 800, height: 600 });
});

test('resize halves dimensions and clamps scale above one', () => {
  const png = solidPng(100, 50);
  const half = resize(png, 0.5);
  assert.equal(half.width, 50);
  assert.equal(half.height, 25);
  assert.equal(clampScale(4), 1);
  assert.equal(resize(png, 1).width, 100);
});

test('resize preserves colour when downscaling a solid image', () => {
  const png = solidPng(40, 40, [200, 100, 50]);
  const small = resize(png, 0.25);
  assert.deepEqual([small.data[0], small.data[1], small.data[2]], [200, 100, 50]);
});

test('crop clamps an out-of-bounds region instead of throwing', () => {
  const png = solidPng(100, 100);
  const { region } = crop(png, { x: 90, y: 90, width: 400, height: 400 });
  assert.deepEqual(region, { x: 90, y: 90, width: 10, height: 10 });
});

test('compactState keeps the largest canvas as the game area and drops noise', () => {
  const state = compactState({
    generic: {
      title: 'Game',
      url: 'http://x/',
      activeElement: { tagName: 'BODY' },
      webgl: { renderer: 'SwiftShader', vendor: 'Google', supported: true },
      canvases: [
        { clientWidth: 10, clientHeight: 10, left: 0, top: 0 },
        { clientWidth: 640, clientHeight: 360, left: 20, top: 30 },
      ],
    },
  });
  assert.deepEqual(state.game_area, { x: 20, y: 30, width: 640, height: 360 });
  assert.equal(state.pointer_locked, false);
  assert.equal(state.canvas_count, 2);
  assert.equal(state.webgl, undefined, 'renderer probe is per-turn noise for a player');
  assert.equal(state.focus, undefined, 'a BODY focus carries no signal');
});

test('compactState surfaces custom state and errors from a stateExpression', () => {
  assert.equal(compactState({ generic: {}, custom: { score: 7 } }).custom.score, 7);
  assert.match(compactState({ generic: {}, customError: 'boom' }).custom_error, /boom/);
});

test('act schema accepts every action type the executor implements', () => {
  const cases = [
    { type: 'key', start: 0, end: 900, key: 'ArrowRight' },
    { type: 'click', start: 100, x: 10, y: 20 },
    { type: 'click', start: 100, overlay_row: 6, overlay_col: 7 },
    { type: 'multi_click', start: 0, cells: [{ overlay_row: 1, overlay_col: 1 }], count: 5 },
    { type: 'drag', start: 0, end: 500, from: { x: 1, y: 2 }, to: { x: 3, y: 4 }, mode: 'mouse' },
    { type: 'cursor_move', start: 0, x: 5, y: 5, steps: 8 },
    { type: 'view_move', start: 0, end: 400, dx: 120, dy: -20 },
  ];
  for (const item of cases) assert.doesNotThrow(() => action.parse(item), `failed: ${item.type}`);
});

test('act schema rejects unknown action types and negative offsets', () => {
  assert.throws(() => action.parse({ type: 'scroll', start: 0 }));
  assert.throws(() => action.parse({ type: 'key', start: -5, key: 'a' }));
});

test('playthrough persistence stores concrete replay-safe inputs atomically', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'runwave-playthrough-unit-'));
  const session = new Session({
    id: 'playthrough-test',
    workspace,
    options: { url: 'about:blank', idleTimeoutMs: 0 },
  });
  session.browser = { close: async () => {} };
  try {
    session.appendPlaythroughStep({
      duration: 600,
      note: 'move and shoot',
      actions: [
        { type: 'key', start: 0, end: 600, key: 'right', resolvedKey: 'ArrowRight' },
        { type: 'click', start: 200, end: 250, x: 321, y: 123, button: 'left', clickCount: 1, cells: [{ row: 1, col: 2 }] },
      ],
    });

    const saved = JSON.parse(fs.readFileSync(session.paths.playthrough, 'utf8'));
    assert.equal(saved.total_duration_ms, 600);
    assert.equal(saved.steps[0].note, 'move and shoot');
    assert.deepEqual(saved.steps[0].actions, [
      { type: 'key', start: 0, end: 600, key: 'ArrowRight' },
      { type: 'click', start: 200, end: 250, x: 321, y: 123, button: 'left', clickCount: 1 },
    ]);
    assert.equal(fs.readdirSync(session.paths.runDir).some((name) => name.endsWith('.tmp')), false);

    session.resetPlaythrough();
    assert.equal(session.playthrough.attempt, 2);
    assert.equal(session.playthrough.steps.length, 0);
    assert.equal(session.playthrough.total_duration_ms, 0);
  } finally {
    await session.close();
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('replay normalization retains step timing without screenshot events', () => {
  const session = {
    browser: { launchUrl: 'https://example.test/game' },
    config: buildSessionConfig({ url: 'https://example.test/game', viewport: { width: 800, height: 450 } }),
  };
  const config = replayConfigFor(session);
  const step = replayStep({
    duration_ms: 500,
    actions: [canonicalReplayAction({
      type: 'cursor_move', start: 50, end: 300, to: { x: 400, y: 200, cells: [{ row: 1, col: 1 }] }, steps: 8,
    })],
  }, config, 1);

  assert.equal(config.recordingBackend, 'playwright');
  assert.equal(config.pauseController, true);
  assert.equal(config.maxActionSpanMs.click, 2000);
  assert.equal(step.duration, 500);
  assert.deepEqual(step.cursorMoves[0].to, { x: 400, y: 200 });
});

test('replay accepts the MCP session held-click limit', () => {
  const session = {
    browser: { launchUrl: 'https://example.test/game' },
    config: buildSessionConfig({ url: 'https://example.test/game' }),
  };
  const config = replayConfigFor(session);
  assert.doesNotThrow(() => replayStep({
    duration_ms: 1900,
    actions: [{ type: 'click', start: 200, end: 1700, x: 640, y: 360 }],
  }, config, 1));
});

test('manual pause bypasses queued gameplay and requires an explicit resume', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'runwave-pause-unit-'));
  const session = new Session({
    id: 'pause-test',
    workspace,
    options: { url: 'about:blank', idleTimeoutMs: 0 },
  });
  const calls = [];
  session.browser = {
    launchUrl: 'about:blank',
    pause: async () => { calls.push('pause'); },
    resume: async () => { calls.push('resume'); },
    close: async () => {},
  };
  let release;
  try {
    const running = session.run(async () => {
      calls.push('act-start');
      await new Promise((resolve) => { release = resolve; });
      calls.push('act-end');
    });
    await new Promise((resolve) => setImmediate(resolve));

    await session.pause({ mode: 'manual', reason: 'interrupt test' });
    assert.deepEqual(calls, ['act-start', 'pause'], 'pause must not wait for the active session queue');
    await assert.rejects(session.prepareForGameplay(), /manually paused.*resume_game/);

    await session.resume({ force: true });
    assert.deepEqual(calls, ['act-start', 'pause', 'resume']);
    release();
    await running;
  } finally {
    if (release) release();
    await session.close();
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
