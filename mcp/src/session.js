'use strict';

const fs = require('fs');
const path = require('path');
const { createSession } = require('../../runwave/controller/src/session-factory');
const { OutputWriter } = require('../../runwave/controller/src/output-writer');
const { ensureDir, timestamp } = require('../../runwave/controller/src/file-utils');
const { buildSessionConfig } = require('./config');

const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

class Session {
  constructor({ id, workspace, options }) {
    this.id = id;
    this.config = buildSessionConfig(options);
    this.paths = {
      runDir: path.join(workspace, 'sessions', id),
      outputRoot: path.join(workspace, 'sessions', id, 'output'),
      playthrough: path.join(workspace, 'sessions', id, 'playthrough.json'),
    };
    ensureDir(this.paths.runDir);
    this.output = new OutputWriter(this.paths.outputRoot);
    this.browser = createSession(this.config, this.paths, null);
    this.stepIndex = 0;
    this.turn = 0;
    this.journal = [];
    this.playthrough = {
      version: 1,
      session_id: id,
      attempt: 1,
      created_at: new Date().toISOString(),
      launch_url: null,
      viewport: { ...this.config.viewport },
      total_duration_ms: 0,
      steps: [],
    };
    this.replays = [];
    this.closed = false;
    this.pauseMode = null;
    this.manualPauseRevision = 0;
    this.createdAt = Date.now();
    this.idleTimeoutMs = Number(options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS);
    this.idleTimer = null;
    // Serializes work per session. One Playwright page, one shared step
    // counter: concurrent steps would interleave keypresses and collide on
    // output filenames. Subagents sharing a session_id hit this too.
    this.queue = Promise.resolve();
  }

  async start() {
    await this.browser.start();
    this.playthrough.launch_url = this.browser.launchUrl;
    this.persistPlaythrough();
    this.touch();
    return this;
  }

  // Every tool call runs through here, so ordering is guaranteed even when
  // several agents hold the same session id.
  run(fn) {
    const result = this.queue.then(() => {
      if (this.closed) throw new Error(`session ${this.id} has ended`);
      return fn();
    });
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  // An agent that forgets to call end_game would otherwise leak Chromium for
  // the lifetime of the server.
  touch() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (!this.idleTimeoutMs || this.closed) return;
    this.idleTimer = setTimeout(() => {
      this.close().catch(() => {});
    }, this.idleTimeoutMs);
    if (typeof this.idleTimer.unref === 'function') this.idleTimer.unref();
  }

  // Append-only text log. This is how an agent re-orients after its context is
  // compacted, without paying to replay screenshots.
  note(entry) {
    this.journal.push({ turn: this.turn, at: Date.now() - this.createdAt, ...entry });
    return this.journal[this.journal.length - 1];
  }

  nextStepIndex() {
    this.stepIndex += 1;
    this.turn += 1;
    return this.stepIndex;
  }

  actionDir(name) {
    return this.output.actionDir(name);
  }

  // The live session writes screenshots and per-step result files. This
  // compact, atomically replaced file is the reproducible input program used
  // to render a clean playthrough in a separate browser later.
  persistPlaythrough() {
    const temporaryPath = `${this.paths.playthrough}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temporaryPath, JSON.stringify(this.playthrough, null, 2));
    fs.renameSync(temporaryPath, this.paths.playthrough);
    return this.paths.playthrough;
  }

  appendPlaythroughStep({ duration, actions, note }) {
    const entry = {
      index: this.playthrough.steps.length + 1,
      duration_ms: Number(duration),
      actions: actions.map(canonicalReplayAction),
      ...(note ? { note: String(note) } : {}),
    };
    this.playthrough.steps.push(entry);
    this.playthrough.total_duration_ms += entry.duration_ms;
    this.persistPlaythrough();
    return entry;
  }

  resetPlaythrough() {
    this.playthrough = {
      ...this.playthrough,
      attempt: this.playthrough.attempt + 1,
      created_at: new Date().toISOString(),
      total_duration_ms: 0,
      steps: [],
    };
    return this.persistPlaythrough();
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    await this.browser.close();
  }

  // A manual pause is an override: normal gameplay calls must not silently
  // resume it. Automatic pauses are released by the next act/reset call.
  async pause({ mode = 'automatic', reason } = {}) {
    if (this.closed) throw new Error(`session ${this.id} has ended`);
    if (this.pauseMode === 'manual' && mode !== 'manual') return this.pauseMode;
    if (this.pauseMode === mode) return this.pauseMode;
    if (mode === 'manual') {
      // Publish the override before awaiting the renderer so a concurrently
      // starting act/reset cannot resume past it.
      const previousMode = this.pauseMode;
      this.manualPauseRevision += 1;
      this.pauseMode = 'manual';
      try {
        await this.browser.pause();
      } catch (error) {
        if (this.pauseMode === 'manual') this.pauseMode = previousMode;
        throw error;
      }
    } else {
      await this.browser.pause();
      if (this.pauseMode === 'manual') return this.pauseMode;
      this.pauseMode = mode;
    }
    if (mode === 'manual') this.note({ event: 'pause', mode, ...(reason ? { reason } : {}) });
    this.touch();
    return this.pauseMode;
  }

  async resume({ force = false, reason } = {}) {
    if (this.closed) throw new Error(`session ${this.id} has ended`);
    if (this.pauseMode === 'manual' && !force) {
      throw new Error('game is manually paused; call resume_game before sending gameplay input');
    }
    if (this.pauseMode === null) return false;
    const previousMode = this.pauseMode;
    this.pauseMode = null;
    const manualPauseRevision = this.manualPauseRevision;
    await this.browser.resume();
    if (manualPauseRevision !== this.manualPauseRevision || this.pauseMode === 'manual') {
      await this.browser.pause();
      this.pauseMode = 'manual';
      throw new Error('game was manually paused while resume was in progress');
    }
    if (previousMode === 'manual' || force) {
      this.note({ event: 'resume', ...(reason ? { reason } : {}) });
    }
    this.touch();
    return true;
  }

  async prepareForGameplay(reason = 'act') {
    if (this.pauseMode === 'manual') {
      throw new Error('game is manually paused; call resume_game before sending gameplay input');
    }
    if (this.pauseMode === 'automatic') await this.resume({ reason });
  }

  async pauseForAgent(reason = 'awaiting_agent') {
    if (this.pauseMode === 'manual') return this.pauseMode;
    return this.pause({ mode: 'automatic', reason });
  }

  summary() {
    return {
      session_id: this.id,
      url: this.browser.launchUrl,
      viewport: this.config.viewport,
      turns: this.turn,
      steps: this.stepIndex,
      paused: this.pauseMode !== null,
      pause_mode: this.pauseMode,
      uptime_ms: Date.now() - this.createdAt,
      run_dir: this.paths.runDir,
      playthrough_path: this.paths.playthrough,
      playthrough_steps: this.playthrough.steps.length,
      replay_count: this.replays.length,
      closed: this.closed,
    };
  }
}

function canonicalPoint(point) {
  return { x: Number(point.x), y: Number(point.y) };
}

function canonicalReplayAction(action) {
  const common = {
    type: action.type,
    start: Number(action.start),
    end: Number(action.end),
  };
  if (action.type === 'key') {
    return { ...common, key: action.resolvedKey || action.key };
  }
  if (action.type === 'click') {
    return {
      ...common,
      x: Number(action.x),
      y: Number(action.y),
      button: action.button,
      clickCount: Number(action.clickCount),
    };
  }
  if (action.type === 'drag') {
    return {
      ...common,
      from: canonicalPoint(action.from),
      to: canonicalPoint(action.to),
      button: action.button,
      mode: action.mode,
      steps: Number(action.steps),
    };
  }
  if (action.type === 'cursor_move') {
    return { ...common, to: canonicalPoint(action.to), steps: Number(action.steps) };
  }
  if (action.type === 'view_move') {
    return {
      ...common,
      dx: Number(action.dx),
      dy: Number(action.dy),
      steps: Number(action.steps),
    };
  }
  if (action.type === 'focus_game') {
    return {
      ...common,
      x: Number(action.x),
      y: Number(action.y),
      button: action.button,
    };
  }
  throw new Error(`cannot persist unsupported replay action: ${action.type}`);
}

function newSessionId() {
  return `game-${timestamp()}`;
}

module.exports = {
  DEFAULT_IDLE_TIMEOUT_MS,
  Session,
  canonicalReplayAction,
  newSessionId,
};
