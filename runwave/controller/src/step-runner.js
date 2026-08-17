const path = require('path');
const { safeName, writeJson } = require('./file-utils');
const { executeTimeline } = require('./step-executor');
const { normalizeStep } = require('./step-normalizer');
const { buildStepTimeline } = require('./step-timeline');

function resultFileName(stepIndex, actionName) {
  return `${String(stepIndex).padStart(3, '0')}-${safeName(actionName)}`;
}

function summarizeActions(step) {
  return [
    ...step.keyActions.map(({ start, end, keyName, key }) => ({ type: 'key', start, end, key: keyName, resolvedKey: key })),
    ...step.clicks.map(({ type, start, end, x, y, button, clickCount, cells }) => ({
      type,
      start,
      end,
      x,
      y,
      button,
      clickCount,
      ...(cells ? { cells } : {}),
    })),
    ...step.drags.map(({ type, start, end, from, to, button, mode, steps }) => ({ type, start, end, from, to, button, mode, steps })),
    ...step.cursorMoves.map(({ type, start, end, to, steps }) => ({ type, start, end, to, steps })),
    ...step.viewMoves.map(({ type, start, end, dx, dy, steps }) => ({ type, start, end, dx, dy, steps })),
  ].sort((left, right) => (left.start ?? 0) - (right.start ?? 0));
}

async function runStep({ input, config, browser, outputDir, nextStepIndex, actionName, beforeEndCapture, profiler }) {
  const timeSync = (event, fields, fn) => (profiler ? profiler.timeSync(event, fields, fn) : fn());
  const time = (event, fields, fn) => (profiler ? profiler.time(event, fields, fn) : fn());

  const step = timeSync('step.normalize', { actionName, nextStepIndex }, () => normalizeStep(input, config, nextStepIndex));
  const prefix = timeSync('step.result_prefix', { actionName, stepIndex: step.index }, () => resultFileName(step.index, actionName));
  const startState = await time('step.start_state', { actionName, stepIndex: step.index }, () => browser.state(input.stateExpression));
  const events = timeSync('step.build_timeline', { actionName, stepIndex: step.index }, () => buildStepTimeline(step));
  if (profiler) {
    profiler.mark('step.timeline_built', {
      actionName,
      stepIndex: step.index,
      duration: step.duration,
      eventCount: events.length,
      actionCount: step.keyActions.length + step.clicks.length + step.drags.length + step.cursorMoves.length + step.viewMoves.length,
      keyActionCount: step.keyActions.length,
      clickCount: step.clicks.length,
      dragCount: step.drags.length,
      cursorMoveCount: step.cursorMoves.length,
      viewMoveCount: step.viewMoves.length,
      captureCount: events.filter((event) => event.type === 'capture').length,
    });
  }
  const captures = await time('step.execute_timeline', { actionName, stepIndex: step.index, eventCount: events.length }, () =>
    executeTimeline({
      browser,
      events,
      duration: step.duration,
      outputDir,
      prefix,
      stateExpression: input.stateExpression,
      beforeEndCapture,
      profiler: profiler ? profiler.child('step-executor') : null,
    })
  );

  const endState = await time('step.end_state', { actionName, stepIndex: step.index }, () => browser.state(input.stateExpression));
  const result = {
    action: 'step',
    ok: true,
    step: step.index,
    action_name: actionName,
    name: step.name,
    duration: step.duration,
    startState,
    endState,
    captures,
    actions: summarizeActions(step),
    clicks: step.clicks,
    drags: step.drags,
    cursorMoves: step.cursorMoves,
    viewMoves: step.viewMoves,
  };
  result.resultPath = path.join(outputDir, `${prefix}.json`);
  timeSync('step.write_result_json', { actionName, resultPath: result.resultPath }, () => writeJson(result.resultPath, result));
  return result;
}

module.exports = {
  runStep,
};
