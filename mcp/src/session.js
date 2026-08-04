'use strict';

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
    };
    ensureDir(this.paths.runDir);
    this.output = new OutputWriter(this.paths.outputRoot);
    this.browser = createSession(this.config, this.paths, null);
    this.stepIndex = 0;
    this.turn = 0;
    this.journal = [];
    this.closed = false;
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

  async close() {
    if (this.closed) return;
    this.closed = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    await this.browser.close();
  }

  summary() {
    return {
      session_id: this.id,
      url: this.browser.launchUrl,
      viewport: this.config.viewport,
      turns: this.turn,
      steps: this.stepIndex,
      uptime_ms: Date.now() - this.createdAt,
      run_dir: this.paths.runDir,
      closed: this.closed,
    };
  }
}

function newSessionId() {
  return `game-${timestamp()}`;
}

module.exports = {
  DEFAULT_IDLE_TIMEOUT_MS,
  Session,
  newSessionId,
};
