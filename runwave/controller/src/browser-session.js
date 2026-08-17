const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('playwright');
const { AudioVideoRecorder } = require('./audio-recorder');
const { ensureDir, safeName, sleep, timestamp } = require('./file-utils');
const { drawGridOnScreenshot } = require('./grid-overlay');
const { browserPauseInitScript } = require('./browser-pause');
const { parseArgList, recordingBackend, targetUrl } = require('./protocol');
const { readPageState } = require('./state-reader');

const DEFAULT_CHROMIUM_ARGS = [
  '--no-sandbox',
  '--ignore-gpu-blocklist',
  '--enable-gpu',
  '--use-gl=egl',
  '--enable-unsafe-swiftshader',
  '--autoplay-policy=no-user-gesture-required',
];
const DEFAULT_HTTP_TIMEOUT_MS = 60000;
const DEFAULT_PROCESS_STOP_WAIT_MS = 5000;
const DEFAULT_PROCESS_KILL_WAIT_MS = 5000;

function chromiumArgs(config = {}, env = process.env) {
  const configured = parseArgList(config.chromiumArgs ?? env.RUNWAVE_CHROMIUM_ARGS);
  const mode = String(config.chromiumArgsMode || env.RUNWAVE_CHROMIUM_ARGS_MODE || 'append').toLowerCase();
  if (mode === 'replace') return configured;
  return [...DEFAULT_CHROMIUM_ARGS, ...configured];
}

function videoSize(config = {}) {
  const size = config.videoSize || config.viewport || {};
  const width = Number(size.width);
  const height = Number(size.height);
  return {
    width: Number.isFinite(width) && width > 0 ? Math.round(width) : 1024,
    height: Number.isFinite(height) && height > 0 ? Math.round(height) : 620,
  };
}

function isRecording(config = {}) {
  return Boolean(config.record || config.recordAudio);
}

function usesGstreamerRecording(config = {}) {
  return recordingBackend(config) === 'gstreamer';
}

function chromiumLaunchArgs(config = {}, env = process.env) {
  const args = chromiumArgs(config, env);
  if (!usesGstreamerRecording(config)) return args;
  const size = videoSize(config);
  return [
    ...args,
    '--window-position=0,0',
    `--window-size=${size.width},${size.height}`,
    '--kiosk',
    '--start-fullscreen',
    '--disable-infobars',
  ];
}

function launchHeadless(config = {}) {
  return usesGstreamerRecording(config) ? false : config.headless !== false;
}

function webLaunchConfig(config = {}) {
  const launch = config.launch && typeof config.launch === 'object' ? config.launch : {};
  const explicitCommand = config.command || config.launchCommand || launch.command || null;
  const command = explicitCommand || (config.gameDir ? 'bash' : null);
  const rawArgs = config.args ?? config.launchArgs ?? launch.args;
  return {
    command,
    args: rawArgs === undefined && command && !explicitCommand ? ['start.sh'] : parseArgList(rawArgs),
    cwd: config.cwd || config.launchCwd || launch.cwd || config.gameDir || process.cwd(),
    env: launch.env || config.env || null,
    port: config.port,
    httpTimeoutMs: Number(config.httpTimeoutMs ?? config.http_timeout_ms ?? DEFAULT_HTTP_TIMEOUT_MS),
  };
}

function processHasClosed(child) {
  return Boolean(child && (child.exitCode !== null || child.signalCode !== null));
}

function signalProcessGroup(child, signal) {
  if (!child || !child.pid) return false;
  const target = process.platform === 'win32' ? child.pid : -child.pid;
  try {
    process.kill(target, signal);
    return true;
  } catch (error) {
    if (error && error.code === 'ESRCH') return false;
    throw error;
  }
}

async function waitForProcessClose(child, timeoutMs) {
  if (!child || processHasClosed(child)) return true;
  return new Promise((resolve) => {
    let timer = null;
    const onClose = () => {
      if (timer) clearTimeout(timer);
      resolve(true);
    };
    child.once('close', onClose);
    timer = setTimeout(() => {
      child.off('close', onClose);
      resolve(processHasClosed(child));
    }, Math.max(0, timeoutMs));
  });
}

function waitForHttp(url, timeoutMs = DEFAULT_HTTP_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const check = () => {
      const req = http.get(url, (res) => {
        res.resume();
        if (res.statusCode >= 200 && res.statusCode < 500) resolve();
        else retry();
      });
      req.on('error', retry);
      req.setTimeout(1000, () => {
        req.destroy();
        retry();
      });
    };
    const retry = () => {
      if (Date.now() > deadline) reject(new Error(`timed out waiting for ${url}`));
      else setTimeout(check, 500);
    };
    check();
  });
}

async function pageViewportVideoSource(page, env = process.env) {
  const display = env.DISPLAY || ':0';
  const metrics = await page.evaluate(() => ({
    screenX: Number(window.screenX || window.screenLeft || 0),
    screenY: Number(window.screenY || window.screenTop || 0),
    outerWidth: Number(window.outerWidth || window.innerWidth || 0),
    outerHeight: Number(window.outerHeight || window.innerHeight || 0),
    innerWidth: Number(window.innerWidth || 0),
    innerHeight: Number(window.innerHeight || 0),
  }));
  const horizontalChrome = Math.max(0, metrics.outerWidth - metrics.innerWidth);
  const verticalChrome = Math.max(0, metrics.outerHeight - metrics.innerHeight);
  const x = Math.max(0, Math.round(metrics.screenX + horizontalChrome / 2));
  const y = Math.max(0, Math.round(metrics.screenY + verticalChrome));
  return `${display}+${x},${y}`;
}

function browserViewportStabilizerScript() {
  const installStyle = () => {
    if (!document.documentElement) return;
    let style = document.getElementById('__runwave_capture_viewport_stabilizer__');
    if (!style) {
      style = document.createElement('style');
      style.id = '__runwave_capture_viewport_stabilizer__';
      style.textContent = 'html,body{overflow:hidden!important;}';
      document.documentElement.appendChild(style);
    }
    window.scrollTo(0, 0);
  };

  const scrollingKeys = new Set([
    'ArrowDown',
    'ArrowLeft',
    'ArrowRight',
    'ArrowUp',
    'End',
    'Home',
    'PageDown',
    'PageUp',
    ' ',
    'Space',
  ]);

  window.addEventListener('keydown', (event) => {
    const target = event.target;
    const tagName = target && target.tagName ? String(target.tagName).toUpperCase() : '';
    if (tagName === 'INPUT' || tagName === 'TEXTAREA' || tagName === 'SELECT' || target?.isContentEditable) return;
    if (scrollingKeys.has(event.key) || scrollingKeys.has(event.code)) event.preventDefault();
  }, true);

  window.addEventListener('scroll', () => window.scrollTo(0, 0), true);
  installStyle();
  document.addEventListener('DOMContentLoaded', installStyle, { once: true });
}

class BrowserSession {
  constructor(config, paths, profiler = null) {
    this.config = config;
    this.paths = paths;
    this.profiler = profiler;
    this.browser = null;
    this.context = null;
    this.page = null;
    this.launchUrl = targetUrl(config);
    this.launch = webLaunchConfig(config);
    this.process = null;
    this.processError = null;
    this.stateExpression = config.stateExpression || null;
    this.videoDir = null;
    this.audioDir = undefined;
    this.audioRecorder = null;
    this.playwrightRecorderActive = false;
    this.playwrightVideoPath = null;
    this.mousePosition = { x: 0, y: 0 };
    this.paused = false;
  }

  timeSync(event, fields, fn) {
    if (this.profiler) return this.profiler.timeSync(event, fields, fn);
    if (typeof fields === 'function') return fields();
    return fn();
  }

  async time(event, fields, fn) {
    if (this.profiler) return this.profiler.time(event, fields, fn);
    if (typeof fields === 'function') return fields();
    return fn();
  }

  async start() {
    this.timeSync('browser.start.ensure_run_dir', { dir: this.paths.runDir }, () => ensureDir(this.paths.runDir));
    const record = isRecording(this.config);
    const backend = recordingBackend(this.config);
    if (backend === 'playwright' && this.config.recordAudio) {
      throw new Error(`the ${backend} recording backend is video-only; use gstreamer when recordAudio is enabled`);
    }
    await this.time('browser.start.game_process', () => this.startGameProcess());
    if (record) {
      this.videoDir = this.timeSync('browser.start.ensure_video_dir', () => ensureDir(path.join(this.paths.runDir, 'video')));
    }

    const launchOptions = {
      headless: launchHeadless(this.config),
      args: chromiumLaunchArgs(this.config),
    };
    if (this.config.channel) launchOptions.channel = String(this.config.channel);
    if (this.config.executablePath) launchOptions.executablePath = String(this.config.executablePath);

    this.browser = await this.time('browser.start.chromium_launch', {
      headless: launchOptions.headless,
      channel: launchOptions.channel,
      executablePath: launchOptions.executablePath,
    }, () => chromium.launch(launchOptions));
    this.context = await this.time('browser.start.new_context', {
      viewport: this.config.viewport || { width: 1024, height: 620 },
      record,
    }, () =>
      this.browser.newContext({
        viewport: this.config.viewport || { width: 1024, height: 620 },
        deviceScaleFactor: Number(this.config.deviceScaleFactor ?? 1),
      })
    );
    if (this.config.pauseController) {
      await this.time('browser.start.install_pause_controller', () =>
        this.context.addInitScript({ content: browserPauseInitScript() })
      );
    }
    if (record) {
      await this.time('browser.start.capture_viewport_stabilizer', () =>
        this.context.addInitScript(browserViewportStabilizerScript)
      );
    }
    this.page = await this.time('browser.start.new_page', () => this.context.newPage());
    this.timeSync('browser.start.attach_console_logger', () => this.page.on('console', (msg) => {
      fs.appendFileSync(path.join(this.paths.runDir, 'browser-console.log'), `${msg.type()} ${msg.text()}\n`);
    }));
    await this.time('browser.start.initial_navigate', { url: this.launchUrl }, () =>
      this.navigate({ url: this.launchUrl, waitAfterLoad: this.config.waitAfterLoad })
    );
    if (backend === 'gstreamer') {
      const videoSource = this.config.videoSource || await this.time('browser.start.page_viewport_video_source', () =>
        pageViewportVideoSource(this.page)
      );
      this.audioRecorder = new AudioVideoRecorder(
        { ...this.config, videoSource },
        this.paths.runDir,
        this.profiler ? this.profiler.child('audio-video-recorder') : null
      );
      await this.time('browser.start.audio_video_recorder_start', () => this.audioRecorder.start());
    } else if (backend === 'playwright') {
      await this.time('browser.start.playwright_recorder_start', () => this.startPlaywrightRecording());
    }
  }

  async startPlaywrightRecording() {
    if (!this.page || !this.page.screencast || typeof this.page.screencast.start !== 'function') {
      throw new Error('the installed Playwright version does not support page.screencast');
    }
    const fileName = safeName(this.config.playwrightVideoFileName || '000-runwave-playwright');
    this.playwrightVideoPath = path.join(this.videoDir, `${fileName}.webm`);
    await this.page.screencast.start({
      path: this.playwrightVideoPath,
      size: videoSize(this.config),
    });
    this.playwrightRecorderActive = true;
    return this.playwrightVideoPath;
  }

  async stopPlaywrightRecording() {
    if (!this.playwrightRecorderActive) return null;
    this.playwrightRecorderActive = false;
    await this.page.screencast.stop();
    return fs.existsSync(this.playwrightVideoPath) ? this.playwrightVideoPath : null;
  }

  async startGameProcess() {
    if (!this.launch.command) return null;
    const stdout = fs.openSync(path.join(this.paths.runDir, 'web-game.stdout.log'), 'a');
    const stderr = fs.openSync(path.join(this.paths.runDir, 'web-game.stderr.log'), 'a');
    this.process = spawn(this.launch.command, this.launch.args, {
      cwd: this.launch.cwd,
      env: {
        ...process.env,
        ...(this.launch.port ? { PORT: String(this.launch.port) } : {}),
        ...(this.launch.env || {}),
      },
      detached: true,
      stdio: ['ignore', stdout, stderr],
    });
    const closeLogs = () => {
      try { fs.closeSync(stdout); } catch {}
      try { fs.closeSync(stderr); } catch {}
    };
    this.process.on('error', (error) => {
      this.processError = error;
      closeLogs();
    });
    this.process.on('close', closeLogs);
    await this.time('browser.start.wait_for_http', { url: this.launchUrl, timeoutMs: this.launch.httpTimeoutMs }, () =>
      waitForHttp(this.launchUrl, this.launch.httpTimeoutMs)
    );
    if (this.processError) throw new Error(`web game process failed to start: ${this.processError.message}`);
    return this.process;
  }

  async navigate(input) {
    const url = input.url || (input.file ? targetUrl(input) : this.launchUrl);
    const waitUntil = input.waitUntil || this.config.waitUntil || 'load';
    await this.time('browser.navigate.goto', { url, waitUntil }, () => this.page.goto(url, { waitUntil }));
    const waitAfterLoad = Number(input.waitAfterLoad ?? this.config.waitAfterLoad ?? 700);
    await this.time('browser.navigate.wait_after_load', { waitAfterLoad }, () => sleep(waitAfterLoad));
  }

  async screenshot(outputDir, name) {
    const fileName = `${safeName(name || `capture-${timestamp()}`)}.png`;
    const file = path.join(outputDir, fileName);
    await this.time('browser.screenshot.capture', { file, fullPage: Boolean(this.config.fullPageScreenshots) }, () =>
      this.page.screenshot({
        path: file,
        fullPage: Boolean(this.config.fullPageScreenshots),
        scale: 'css',
      })
    );
    if (this.config.gridScreenshots !== false) {
      this.timeSync('browser.screenshot.grid_overlay', { file }, () => drawGridOnScreenshot(file, this.config));
    }
    return file;
  }

  async keyDown(key) {
    await this.time('browser.keyboard.down', { key }, () => this.page.keyboard.down(key));
  }

  async keyUp(key) {
    await this.time('browser.keyboard.up', { key }, () => this.page.keyboard.up(key));
  }

  async click(click) {
    const holdMs = Math.max(0, Number(click.end ?? click.start) - Number(click.start ?? 0));
    const clickCount = Math.max(1, Math.round(Number(click.clickCount || 1)));
    const pointerLocked = await this.time('browser.mouse.pointer_lock_state', () =>
      this.page.evaluate(() => Boolean(document.pointerLockElement))
    );
    await this.time('browser.mouse.click', {
      x: click.x,
      y: click.y,
      button: click.button,
      clickCount,
      holdMs,
      pointerLocked,
    }, async () => {
      // In pointer-lock games the click coordinates are irrelevant. Moving to
      // them first makes Chromium emit a relative delta and its inverse while
      // recentering, which can violently disturb an FPS camera before firing.
      if (!pointerLocked) {
        await this.page.mouse.move(click.x, click.y);
        await this.page.evaluate(() => {
          const controller = window.__runwavePauseController;
          if (controller && controller.preparePointerLock) controller.preparePointerLock();
        });
      }
      for (let index = 0; index < clickCount; index += 1) {
        const eventClickCount = index + 1;
        await this.page.mouse.down({ button: click.button, clickCount: eventClickCount });
        if (holdMs > 0) await sleep(holdMs);
        await this.page.mouse.up({ button: click.button, clickCount: eventClickCount });
      }
    });
    if (!pointerLocked) this.mousePosition = { x: click.x, y: click.y };
  }

  async focusGame({ button = 'middle', x: requestedX, y: requestedY } = {}) {
    const alreadyLocked = await this.page.evaluate(() => Boolean(document.pointerLockElement));
    if (alreadyLocked) {
      return { pointerLocked: true, x: this.mousePosition.x, y: this.mousePosition.y, button };
    }
    const surface = await this.page.evaluate(() => {
      const canvases = Array.from(document.querySelectorAll('canvas'));
      const canvas = canvases.sort((left, right) => {
        const leftRect = left.getBoundingClientRect();
        const rightRect = right.getBoundingClientRect();
        return rightRect.width * rightRect.height - leftRect.width * leftRect.height;
      })[0];
      if (!canvas) return null;
      const rect = canvas.getBoundingClientRect();
      return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
    });
    if (!surface) throw new Error('focus_game requires a visible canvas');

    let x = Number.isFinite(Number(requestedX)) ? Number(requestedX) : this.mousePosition.x;
    let y = Number.isFinite(Number(requestedY)) ? Number(requestedY) : this.mousePosition.y;
    if (x < surface.left || x >= surface.right || y < surface.top || y >= surface.bottom) {
      x = Math.round((surface.left + surface.right) / 2);
      y = Math.round((surface.top + surface.bottom) / 2);
    }
    if (x !== this.mousePosition.x || y !== this.mousePosition.y) {
      await this.page.mouse.move(x, y);
      this.mousePosition = { x, y };
    }
    await this.page.evaluate(() => {
      const controller = window.__runwavePauseController;
      if (!controller || !controller.preparePointerLock) {
        throw new Error('pointer lock controller is unavailable');
      }
      controller.preparePointerLock();
    });
    await this.page.mouse.down({ button });
    await this.page.mouse.up({ button });
    await sleep(75);
    const pointerLocked = await this.page.evaluate(() => Boolean(document.pointerLockElement));
    return { pointerLocked, x, y, button };
  }

  async moveCursor(move) {
    await this.time('browser.mouse.cursor_move', {
      x: move.to.x,
      y: move.to.y,
      steps: move.steps,
    }, () => this.page.mouse.move(move.to.x, move.to.y, { steps: move.steps }));
    this.mousePosition = { x: move.to.x, y: move.to.y };
  }

  async drag(drag) {
    if (drag.mode === 'html5') {
      await this.time('browser.drag.html5', {
        fromX: drag.from.x,
        fromY: drag.from.y,
        toX: drag.to.x,
        toY: drag.to.y,
      }, () =>
        this.page.evaluate(({ from, to }) => {
          const elementAt = (point) => document.elementFromPoint(point.x, point.y) || document.body;
          const source = elementAt(from);
          const target = elementAt(to);
          const dataTransfer = new DataTransfer();
          const eventOptions = (point) => ({
            bubbles: true,
            cancelable: true,
            composed: true,
            clientX: point.x,
            clientY: point.y,
            screenX: point.x,
            screenY: point.y,
            dataTransfer,
          });

          source.dispatchEvent(new MouseEvent('mousedown', eventOptions(from)));
          source.dispatchEvent(new DragEvent('dragstart', eventOptions(from)));
          target.dispatchEvent(new DragEvent('dragenter', eventOptions(to)));
          target.dispatchEvent(new DragEvent('dragover', eventOptions(to)));
          target.dispatchEvent(new DragEvent('drop', eventOptions(to)));
          source.dispatchEvent(new DragEvent('dragend', eventOptions(to)));
          target.dispatchEvent(new MouseEvent('mouseup', eventOptions(to)));
        }, { from: drag.from, to: drag.to })
      );
    } else {
      await this.time('browser.mouse.drag', {
        fromX: drag.from.x,
        fromY: drag.from.y,
        toX: drag.to.x,
        toY: drag.to.y,
        button: drag.button,
        steps: drag.steps,
      }, async () => {
        await this.page.mouse.move(drag.from.x, drag.from.y);
        await this.page.mouse.down({ button: drag.button });
        await this.page.mouse.move(drag.to.x, drag.to.y, { steps: drag.steps });
        await this.page.mouse.up({ button: drag.button });
      });
    }
    this.mousePosition = { x: drag.to.x, y: drag.to.y };
  }

  async moveView(move) {
    const viewport = this.page.viewportSize() || this.config.viewport || { width: 1024, height: 620 };
    const pointerLocked = await this.time('browser.mouse.pointer_lock_state', () =>
      this.page.evaluate(() => Boolean(document.pointerLockElement))
    );
    const rawX = this.mousePosition.x + move.dx;
    const rawY = this.mousePosition.y + move.dy;
    if (pointerLocked) {
      // Chromium produces a trusted requested delta and then a trusted inverse
      // recenter event. The page-side controller suppresses that inverse, so
      // games which reject synthetic MouseEvents still receive real movement.
      await this.time('browser.mouse.dispatch_locked_view_move', {
        dx: move.dx,
        dy: move.dy,
        requestedSteps: move.steps,
      }, async () => {
        const movementX = Math.round(Number(move.dx));
        const movementY = Math.round(Number(move.dy));
        const armed = await this.page.evaluate(({ x, y }) => {
          const controller = window.__runwavePauseController;
          return Boolean(controller && controller.preparePointerMove(x, y));
        }, { x: movementX, y: movementY });
        if (!armed) throw new Error('trusted pointer movement controller is unavailable');
        await this.page.mouse.move(movementX, movementY);
        // Unity and other frame-polled games consume mouse deltas during their
        // next animation update. On a software renderer that frame can take
        // much longer than the requested action duration, so wait for the
        // actual frame instead of pausing on a wall-clock guess.
        await this.page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve())));
      });
      return;
    }

    const x = Math.max(0, Math.min(viewport.width - 1, rawX));
    const y = Math.max(0, Math.min(viewport.height - 1, rawY));
    await this.time('browser.mouse.move', { x, y, dx: move.dx, dy: move.dy }, () =>
      this.page.mouse.move(x, y, { steps: move.steps })
    );
    this.mousePosition = { x, y };
  }

  async state(expression) {
    return this.time('browser.state.read', { customExpression: Boolean(expression || this.stateExpression) }, () =>
      readPageState(this.page, expression || this.stateExpression)
    );
  }

  // The MCP agent receives a frame and then may spend seconds reasoning. The
  // page-side controller stops the game clock and input at the renderer, while
  // leaving screenshots and state reads available during the pause.
  async pause() {
    if (!this.page) return false;
    const changed = await this.page.evaluate(() => {
      const controller = window.__runwavePauseController;
      if (!controller) throw new Error('runwave pause controller is unavailable');
      return controller.pause();
    });
    this.paused = true;
    return changed;
  }

  async resume() {
    if (!this.page) return false;
    const changed = await this.page.evaluate(() => {
      const controller = window.__runwavePauseController;
      if (!controller) throw new Error('runwave pause controller is unavailable');
      return controller.resume();
    });
    this.paused = false;
    return changed;
  }

  async isPaused() {
    if (!this.page) return Boolean(this.paused);
    return this.page.evaluate(() => Boolean(
      window.__runwavePauseController && window.__runwavePauseController.isPaused()
    ));
  }

  async stopGameProcess() {
    if (!this.process || processHasClosed(this.process)) return;
    await this.time('browser.close.terminate_process', async () => {
      signalProcessGroup(this.process, 'SIGTERM');
      if (!(await waitForProcessClose(this.process, DEFAULT_PROCESS_STOP_WAIT_MS))) {
        signalProcessGroup(this.process, 'SIGKILL');
        await waitForProcessClose(this.process, DEFAULT_PROCESS_KILL_WAIT_MS);
      }
    });
  }

  async close() {
    let videoPath = null;
    let audioVideoPath = null;
    let closeError = null;
    try {
      if (this.playwrightRecorderActive) {
        videoPath = await this.time('browser.close.playwright_recorder_stop', () => this.stopPlaywrightRecording());
      }
      if (this.audioRecorder) {
        audioVideoPath = await this.time('browser.close.audio_video_stop', () => this.audioRecorder.stop());
        videoPath = audioVideoPath;
      }
      if (this.context) await this.time('browser.close.context_close', () => this.context.close());
      if (this.browser) await this.time('browser.close.browser_close', () => this.browser.close());
    } catch (error) {
      closeError = error;
    }
    try {
      await this.stopGameProcess();
    } catch (error) {
      if (!closeError) closeError = error;
    }
    this.paused = false;
    if (closeError) throw closeError;
    return {
      video: videoPath,
      audioVideo: audioVideoPath || undefined,
    };
  }
}

module.exports = {
  BrowserSession,
  browserViewportStabilizerScript,
  chromiumArgs,
  chromiumLaunchArgs,
  launchHeadless,
  pageViewportVideoSource,
  recordingBackend,
  usesGstreamerRecording,
  videoSize,
  webLaunchConfig,
};
