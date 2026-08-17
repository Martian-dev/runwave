const { sleep } = require('./file-utils');

function elapsedSince(startedAt) {
  return Date.now() - startedAt;
}

async function waitUntil(startedAt, offsetMs, profiler, fields = {}) {
  const wait = offsetMs - elapsedSince(startedAt);
  if (wait > 0) {
    if (profiler) await profiler.time('timeline.wait', { ...fields, offsetMs, waitMs: wait }, () => sleep(wait));
    else await sleep(wait);
  } else if (profiler) {
    profiler.mark('timeline.wait.skipped', { ...fields, offsetMs, waitMs: wait });
  }
}

async function captureAt({ browser, outputDir, prefix, stateExpression, at, profiler }) {
  return {
    at,
    path: profiler
      ? await profiler.time('timeline.capture.screenshot', { at }, () =>
          browser.screenshot(outputDir, `${prefix}-${String(at).padStart(5, '0')}ms`)
        )
      : await browser.screenshot(outputDir, `${prefix}-${String(at).padStart(5, '0')}ms`),
    state: profiler
      ? await profiler.time('timeline.capture.state', { at }, () => browser.state(stateExpression))
      : await browser.state(stateExpression),
  };
}

async function releasePressedKeys(browser, pressed, profiler) {
  for (const key of pressed) {
    if (profiler) await profiler.time('timeline.cleanup.key_up', { key }, () => browser.keyUp(key));
    else await browser.keyUp(key);
  }
}

async function executeTimeline({ browser, events, duration, outputDir, prefix, stateExpression, beforeEndCapture, profiler }) {
  const pressed = new Set();
  const captures = [];
  const startedAt = Date.now();

  try {
    for (let index = 0; index < events.length; index += 1) {
      const event = events[index];
      const fields = { eventIndex: index, type: event.type, at: event.at };
      if (profiler) profiler.mark('timeline.event.ready', fields);
      await waitUntil(startedAt, event.at, profiler, fields);

      if (event.type === 'down') {
        if (profiler) await profiler.time('timeline.event.key_down', { ...fields, key: event.action.key }, () => browser.keyDown(event.action.key));
        else await browser.keyDown(event.action.key);
        pressed.add(event.action.key);
      } else if (event.type === 'up') {
        if (profiler) await profiler.time('timeline.event.key_up', { ...fields, key: event.action.key }, () => browser.keyUp(event.action.key));
        else await browser.keyUp(event.action.key);
        pressed.delete(event.action.key);
      } else if (event.type === 'click') {
        if (profiler) {
          await profiler.time('timeline.event.click', { ...fields, x: event.click.x, y: event.click.y }, () => browser.click(event.click));
        } else {
          await browser.click(event.click);
        }
      } else if (event.type === 'cursor_move') {
        if (profiler) {
          await profiler.time('timeline.event.cursor_move', {
            ...fields,
            x: event.cursorMove.to.x,
            y: event.cursorMove.to.y,
            steps: event.cursorMove.steps,
          }, () => browser.moveCursor(event.cursorMove));
        } else {
          await browser.moveCursor(event.cursorMove);
        }
      } else if (event.type === 'drag') {
        if (profiler) {
          await profiler.time('timeline.event.drag', {
            ...fields,
            fromX: event.drag.from.x,
            fromY: event.drag.from.y,
            toX: event.drag.to.x,
            toY: event.drag.to.y,
            mode: event.drag.mode,
          }, () => browser.drag(event.drag));
        } else {
          await browser.drag(event.drag);
        }
      } else if (event.type === 'view_move') {
        if (profiler) {
          await profiler.time('timeline.event.view_move', {
            ...fields,
            dx: event.viewMove.dx,
            dy: event.viewMove.dy,
            steps: event.viewMove.steps,
          }, () => browser.moveView(event.viewMove));
        } else {
          await browser.moveView(event.viewMove);
        }
      } else if (event.type === 'capture') {
        if (beforeEndCapture && event.at === duration) await beforeEndCapture();
        captures.push(await (profiler
          ? profiler.time('timeline.event.capture', fields, () =>
              captureAt({ browser, outputDir, prefix, stateExpression, at: event.at, profiler })
            )
          : captureAt({ browser, outputDir, prefix, stateExpression, at: event.at })));
      }
      if (profiler) profiler.mark('timeline.event.done', { ...fields, elapsedMs: elapsedSince(startedAt) });
    }

    await waitUntil(startedAt, duration, profiler, { type: 'duration_end' });
  } finally {
    if (profiler) profiler.mark('timeline.cleanup.start', { pressedKeyCount: pressed.size });
    await releasePressedKeys(browser, pressed, profiler);
    if (profiler) profiler.mark('timeline.cleanup.end');
  }

  if (profiler) profiler.mark('timeline.complete', { duration, elapsedMs: elapsedSince(startedAt), captureCount: captures.length });
  return captures;
}

module.exports = {
  executeTimeline,
};
