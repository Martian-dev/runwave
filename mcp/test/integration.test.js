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

const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
const { chromium } = require('playwright');
const { SessionRegistry } = require('../src/registry');
const { createServer } = require('../src/server');
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
      beforeEndCapture: () => session.pauseForAgent('integration test'),
      profiler: null,
    });

    assert.equal(step.captures.length, 1, 'one frame per turn unless more are requested');
    const after = step.endState;
    assert.ok(
      after.custom.x > before.custom.x + 20,
      `holding right must move the player: ${before.custom.x} -> ${after.custom.x}`
    );
    assert.equal(changedSince(previousFrame, step.captures[0].path), true);
    assert.equal(await session.browser.isPaused(), true, 'the returned frame must be the pause boundary');
    session.lastFrame = step.captures[0].path;
  });

  await t.test('a grid cell click lands on the intended target', async () => {
    // The target sits at x 480-560, y 140-220 in a 640x360 viewport. On a 16x16
    // grid that is columns 12-13 and rows 6-9, so cell (7, 12) must hit it.
    const stepIndex = session.nextStepIndex();
    const actionName = `act-${stepIndex}`;
    await session.prepareForGameplay('integration test');
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
      beforeEndCapture: () => session.pauseForAgent('integration test'),
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

test('harness pause freezes page time and blocks gameplay input', async (t) => {
  if (!(await chromiumUsable())) {
    t.skip('chromium cannot launch here; run "npx playwright install-deps chromium"');
    return;
  }
  const workspace = await fsp.mkdtemp(path.join(os.tmpdir(), 'runwave-mcp-pause-'));
  const registry = new SessionRegistry({ workspace });
  const html = `<!doctype html><script>
    window.ticks = 0;
    window.keys = 0;
    window.frames = 0;
    setInterval(() => window.ticks += 1, 20);
    const animate = () => { window.frames += 1; requestAnimationFrame(animate); };
    requestAnimationFrame(animate);
    window.addEventListener('keydown', () => window.keys += 1);
  </script>`;
  const session = await registry.create({
    url: `data:text/html,${encodeURIComponent(html)}`,
    viewport: { width: 320, height: 200 },
    waitAfterLoad: 0,
  });
  t.after(async () => {
    await registry.closeAll();
    await fsp.rm(workspace, { recursive: true, force: true });
  });

  await session.browser.page.waitForTimeout(120);
  await session.pause({ mode: 'manual', reason: 'integration test' });
  const pausedAt = await session.browser.page.evaluate(() => ({ ticks, frames, now: performance.now() }));
  await session.browser.page.waitForTimeout(250);
  const frozen = await session.browser.page.evaluate(() => ({
    ticks,
    frames,
    now: performance.now(),
    paused: window.__runwavePauseController.isPaused(),
  }));
  assert.equal(frozen.paused, true);
  assert.equal(frozen.ticks, pausedAt.ticks, 'game timers must not advance while paused');
  assert.equal(frozen.frames, pausedAt.frames, 'animation frames must not advance while paused');
  assert.ok(frozen.now - pausedAt.now < 10, 'logical performance time must remain frozen');

  await session.browser.keyDown('a');
  await session.browser.keyUp('a');
  assert.equal(await session.browser.page.evaluate(() => keys), 0, 'paused input must not reach the game');

  await session.resume({ force: true, reason: 'integration test' });
  await session.browser.keyDown('a');
  await session.browser.keyUp('a');
  await session.browser.page.waitForTimeout(120);
  const after = await session.browser.page.evaluate(() => ({ ticks, frames, keys, paused: window.__runwavePauseController.isPaused() }));
  assert.equal(after.paused, false);
  assert.ok(after.ticks > frozen.ticks, 'game timers must resume');
  assert.ok(after.frames > frozen.frames, 'animation frames must resume');
  assert.equal(after.keys, 1, 'resumed input must reach the game');
});

test('pointer-locked view movement reaches games as one trusted delta', async (t) => {
  if (!(await chromiumUsable())) {
    t.skip('chromium cannot launch here; run "npx playwright install-deps chromium"');
    return;
  }
  const workspace = await fsp.mkdtemp(path.join(os.tmpdir(), 'runwave-mcp-pointer-lock-'));
  const registry = new SessionRegistry({ workspace });
  const html = `<!doctype html><canvas id="game" width="640" height="360"></canvas><script>
    window.moves = [];
    const game = document.querySelector('#game');
    game.addEventListener('mousedown', () => game.requestPointerLock());
    window.addEventListener('mousemove', (event) => {
      if (event.movementX || event.movementY) {
        window.moves.push({ x: event.movementX, y: event.movementY, trusted: event.isTrusted });
      }
    });
  </script>`;
  const session = await registry.create({
    url: `data:text/html,${encodeURIComponent(html)}`,
    viewport: VIEWPORT,
    waitAfterLoad: 0,
  });
  t.after(async () => {
    await registry.closeAll();
    await fsp.rm(workspace, { recursive: true, force: true });
  });

  await session.browser.page.mouse.move(200, 180);
  session.browser.mousePosition = { x: 200, y: 180 };
  await session.browser.page.evaluate(() => { window.moves = []; });
  const focus = await session.browser.focusGame({ button: 'middle' });
  assert.equal(focus.pointerLocked, true);
  assert.deepEqual(
    await session.browser.page.evaluate(() => window.moves),
    [],
    'acquiring pointer lock must not rotate the game camera'
  );

  await session.browser.moveView({ dx: 24, dy: -9, steps: 1 });
  await session.browser.page.waitForTimeout(50);
  assert.deepEqual(await session.browser.page.evaluate(() => window.moves), [
    { x: 24, y: -9, trusted: true },
  ]);
});

test('MCP tool loop pauses every returned frame and resumes only for act', async (t) => {
  if (!(await chromiumUsable())) {
    t.skip('chromium cannot launch here; run "npx playwright install-deps chromium"');
    return;
  }
  const workspace = await fsp.mkdtemp(path.join(os.tmpdir(), 'runwave-mcp-tools-pause-'));
  const { server, registry } = createServer({ workspace });
  const client = new Client({ name: 'runwave-pause-integration', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => {
    await registry.closeAll();
    await client.close().catch(() => {});
    await server.close().catch(() => {});
    await fsp.rm(workspace, { recursive: true, force: true });
  });

  const textOf = (result) => result.content
    .filter((item) => item.type === 'text')
    .map((item) => item.text)
    .join('\n');
  const stateOf = (result) => {
    const match = textOf(result).match(/state: (\{.*\})/);
    assert.ok(match, `missing state in result: ${textOf(result)}`);
    return JSON.parse(match[1]);
  };
  const html = '<div id="ticks">0</div><script>window.ticks=0;setInterval(()=>{window.ticks+=1;document.querySelector("#ticks").textContent=window.ticks},20)</script>';
  const launch = await client.callTool({
    name: 'launch_game',
    arguments: {
      url: `data:text/html,${encodeURIComponent(html)}`,
      viewport: { width: 320, height: 200 },
      state_expression: '() => ({ ticks: window.ticks })',
      full_res: true,
    },
  });
  const sessionId = textOf(launch).match(/session_id: (\S+)/)[1];
  const session = registry.get(sessionId);
  const initialTicks = stateOf(launch).custom.ticks;
  assert.equal(session.pauseMode, 'automatic');
  assert.equal(await session.browser.isPaused(), true);

  await new Promise((resolve) => setTimeout(resolve, 150));
  const still = await client.callTool({ name: 'observe', arguments: { session_id: sessionId, full_res: true } });
  assert.equal(stateOf(still).custom.ticks, initialTicks, 'the game must not advance during model reasoning');

  const invalidWait = await client.callTool({
    name: 'act',
    arguments: { session_id: sessionId, actions: [] },
  });
  assert.equal(invalidWait.isError, true);
  assert.match(textOf(invalidWait), /positive duration_ms/);

  const acted = await client.callTool({
    name: 'act',
    arguments: {
      session_id: sessionId,
      actions: [],
      duration_ms: 160,
      full_res: true,
    },
  });
  const actedTicks = stateOf(acted).custom.ticks;
  assert.ok(actedTicks > initialTicks, 'act must resume the game for its controlled duration');
  assert.equal(session.pauseMode, 'automatic');
  assert.equal(await session.browser.isPaused(), true);

  await new Promise((resolve) => setTimeout(resolve, 150));
  const after = await client.callTool({ name: 'observe', arguments: { session_id: sessionId, full_res: true } });
  assert.equal(stateOf(after).custom.ticks, actedTicks, 'the final act frame must be the pause boundary');

  const persisted = JSON.parse(await fsp.readFile(session.paths.playthrough, 'utf8'));
  assert.equal(persisted.steps.length, 1);
  assert.equal(persisted.steps[0].duration_ms, 160);
  assert.deepEqual(persisted.steps[0].actions, []);

  const beforeRenderTicks = await session.browser.page.evaluate(() => ticks);
  const rendered = await client.callTool({
    name: 'render_playthrough',
    arguments: { session_id: sessionId, tail_ms: 100 },
  });
  assert.notEqual(rendered.isError, true, textOf(rendered));
  const replay = JSON.parse(textOf(rendered));
  assert.equal(replay.recording_backend, 'playwright');
  assert.equal(replay.step_count, 1);
  assert.ok((await fsp.stat(replay.video)).size > 0, 'replay must produce a non-empty WebM');
  assert.ok((await fsp.stat(replay.source_playthrough)).size > 0, 'replay must retain its exact timeline snapshot');
  assert.ok((await fsp.stat(replay.manifest)).size > 0, 'replay must produce a manifest');
  assert.equal(await session.browser.page.evaluate(() => ticks), beforeRenderTicks, 'rendering must not advance the live game');
  assert.equal(await session.browser.isPaused(), true, 'live game remains paused while the separate replay renders');

  await client.callTool({ name: 'pause_game', arguments: { session_id: sessionId, reason: 'override test' } });
  const blocked = await client.callTool({
    name: 'act',
    arguments: { session_id: sessionId, actions: [{ type: 'key', start: 0, end: 50, key: 'a' }] },
  });
  assert.equal(blocked.isError, true);
  assert.match(textOf(blocked), /resume_game/);
  await client.callTool({ name: 'resume_game', arguments: { session_id: sessionId } });
  await client.callTool({ name: 'end_game', arguments: { session_id: sessionId } });
});
