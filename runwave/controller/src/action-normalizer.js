'use strict';

const {
  cellsFromObject,
  clickBurstTimes,
  gridSafeSampleRatio,
  gridSampleMode,
  markGridFromConfig,
  randomPointInCells,
  viewportFromConfig,
} = require('../../protocol/src/mark-grid');
const {
  ACTION_FIELDS,
  CELL_FIELDS,
  DEFAULT_IMPLICIT_END_MS,
  DEFAULT_MULTI_CLICK_INTERVAL_MS,
  MAX_ACTION_SPAN_MS,
  POINT_FIELDS,
} = require('../../protocol/src/action');

function assertAllowedFields(object, allowedFields, label) {
  if (!object || typeof object !== 'object' || Array.isArray(object)) return;
  for (const field of Object.keys(object)) {
    if (!allowedFields.has(field)) {
      throw new Error(`${label} contains unknown field "${field}"`);
    }
  }
}

function readNumber(value, fallback = null) {
  return Number(value ?? fallback);
}

function finiteNumber(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp(number, min, max) {
  return Math.max(min, Math.min(max, number));
}

function actionType(action) {
  return String((action && action.type) || '').trim().toLowerCase();
}

function assertActionFields(action) {
  const type = actionType(action);
  const allowed = ACTION_FIELDS[type];
  if (!allowed) throw new Error(`unknown sequence action type: ${type || '(missing)'}`);
  assertAllowedFields(action, allowed, `${type} action`);
  return type;
}

function asActionArray(actions) {
  if (actions === undefined || actions === null) return [];
  if (!Array.isArray(actions)) throw new Error('sequence actions must be an array');
  return actions;
}

function splitKeyChord(key) {
  return String(key)
    .split('+')
    .map((part) => String(part || '').trim())
    .filter(Boolean);
}

function actionEnd(action) {
  const end = finiteNumber(action.end, null);
  if (end !== null) return end;
  const start = finiteNumber(action.start, 0);
  return start + DEFAULT_IMPLICIT_END_MS;
}

function implicitEnd(action, type, start) {
  if (type === 'multi_click') {
    const count = Math.max(1, Math.round(finiteNumber(action.count, 10)));
    const intervalMs = finiteNumber(action.intervalMs, DEFAULT_MULTI_CLICK_INTERVAL_MS);
    if (Number.isFinite(intervalMs) && intervalMs > 0) {
      return start + (count - 1) * intervalMs + DEFAULT_IMPLICIT_END_MS;
    }
  }
  return start + DEFAULT_IMPLICIT_END_MS;
}

function invalidTiming(message, action, options) {
  if (options.strict) throw new Error(`${message}: ${JSON.stringify(action)}`);
  return null;
}

function normalizeTiming(action, type, duration, options) {
  const start = finiteNumber(action.start, null);
  if (!Number.isFinite(start) || start < 0) {
    return invalidTiming(`invalid ${type} start time`, action, options);
  }

  const explicitEnd = finiteNumber(action.end, null);
  let end = explicitEnd === null ? implicitEnd(action, type, start) : explicitEnd;
  if (!Number.isFinite(end) || end <= start) {
    return invalidTiming(`invalid ${type} interval`, action, options);
  }

  const configuredMaxSpan = Number(options.config?.maxActionSpanMs?.[type]);
  const maxSpan = Number.isFinite(configuredMaxSpan)
    ? configuredMaxSpan
    : MAX_ACTION_SPAN_MS[type];
  if (Number.isFinite(maxSpan) && end - start > maxSpan) {
    return invalidTiming(`${type} action duration exceeds ${maxSpan}ms`, action, options);
  }

  if (options.strict && Number.isFinite(duration) && end > duration) {
    return invalidTiming(`${type} action ends after sequence duration`, action, options);
  }

  const optionMaxDurationMs = Number(options.maxDurationMs);
  const maxDurationMs = Number.isFinite(optionMaxDurationMs)
    ? optionMaxDurationMs
    : Number.isFinite(duration)
      ? duration
      : Number.MAX_SAFE_INTEGER;
  const normalizedStart = options.strict ? start : clamp(start, 0, maxDurationMs);
  const normalizedEnd = options.strict ? end : clamp(end, normalizedStart, maxDurationMs);
  if (!Number.isFinite(normalizedEnd) || normalizedEnd <= normalizedStart) {
    return invalidTiming(`invalid ${type} normalized interval`, action, options);
  }

  return {
    start: options.roundTimes ? Math.round(normalizedStart) : normalizedStart,
    end: options.roundTimes ? Math.round(normalizedEnd) : normalizedEnd,
  };
}

function rawActionEnd(action) {
  if (!action || typeof action !== 'object') return null;
  const type = actionType(action);
  if (!ACTION_FIELDS[type]) return null;
  const start = finiteNumber(action.start, null);
  if (!Number.isFinite(start) || start < 0) return null;
  const end = finiteNumber(action.end, null);
  return end !== null ? end : implicitEnd(action, type, start);
}

function inferDurationFromRawActions(actions) {
  const times = [];
  for (const action of asActionArray(actions)) {
    const end = rawActionEnd(action);
    if (end !== null) times.push(end);
  }
  return times.length ? Math.max(...times) : 0;
}

function pickPointerFields(source) {
  const out = {};
  if (!source || typeof source !== 'object') return out;
  for (const field of ['x', 'y', ...CELL_FIELDS]) {
    if (Object.prototype.hasOwnProperty.call(source, field)) out[field] = source[field];
  }
  return out;
}

function normalizePoint(point, label, options) {
  assertAllowedFields(point, POINT_FIELDS, label);

  const grid = markGridFromConfig(options.config || {});
  const viewport = options.viewport || viewportFromConfig(options.config || {});
  const cells = cellsFromObject(point, grid, 4);
  if (cells.length) {
    try {
      return randomPointInCells(
        cells,
        viewport,
        grid,
        Math.random,
        gridSafeSampleRatio(options.config || {}),
        gridSampleMode(options.config || {})
      );
    } catch (error) {
      if (options.strict) throw new Error(`${label} ${error.message}`);
      return null;
    }
  }

  if (!point || typeof point !== 'object') {
    if (options.strict) throw new Error(`${label} requires numeric x and y: ${JSON.stringify(point)}`);
    return null;
  }

  let x = finiteNumber(point.x, null);
  let y = finiteNumber(point.y, null);
  if (x === null || y === null) {
    if (options.strict) throw new Error(`${label} requires numeric x and y: ${JSON.stringify(point)}`);
    return null;
  }

  if (options.scaleUnitPoints && viewport && x >= 0 && x <= 1 && y >= 0 && y <= 1) {
    x *= Number(viewport.width);
    y *= Number(viewport.height);
  }

  if (options.clampToViewport && viewport) {
    x = clamp(x, 0, Number(viewport.width) - 1);
    y = clamp(y, 0, Number(viewport.height) - 1);
  }

  return options.roundPoints ? { x: Math.round(x), y: Math.round(y) } : { x, y };
}

function normalizePointerActionPoint(action, label, options) {
  return normalizePoint(pickPointerFields(action), label, options);
}

function normalizeKeyAction(action, duration, options) {
  const keyName = action.key;
  const key = (options.aliases || {})[keyName] || keyName;
  if (!key) {
    if (options.strict) throw new Error(`key action is missing key: ${JSON.stringify(action)}`);
    return [];
  }

  const timing = normalizeTiming(action, 'key', duration, options);
  if (!timing) return [];

  const parts = options.splitKeyChords ? splitKeyChord(key) : [key];
  return parts.map((part) => {
    const normalized = {
      type: 'key',
      start: timing.start,
      end: timing.end,
    };
    if (options.includeKeyName) normalized.keyName = keyName;
    normalized.key = part;
    return normalized;
  });
}

function normalizeClickAction(click, duration, options, forceMulti = false) {
  const timing = normalizeTiming(click, forceMulti ? 'multi_click' : 'click', duration, options);
  if (!timing) return [];

  const point = normalizePointerActionPoint(click, 'click', options);
  if (!point) return [];

  const base = {
    type: 'click',
    start: timing.start,
    end: timing.end,
    x: point.x,
    y: point.y,
    button: click.button || 'left',
    clickCount: forceMulti ? 1 : Math.max(1, Math.round(finiteNumber(click.clickCount, 1))),
  };
  if (point.cells) {
    base.cells = point.cells;
  }

  if (!forceMulti) return [base];

  const times = clickBurstTimes(timing.start, timing.end, finiteNumber(click.count, 10), finiteNumber(click.intervalMs, DEFAULT_MULTI_CLICK_INTERVAL_MS));
  return times.map((clickStart) => {
    const nextPoint = normalizePointerActionPoint(click, 'click', options) || point;
    const clickEnd = Math.min(timing.end, clickStart + DEFAULT_IMPLICIT_END_MS);
    const action = {
      type: 'click',
      start: clickStart,
      end: options.roundTimes ? Math.round(clickEnd) : clickEnd,
      x: nextPoint.x,
      y: nextPoint.y,
      button: base.button,
      clickCount: 1,
    };
    if (nextPoint.cells) {
      action.cells = nextPoint.cells;
    }
    return action;
  });
}

function normalizeDragAction(drag, duration, options) {
  const timing = normalizeTiming(drag, 'drag', duration, options);
  if (!timing) return [];

  const from = normalizePoint(drag.from || { cells: drag.from_cells }, 'drag.from', options);
  const to = normalizePoint(drag.to || { cells: drag.to_cells }, 'drag.to', options);
  if (!from || !to) return [];

  return [{
    type: 'drag',
    start: timing.start,
    end: timing.end,
    from,
    to,
    button: drag.button || 'left',
    mode: drag.mode === 'html5' ? 'html5' : 'mouse',
    steps: clamp(Math.round(finiteNumber(drag.steps, 12)), 1, 80),
  }];
}

function normalizeCursorMoveAction(move, duration, options) {
  const timing = normalizeTiming(move, 'cursor_move', duration, options);
  if (!timing) return [];

  const point = normalizePoint(move.to || pickPointerFields(move), 'cursor_move.to', options);
  if (!point) return [];

  const action = {
    type: 'cursor_move',
    start: timing.start,
    end: timing.end,
    to: options.cursorCellsOnTarget ? point : { x: point.x, y: point.y },
    steps: clamp(Math.round(finiteNumber(move.steps, 8)), 1, 80),
  };
  if (!options.cursorCellsOnTarget && point.cells) action.cells = point.cells;
  return [action];
}

function normalizeViewMoveAction(move, duration, options) {
  const timing = normalizeTiming(move, 'view_move', duration, options);
  if (!timing) return [];
  const dx = options.strict ? readNumber(move.dx, 0) : finiteNumber(move.dx, 0);
  const dy = options.strict ? readNumber(move.dy, 0) : finiteNumber(move.dy, 0);

  if (!Number.isFinite(dx) || !Number.isFinite(dy) || (dx === 0 && dy === 0)) {
    if (options.strict) throw new Error(`view move action requires numeric dx or dy: ${JSON.stringify(move)}`);
    return [];
  }

  return [{
    type: 'view_move',
    start: timing.start,
    end: timing.end,
    dx: options.roundPoints ? Math.round(dx) : dx,
    dy: options.roundPoints ? Math.round(dy) : dy,
    steps: clamp(Math.round(finiteNumber(move.steps, 12)), 1, 80),
  }];
}

function normalizeAction(action, duration, options) {
  if (!action || typeof action !== 'object' || Array.isArray(action)) {
    if (options.strict) throw new Error(`invalid sequence action: ${JSON.stringify(action)}`);
    return [];
  }

  const type = assertActionFields(action);
  if (type === 'key') return normalizeKeyAction(action, duration, options);
  if (type === 'click') return normalizeClickAction(action, duration, options);
  if (type === 'multi_click') return normalizeClickAction(action, duration, options, true);
  if (type === 'drag') return normalizeDragAction(action, duration, options);
  if (type === 'cursor_move') return normalizeCursorMoveAction(action, duration, options);
  if (type === 'view_move') return normalizeViewMoveAction(action, duration, options);
  return [];
}

function normalizeActions(actions, duration, options) {
  const normalized = [];
  for (const action of asActionArray(actions)) {
    normalized.push(...normalizeAction(action, duration, options));
  }
  return normalized;
}

module.exports = {
  assertAllowedFields,
  actionEnd,
  asActionArray,
  inferDurationFromRawActions,
  normalizeActions,
  readNumber,
};
