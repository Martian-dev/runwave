const path = require('path');
const { pathToFileURL } = require('url');
const { DEFAULT_MARK_GRID } = require('../../protocol/src/mark-grid');
const { workspaceRoot } = require('./paths');

function usage() {
  return {
    usage: `runwave '<json>'`,
    notes: [
      'Every controller operation must include action_name and session_id.',
      'Use {"action":"sessions"} to list known sessions.',
      'Use web start with url, file, or a local port. Use linux start with kind:"linux" and a command or window selector.',
      'Each operation writes artifacts to state/output/<action_name>/ by default.',
      'Relative file and output paths resolve from RUNWAVE_WORKSPACE or the current working directory.',
    ],
    examples: [
      {
        action: 'start',
        action_name: 'start-linux-run',
        session_id: 'playtest-002',
        kind: 'linux',
        command: './game',
        args: ['--windowed'],
        cwd: '/absolute/path/to/game',
        windowTitle: 'Native Game',
        record: true,
      },
      {
        action: 'step',
        action_name: 'move-right-001',
        session_id: 'playtest-001',
        actions: [
          { type: 'key', start: 0, end: 900, key: 'right' },
          { type: 'key', start: 150, end: 230, key: 'jump' },
        ],
        captures: [900],
        captureIntervalMs: 1000,
      },
      { action: 'screenshot', action_name: 'inspect-001', session_id: 'playtest-001', name: 'screen' },
      { action: 'state', action_name: 'state-001', session_id: 'playtest-001' },
      { action: 'sessions' },
      { action: 'stop', action_name: 'stop-run', session_id: 'playtest-001' },
    ],
  };
}

function assertActionName(input) {
  if (!input || !input.action_name) {
    throw new Error('action_name is required for every runwave operation');
  }
}

function sessionId(input) {
  const value = input && (input.session_id ?? input.sessionId);
  const text = String(value ?? '').trim();
  if (!text) throw new Error('session_id is required for start, stop, and controller actions');
  return text;
}

function assertSessionId(input) {
  sessionId(input);
}

function targetUrl(input, options = {}) {
  if (input.url) return String(input.url);
  if (input.port !== undefined && input.port !== null && input.port !== '') {
    const port = Number(input.port);
    if (!Number.isInteger(port) || port <= 0) throw new Error(`invalid web game port: ${input.port}`);
    return `http://127.0.0.1:${port}/`;
  }
  if (input.file) {
    const filePath = path.resolve(options.workspaceRoot || workspaceRoot, input.file);
    return pathToFileURL(filePath).href;
  }
  throw new Error('start/navigate requires url, file, or port');
}

function normalizeTargetKind(value) {
  const text = String(value || 'web').trim().toLowerCase();
  if (!text || text === 'web' || text === 'browser' || text === 'chromium') return 'web';
  if (text === 'linux' || text === 'native') return 'linux';
  throw new Error(`unsupported runwave target kind: ${value}`);
}

function targetKind(input) {
  return normalizeTargetKind(input && (input.kind ?? input.targetKind ?? input.sessionKind));
}

function parseArgList(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  const text = String(value).trim();
  if (!text) return [];
  if (text.startsWith('[')) {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean);
    } catch {
      // Fall through to whitespace parsing.
    }
  }
  return text.split(/\s+/).filter(Boolean);
}

function normalizeSize(value, fallback) {
  const width = Number(value && value.width);
  const height = Number(value && value.height);
  return {
    width: Number.isFinite(width) && width > 0 ? width : fallback.width,
    height: Number.isFinite(height) && height > 0 ? height : fallback.height,
  };
}

function sortedObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, value[key]]));
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

function sameCanonicalValue(left, right) {
  return JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right));
}

function optionalString(value) {
  return value === undefined || value === null || value === '' ? null : String(value);
}

function optionalNumber(value, fallback) {
  const number = Number(value ?? fallback);
  return Number.isFinite(number) ? number : fallback;
}

function optionalPositiveInteger(value) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function recordingBackend(input = {}, env = process.env) {
  if (!input.record && !input.recordAudio) return null;
  const raw = String(
    input.recordingBackend
      ?? input.recording_backend
      ?? input.recordBackend
      ?? input.videoBackend
      ?? env.RUNWAVE_RECORDING_BACKEND
      ?? 'gstreamer'
  ).trim().toLowerCase();
  if (raw === 'gstreamer' || raw === 'x11') return 'gstreamer';
  if (raw === 'playwright' || raw === 'playwright-native' || raw === 'native') return 'playwright';
  throw new Error(`unsupported recording backend: ${raw}`);
}

function linuxStartConfig(input = {}) {
  const launch = input.launch && typeof input.launch === 'object' ? input.launch : {};
  const launchEnv = input.env ?? launch.env;
  const explicitCommand = optionalString(input.command ?? input.launchCommand ?? launch.command);
  const command = explicitCommand || (input.gameDir ? 'bash' : null);
  const rawArgs = input.args ?? input.launchArgs ?? launch.args;
  return {
    command,
    args: rawArgs === undefined && command && !explicitCommand ? ['start.sh'] : parseArgList(rawArgs),
    cwd: optionalString(input.cwd ?? input.launchCwd ?? launch.cwd ?? input.gameDir),
    envKeys: Object.keys(sortedObject(launchEnv)),
    windowId: optionalString(input.windowId ?? input.window_id),
    windowTitle: optionalString(input.windowTitle ?? input.window_title),
    windowClass: optionalString(input.windowClass ?? input.window_class),
    windowWaitMs: optionalNumber(input.windowWaitMs ?? input.window_wait_ms, 15000),
    launchSettleMs: Math.max(0, optionalNumber(input.launchSettleMs ?? input.launch_settle_ms ?? launch.launchSettleMs ?? launch.launch_settle_ms, 30000)),
    resizeWindow: input.resizeWindow !== false,
  };
}

function webStartConfig(input = {}, options = {}) {
  const launch = input.launch && typeof input.launch === 'object' ? input.launch : {};
  const launchEnv = input.env ?? launch.env;
  const explicitCommand = optionalString(input.command ?? input.launchCommand ?? launch.command);
  const command = explicitCommand || (input.gameDir ? 'bash' : null);
  const rawArgs = input.args ?? input.launchArgs ?? launch.args;
  return {
    launchUrl: targetUrl(input, options),
    port: optionalPositiveInteger(input.port),
    command,
    args: rawArgs === undefined && command && !explicitCommand ? ['start.sh'] : parseArgList(rawArgs),
    cwd: optionalString(input.cwd ?? input.launchCwd ?? launch.cwd ?? input.gameDir),
    envKeys: Object.keys(sortedObject(launchEnv)),
    httpTimeoutMs: optionalNumber(input.httpTimeoutMs ?? input.http_timeout_ms, 60000),
  };
}

function startSessionConfig(input, options = {}) {
  const kind = targetKind(input);
  const viewport = normalizeSize(input.viewport, { width: 1024, height: 620 });
  const record = Boolean(input.record || input.recordAudio);
  const backend = recordingBackend(input);
  if (kind === 'linux' && backend && backend !== 'gstreamer') {
    throw new Error(`the ${backend} recording backend is only available for web sessions`);
  }
  const common = {
    kind,
    context: {
      viewport,
      deviceScaleFactor: optionalNumber(input.deviceScaleFactor, 1),
      record,
      recordingBackend: backend,
      videoSize: record ? normalizeSize(input.videoSize || input.viewport, viewport) : null,
    },
    defaults: {
      keyAliases: sortedObject(input.keyAliases),
      stateExpression: optionalString(input.stateExpression),
      autoCaptures: input.autoCaptures !== false,
      captureIntervalMs: optionalNumber(input.captureIntervalMs, 1000),
      finalScreenshot: input.finalScreenshot !== false,
      fullPageScreenshots: Boolean(input.fullPageScreenshots),
      gridScreenshots: input.gridScreenshots !== false,
      markGridRows: optionalNumber(input.markGridRows ?? input.gridRows, DEFAULT_MARK_GRID.rows),
      markGridCols: optionalNumber(input.markGridCols ?? input.gridCols, DEFAULT_MARK_GRID.cols),
    },
  };

  if (kind === 'linux') {
    return {
      ...common,
      linux: linuxStartConfig(input),
    };
  }

  const web = webStartConfig(input, options);
  return {
    ...common,
    launchUrl: web.launchUrl,
    web,
    browser: {
      headless: backend === 'gstreamer' ? false : input.headless !== false,
      channel: optionalString(input.channel),
      executablePath: optionalString(input.executablePath),
      chromiumArgsMode: String(input.chromiumArgsMode || process.env.RUNWAVE_CHROMIUM_ARGS_MODE || 'append').toLowerCase(),
      chromiumArgs: parseArgList(input.chromiumArgs ?? process.env.RUNWAVE_CHROMIUM_ARGS),
    },
    navigation: {
      waitUntil: String(input.waitUntil || 'load'),
      waitAfterLoad: optionalNumber(input.waitAfterLoad, 700),
    },
  };
}

function isListSessionsAction(input) {
  return input && (input.action === 'sessions' || input.action === 'list_sessions');
}

function diffStartSessionConfig(requested, existing) {
  if (!existing || typeof existing !== 'object') return ['startConfig'];
  const differences = [];
  for (const key of Object.keys(requested)) {
    if (!sameCanonicalValue(requested[key], existing[key])) differences.push(key);
  }
  for (const key of Object.keys(existing)) {
    if (!Object.prototype.hasOwnProperty.call(requested, key)) differences.push(key);
  }
  return [...new Set(differences)];
}

function parseCliInput(raw) {
  if (!raw || raw === '--help' || raw === 'help') return null;
  return JSON.parse(raw);
}

module.exports = {
  usage,
  assertActionName,
  assertSessionId,
  sessionId,
  targetUrl,
  targetKind,
  normalizeTargetKind,
  linuxStartConfig,
  webStartConfig,
  parseArgList,
  recordingBackend,
  startSessionConfig,
  diffStartSessionConfig,
  isListSessionsAction,
  parseCliInput,
};
