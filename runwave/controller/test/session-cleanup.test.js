const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const { createProfiler } = require('../src/profiler');
const { existingSessionStart, stopExistingSessionForForce } = require('../src/api');
const { startSessionConfig } = require('../src/protocol');

function writeSession(dir, session) {
  const file = path.join(dir, 'session.json');
  fs.writeFileSync(file, JSON.stringify(session, null, 2));
  return file;
}

function profiler() {
  return createProfiler({ enabled: false, source: 'test' });
}

test('start reuses a live session only when the start configuration matches', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runwave-compatible-start-'));
  const start = {
    action: 'start',
    action_name: 'start-again',
    url: 'http://127.0.0.1:3000/',
    viewport: { width: 640, height: 420 },
    record: true,
    headless: true,
    chromiumArgs: ['--no-sandbox'],
  };
  const sessionFile = writeSession(tmpDir, {
    pid: 12345,
    port: 43210,
    startConfig: startSessionConfig(start),
  });
  const posted = [];

  try {
    const result = await existingSessionStart(start, profiler(), {
      sessionFilePath: sessionFile,
      postJson: async (port, payload) => {
        posted.push({ port, payload });
        return payload.action === 'ping'
          ? { ok: true, action: 'ping' }
          : { ok: true, action: 'state', state: { generic: { url: start.url } } };
      },
    });

    assert.equal(result.alreadyRunning, true);
    assert.equal(result.session.port, 43210);
    assert.deepEqual(posted.map((entry) => entry.payload.action), ['ping', 'state']);
    assert.equal(fs.existsSync(sessionFile), true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('start rejects a live session with a different target instead of silently reusing it', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runwave-target-mismatch-'));
  const originalStart = {
    action: 'start',
    action_name: 'old-start',
    url: 'http://127.0.0.1:3000/old',
    viewport: { width: 640, height: 420 },
  };
  const sessionFile = writeSession(tmpDir, {
    pid: 12345,
    port: 43210,
    startConfig: startSessionConfig(originalStart),
  });
  const posted = [];

  try {
    await assert.rejects(
      existingSessionStart(
        {
          ...originalStart,
          action_name: 'new-start',
          url: 'http://127.0.0.1:3000/new',
        },
        profiler(),
        {
          sessionFilePath: sessionFile,
          postJson: async (port, payload) => {
            posted.push({ port, payload });
            return { ok: true, action: payload.action };
          },
        }
      ),
      /different start configuration \(launchUrl, web\).*"force": true/
    );

    assert.deepEqual(posted.map((entry) => entry.payload.action), ['ping']);
    assert.equal(fs.existsSync(sessionFile), true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('start rejects a live session with different viewport or launch options', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runwave-config-mismatch-'));
  const originalStart = {
    action: 'start',
    action_name: 'old-start',
    url: 'http://127.0.0.1:3000/',
    viewport: { width: 640, height: 420 },
    chromiumArgs: ['--no-sandbox'],
  };
  const sessionFile = writeSession(tmpDir, {
    pid: 12345,
    port: 43210,
    startConfig: startSessionConfig(originalStart),
  });

  try {
    await assert.rejects(
      existingSessionStart(
        {
          ...originalStart,
          action_name: 'new-start',
          viewport: { width: 800, height: 600 },
          chromiumArgs: ['--no-sandbox', '--disable-gpu'],
        },
        profiler(),
        {
          sessionFilePath: sessionFile,
          postJson: async (port, payload) => ({ ok: true, action: payload.action }),
        }
      ),
      /different start configuration \((browser, context|context, browser)\).*"force": true/
    );

    assert.equal(fs.existsSync(sessionFile), true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('linux start configuration does not require a browser URL', () => {
  const config = startSessionConfig({
    action: 'start',
    action_name: 'linux-start',
    kind: 'linux',
    command: './game',
    args: ['--windowed'],
    cwd: '/tmp/game',
    windowTitle: 'Native Game',
    viewport: { width: 1280, height: 720 },
    record: true,
  });

  assert.equal(config.kind, 'linux');
  assert.equal(config.launchUrl, undefined);
  assert.deepEqual(config.context.viewport, { width: 1280, height: 720 });
  assert.deepEqual(config.linux, {
    command: './game',
    args: ['--windowed'],
    cwd: '/tmp/game',
    envKeys: [],
    windowId: null,
    windowTitle: 'Native Game',
    windowClass: null,
    windowWaitMs: 15000,
    launchSettleMs: 30000,
    resizeWindow: true,
  });
});

test('linux start configuration can launch a game directory with the default script', () => {
  const config = startSessionConfig({
    action: 'start',
    action_name: 'linux-start',
    kind: 'linux',
    gameDir: '/tmp/native-game',
    viewport: { width: 1280, height: 720 },
    record: true,
  });

  assert.equal(config.kind, 'linux');
  assert.equal(config.launchUrl, undefined);
  assert.deepEqual(config.linux, {
    command: 'bash',
    args: ['start.sh'],
    cwd: '/tmp/native-game',
    envKeys: [],
    windowId: null,
    windowTitle: null,
    windowClass: null,
    windowWaitMs: 15000,
    launchSettleMs: 30000,
    resizeWindow: true,
  });
});

test('web start configuration can launch a game directory through a local port', () => {
  const config = startSessionConfig({
    action: 'start',
    action_name: 'web-start',
    kind: 'web',
    gameDir: '/tmp/web-game',
    port: 4123,
    viewport: { width: 1280, height: 720 },
    record: true,
  });

  assert.equal(config.kind, 'web');
  assert.equal(config.launchUrl, 'http://127.0.0.1:4123/');
  assert.deepEqual(config.context.viewport, { width: 1280, height: 720 });
  assert.equal(config.web.launchUrl, 'http://127.0.0.1:4123/');
  assert.equal(config.web.port, 4123);
  assert.equal(config.web.command, 'bash');
  assert.deepEqual(config.web.args, ['start.sh']);
  assert.equal(config.web.cwd, '/tmp/web-game');
  assert.equal(config.web.httpTimeoutMs, 60000);
});

test('playwright recording is represented as a headless web session', () => {
  const config = startSessionConfig({
    action: 'start',
    action_name: 'playwright-recording',
    url: 'http://127.0.0.1:4123/',
    viewport: { width: 1280, height: 720 },
    record: true,
    recordingBackend: 'playwright',
  });

  assert.equal(config.context.record, true);
  assert.equal(config.context.recordingBackend, 'playwright');
  assert.equal(config.browser.headless, true);
});

test('linux sessions reject the playwright-only recording backend', () => {
  assert.throws(
    () => startSessionConfig({
      action: 'start',
      action_name: 'invalid-native-recording',
      kind: 'linux',
      command: './game',
      record: true,
      recordingBackend: 'playwright',
    }),
    /only available for web sessions/
  );
});

test('linux start rejects a live session with a different native launch command', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runwave-linux-target-mismatch-'));
  const originalStart = {
    action: 'start',
    action_name: 'old-linux-start',
    kind: 'linux',
    command: './game',
    args: ['--windowed'],
    cwd: '/tmp/game',
    windowTitle: 'Native Game',
    viewport: { width: 1280, height: 720 },
  };
  const sessionFile = writeSession(tmpDir, {
    pid: 12345,
    port: 43210,
    startConfig: startSessionConfig(originalStart),
  });

  try {
    await assert.rejects(
      existingSessionStart(
        {
          ...originalStart,
          action_name: 'new-linux-start',
          command: './other-game',
        },
        profiler(),
        {
          sessionFilePath: sessionFile,
          postJson: async (port, payload) => ({ ok: true, action: payload.action }),
        }
      ),
      /different start configuration \(linux\).*"force": true/
    );

    assert.equal(fs.existsSync(sessionFile), true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('force start stops an existing live session before removing the session file', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runwave-force-stop-'));
  const sessionFile = writeSession(tmpDir, { pid: 12345, port: 43210 });
  const posted = [];
  let running = true;

  try {
    const result = await stopExistingSessionForForce(
      { action_name: 'new-start', forceStopWaitMs: 1000 },
      profiler(),
      {
        sessionFilePath: sessionFile,
        postJson: async (port, payload) => {
          posted.push({ port, payload });
          running = false;
          return { ok: true, action: 'stop' };
        },
        kill: (pid, signal) => {
          assert.equal(pid, 12345);
          assert.equal(signal, 0);
          if (!running) {
            const error = new Error('not running');
            error.code = 'ESRCH';
            throw error;
          }
          return true;
        },
        sleep: async () => {},
      }
    );

    assert.equal(result.reason, 'stopped');
    assert.equal(result.stopped, true);
    assert.equal(fs.existsSync(sessionFile), false);
    assert.equal(posted.length, 1);
    assert.equal(posted[0].port, 43210);
    assert.deepEqual(posted[0].payload, {
      action: 'stop',
      action_name: 'new-start-force-stop',
      finalScreenshot: false,
      __runwaveVerbose: undefined,
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('force start keeps the session file and fails when the old daemon stays alive', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runwave-force-stop-live-'));
  const sessionFile = writeSession(tmpDir, { pid: 12345, port: 43210 });

  try {
    await assert.rejects(
      stopExistingSessionForForce(
        { action_name: 'new-start', forceStopWaitMs: 1 },
        profiler(),
        {
          sessionFilePath: sessionFile,
          postJson: async () => {
            throw new Error('connection refused');
          },
          kill: () => true,
          sleep: async () => {},
        }
      ),
      /still running after forced stop failed/
    );

    assert.equal(fs.existsSync(sessionFile), true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('force start removes a stale unreachable session file when no PID is alive', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runwave-force-stop-stale-'));
  const sessionFile = writeSession(tmpDir, { pid: 12345, port: 43210 });

  try {
    const result = await stopExistingSessionForForce(
      { action_name: 'new-start', forceStopWaitMs: 1 },
      profiler(),
      {
        sessionFilePath: sessionFile,
        postJson: async () => {
          throw new Error('connection refused');
        },
        kill: () => {
          const error = new Error('not running');
          error.code = 'ESRCH';
          throw error;
        },
        sleep: async () => {},
      }
    );

    assert.equal(result.reason, 'stale-session');
    assert.equal(fs.existsSync(sessionFile), false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
