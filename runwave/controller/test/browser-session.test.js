const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('os');
const path = require('node:path');
const test = require('node:test');

const {
  BrowserSession,
  browserViewportStabilizerScript,
  chromiumLaunchArgs,
  launchHeadless,
  pageViewportVideoSource,
  recordingBackend,
  usesGstreamerRecording,
  webLaunchConfig,
} = require('../src/browser-session');

test('chromium launch args leave non-recording runs unchanged', () => {
  const args = chromiumLaunchArgs({ record: false }, {});

  assert.equal(args.includes('--kiosk'), false);
  assert.equal(args.includes('--start-fullscreen'), false);
  assert.equal(args.some((arg) => arg.startsWith('--window-size=')), false);
});

test('chromium launch args hide browser chrome for gstreamer capture', () => {
  const args = chromiumLaunchArgs(
    {
      record: true,
      viewport: { width: 656, height: 496 },
      videoSize: { width: 656, height: 496 },
    },
    {}
  );

  assert.ok(args.includes('--window-position=0,0'));
  assert.ok(args.includes('--window-size=656,496'));
  assert.ok(args.includes('--kiosk'));
  assert.ok(args.includes('--start-fullscreen'));
  assert.ok(args.includes('--disable-infobars'));
});

test('recording sessions force a visible headed browser', () => {
  assert.equal(launchHeadless({ record: true }), false);
  assert.equal(launchHeadless({ record: true, headless: true }), false);
  assert.equal(launchHeadless({ record: false }), true);
  assert.equal(launchHeadless({ record: false, headless: false }), false);
});

test('playwright recording stays headless and does not add x11 window arguments', () => {
  const config = {
    record: true,
    recordingBackend: 'playwright',
    viewport: { width: 1280, height: 720 },
  };

  assert.equal(recordingBackend(config), 'playwright');
  assert.equal(usesGstreamerRecording(config), false);
  assert.equal(launchHeadless(config), true);
  assert.equal(chromiumLaunchArgs(config, {}).includes('--kiosk'), false);
});

test('recording backend rejects unknown values', () => {
  assert.throws(
    () => recordingBackend({ record: true, recordingBackend: 'unknown' }, {}),
    /unsupported recording backend: unknown/
  );
});

test('playwright recorder writes the configured viewport video and stops cleanly', async () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runwave-playwright-recording-'));
  const session = new BrowserSession(
    {
      url: 'about:blank',
      record: true,
      recordingBackend: 'playwright',
      viewport: { width: 1280, height: 720 },
    },
    { runDir }
  );
  const calls = [];
  session.videoDir = path.join(runDir, 'video');
  fs.mkdirSync(session.videoDir);
  session.page = {
    screencast: {
      start: async (options) => calls.push({ type: 'start', options }),
      stop: async () => {
        calls.push({ type: 'stop' });
        fs.writeFileSync(session.playwrightVideoPath, 'video');
      },
    },
  };

  try {
    const startedPath = await session.startPlaywrightRecording();
    const stoppedPath = await session.stopPlaywrightRecording();

    assert.equal(startedPath, path.join(session.videoDir, '000-runwave-playwright.webm'));
    assert.equal(stoppedPath, startedPath);
    assert.deepEqual(calls, [
      {
        type: 'start',
        options: {
          path: startedPath,
          size: { width: 1280, height: 720 },
        },
      },
      { type: 'stop' },
    ]);
  } finally {
    fs.rmSync(runDir, { recursive: true, force: true });
  }
});

test('browser launch config defaults game directories to start.sh', () => {
  assert.deepEqual(webLaunchConfig({ gameDir: '/tmp/web-game', port: 4123 }), {
    command: 'bash',
    args: ['start.sh'],
    cwd: '/tmp/web-game',
    env: null,
    port: 4123,
    httpTimeoutMs: 60000,
  });
});

test('page viewport video source crops past browser chrome', async () => {
  const page = {
    evaluate: async () => ({
      screenX: 0,
      screenY: 0,
      outerWidth: 1296,
      outerHeight: 812,
      innerWidth: 1280,
      innerHeight: 720,
    }),
  };

  assert.equal(await pageViewportVideoSource(page, { DISPLAY: ':123' }), ':123+8,92');
});

test('browser viewport stabilizer hides overflow and prevents scrolling keys', () => {
  const source = browserViewportStabilizerScript.toString();

  assert.match(source, /overflow:hidden/);
  assert.match(source, /window\.scrollTo\(0, 0\)/);
  assert.match(source, /ArrowDown/);
  assert.match(source, /preventDefault/);
});

test('browser clicks hold the mouse down for the normalized click interval', async () => {
  const session = new BrowserSession({ url: 'about:blank' }, { runDir: os.tmpdir() });
  const calls = [];
  session.page = {
    evaluate: async () => false,
    mouse: {
      move: async (x, y) => calls.push({ type: 'move', x, y }),
      down: async (options) => calls.push({ type: 'down', options, at: Date.now() }),
      up: async (options) => calls.push({ type: 'up', options, at: Date.now() }),
    },
  };

  const startedAt = Date.now();
  await session.click({ type: 'click', start: 100, end: 150, x: 321, y: 222, button: 'left', clickCount: 1 });

  assert.deepEqual(calls.map((call) => call.type), ['move', 'down', 'up']);
  assert.deepEqual(calls[0], { type: 'move', x: 321, y: 222 });
  assert.deepEqual(calls[1].options, { button: 'left', clickCount: 1 });
  assert.deepEqual(calls[2].options, { button: 'left', clickCount: 1 });
  assert.ok(Date.now() - startedAt >= 45);
  assert.deepEqual(session.mousePosition, { x: 321, y: 222 });
});

test('pointer-locked clicks do not move the FPS camera before pressing the button', async () => {
  const session = new BrowserSession({ url: 'about:blank' }, { runDir: os.tmpdir() });
  const calls = [];
  session.mousePosition = { x: 400, y: 300 };
  session.page = {
    evaluate: async () => true,
    mouse: {
      move: async (x, y) => calls.push({ type: 'move', x, y }),
      down: async (options) => calls.push({ type: 'down', options }),
      up: async (options) => calls.push({ type: 'up', options }),
    },
  };

  await session.click({ type: 'click', start: 0, end: 0, x: 640, y: 360, button: 'left', clickCount: 1 });

  assert.deepEqual(calls.map((call) => call.type), ['down', 'up']);
  assert.deepEqual(session.mousePosition, { x: 400, y: 300 });
});

test('pointer-locked view movement dispatches trusted relative samples and suppresses recentering', async () => {
  const session = new BrowserSession(
    { url: 'about:blank', viewport: { width: 1280, height: 720 } },
    { runDir: os.tmpdir() }
  );
  const moves = [];
  const evaluations = [];
  session.mousePosition = { x: 1270, y: 710 };
  session.page = {
    viewportSize: () => ({ width: 1280, height: 720 }),
    mouse: { move: async (x, y) => moves.push({ x, y }) },
    evaluate: async (fn, argument) => {
      evaluations.push({ fn, argument });
      return true;
    },
  };

  await session.moveView({ dx: 100, dy: 50, steps: 8 });

  assert.equal(moves.length, 1);
  assert.equal(moves.reduce((sum, move) => sum + move.x, 0), 100);
  assert.equal(moves.reduce((sum, move) => sum + move.y, 0), 50);
  assert.deepEqual(evaluations[1].argument, { x: 100, y: 50 });
  assert.deepEqual(session.mousePosition, { x: 1270, y: 710 });
});

test('unlocked view movement remains clamped to the viewport', async () => {
  const session = new BrowserSession(
    { url: 'about:blank', viewport: { width: 1280, height: 720 } },
    { runDir: os.tmpdir() }
  );
  const moves = [];
  session.mousePosition = { x: 1270, y: 710 };
  session.page = {
    viewportSize: () => ({ width: 1280, height: 720 }),
    mouse: { move: async (x, y) => moves.push({ x, y }) },
    evaluate: async () => false,
  };

  await session.moveView({ dx: 100, dy: 50 });

  assert.deepEqual(moves, [{ x: 1279, y: 719 }]);
  assert.deepEqual(session.mousePosition, { x: 1279, y: 719 });
});
