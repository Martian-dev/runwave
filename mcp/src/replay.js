'use strict';

const path = require('path');
const { createSession } = require('../../runwave/controller/src/session-factory');
const { ensureDir, sleep, timestamp, writeJson } = require('../../runwave/controller/src/file-utils');
const { executeTimeline } = require('../../runwave/controller/src/step-executor');
const { normalizeStep } = require('../../runwave/controller/src/step-normalizer');
const { buildStepTimeline } = require('../../runwave/controller/src/step-timeline');

function replayConfigFor(session) {
  return {
    kind: 'web',
    url: session.browser.launchUrl,
    viewport: { ...session.config.viewport },
    videoSize: { ...session.config.viewport },
    deviceScaleFactor: Number(session.config.deviceScaleFactor ?? 1),
    record: true,
    recordAudio: false,
    recordingBackend: 'playwright',
    playwrightVideoFileName: 'playthrough',
    headless: true,
    gridScreenshots: false,
    fullPageScreenshots: false,
    autoCaptures: false,
    // The controller also supplies trusted pointer-lock movement filtering.
    // It remains unpaused unless the replay explicitly calls pause/resume.
    pauseController: true,
    // Replay must accept the same bounded input spans that were valid in the
    // live MCP session. Otherwise a successfully persisted held button can
    // fail only when the clean recording is rendered.
    maxActionSpanMs: { ...session.config.maxActionSpanMs },
    markGridSampleMode: session.config.markGridSampleMode,
    keyAliases: session.config.keyAliases,
    waitAfterLoad: Number(session.config.waitAfterLoad ?? 700),
  };
}

function replayStep(step, config, index) {
  return normalizeStep({
    action: 'step',
    action_name: `replay-${String(index).padStart(3, '0')}`,
    actions: step.actions,
    duration: step.duration_ms,
    captures: [],
    autoCaptures: false,
  }, config, index);
}

async function executeReplayStep(browser, step, config, index) {
  const focusAction = step.actions.find((action) => action.type === 'focus_game');
  if (focusAction) {
    if (step.actions.length !== 1) throw new Error('focus_game replay steps cannot contain other actions');
    const startedAt = Date.now();
    if (focusAction.start > 0) await sleep(focusAction.start);
    const focused = await browser.focusGame(focusAction);
    if (!focused.pointerLocked) throw new Error('replay could not reacquire pointer lock');
    const remaining = step.duration_ms - (Date.now() - startedAt);
    if (remaining > 0) await sleep(remaining);
    return;
  }
  const normalized = replayStep(step, config, index);
  const events = buildStepTimeline(normalized).filter((event) => event.type !== 'capture');
  await executeTimeline({
    browser,
    events,
    duration: normalized.duration,
    outputDir: null,
    prefix: `replay-${String(index).padStart(3, '0')}`,
    stateExpression: null,
    beforeEndCapture: null,
    profiler: null,
  });
}

async function renderPlaythrough(session, { tailMs = 1000 } = {}) {
  const source = JSON.parse(JSON.stringify(session.playthrough));
  if (!source.steps.length) throw new Error('playthrough has no successful act steps to render');

  const replayId = `replay-${timestamp()}`;
  const runDir = ensureDir(path.join(session.paths.runDir, 'replays', replayId));
  const sourcePlaythrough = writeJson(path.join(runDir, 'playthrough.json'), source);
  const config = replayConfigFor(session);
  const browser = createSession(config, { runDir }, null);
  const startedAt = Date.now();
  let closeResult;

  try {
    await browser.start();
    for (let index = 0; index < source.steps.length; index += 1) {
      await executeReplayStep(browser, source.steps[index], config, index + 1);
    }
    if (tailMs > 0) await sleep(tailMs);
    closeResult = await browser.close();
  } catch (error) {
    await browser.close().catch(() => {});
    throw error;
  }

  if (!closeResult.video) throw new Error('Playwright replay recorder did not produce a video');
  const result = {
    version: 1,
    replay_id: replayId,
    source_playthrough: sourcePlaythrough,
    session_playthrough: session.paths.playthrough,
    source_attempt: source.attempt,
    recording_backend: 'playwright',
    step_count: source.steps.length,
    playthrough_duration_ms: source.total_duration_ms,
    tail_ms: tailMs,
    render_elapsed_ms: Date.now() - startedAt,
    video: closeResult.video,
    run_dir: runDir,
  };
  result.manifest = writeJson(path.join(runDir, 'replay.json'), result);
  session.replays.push(result);
  return result;
}

module.exports = {
  executeReplayStep,
  renderPlaythrough,
  replayConfigFor,
  replayStep,
};
