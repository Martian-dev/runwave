'use strict';

const { z } = require('zod');
const { MAX_ACTION_SPAN_MS } = require('../../runwave/protocol/src/action');
const { DEFAULT_MARK_GRID } = require('../../runwave/protocol/src/mark-grid');

// Spans are pulled from the protocol rather than restated, so the tool contract
// cannot drift from what the executor actually enforces.
const span = (type) => (MAX_ACTION_SPAN_MS[type] ? ` Max ${MAX_ACTION_SPAN_MS[type]}ms.` : '');
const MCP_CLICK_MAX_MS = 2000;

const cell = z
  .object({
    overlay_row: z.number().int().min(0).describe(`Grid row, 0-${DEFAULT_MARK_GRID.rows - 1}.`),
    overlay_col: z.number().int().min(0).describe(`Grid column, 0-${DEFAULT_MARK_GRID.cols - 1}.`),
  })
  .describe('Grid cell target. Resolves to the centre of that cell.');

const point = z.object({
  x: z.number().optional().describe('Viewport pixel X. Preferred for precise targets.'),
  y: z.number().optional().describe('Viewport pixel Y.'),
  overlay_row: z.number().int().min(0).optional(),
  overlay_col: z.number().int().min(0).optional(),
});

const start = z.number().min(0).describe('Offset in ms from the start of the sequence.');

const keyAction = z.object({
  type: z.literal('key'),
  start,
  end: z.number().min(0).optional().describe('Release offset in ms. Omit for a ~50ms tap. Hold longer to move further.'),
  key: z.string().describe('Key name, e.g. ArrowRight, Space, KeyW, Enter. Aliases: left/right/up/down/jump.'),
});

const clickAction = z.object({
  type: z.literal('click'),
  start,
  end: z.number().min(0).optional().describe(`Release offset. Omit for a short click; use a longer span for a held game button such as sustained fire. Max ${MCP_CLICK_MAX_MS}ms.`),
  ...point.shape,
  button: z.enum(['left', 'middle', 'right']).optional(),
  clickCount: z.number().int().min(1).max(3).optional(),
});

const multiClickAction = z.object({
  type: z.literal('multi_click'),
  start,
  ...point.shape,
  cells: z.array(cell).max(4).optional().describe('Up to 4 candidate cells; clicks scatter across them.'),
  count: z.number().int().min(1).max(20).optional().describe('Number of clicks, default 10.'),
  intervalMs: z.number().min(20).max(500).optional(),
  button: z.enum(['left', 'middle', 'right']).optional(),
});

const dragAction = z.object({
  type: z.literal('drag'),
  start,
  end: z.number().min(0).optional().describe(`Drag duration.${span('drag')}`),
  from: point.describe('Drag origin.'),
  to: point.describe('Drag destination.'),
  button: z.enum(['left', 'middle', 'right']).optional(),
  mode: z.enum(['mouse', 'html5']).optional().describe('mouse for canvas games; html5 only for native draggable elements.'),
  steps: z.number().int().min(1).max(80).optional(),
});

const cursorMoveAction = z.object({
  type: z.literal('cursor_move'),
  start,
  end: z.number().min(0).optional().describe(`Move duration.${span('cursor_move')}`),
  ...point.shape,
  steps: z.number().int().min(1).max(80).optional(),
});

const viewMoveAction = z.object({
  type: z.literal('view_move'),
  start,
  end: z.number().min(0).optional(),
  dx: z.number().optional().describe('Relative pointer delta X. Positive is right.'),
  dy: z.number().optional().describe('Relative pointer delta Y. Positive is down.'),
  steps: z.number().int().min(1).max(80).optional(),
}).describe('Relative mouse movement for pointer-lock/FPS camera control. Start with a small calibration move because game sensitivity varies.');

const action = z
  .discriminatedUnion('type', [
    keyAction,
    clickAction,
    multiClickAction,
    dragAction,
    cursorMoveAction,
    viewMoveAction,
  ])
  .describe('One timed input. Offsets are ms from sequence start; actions may overlap.');

const region = z.object({
  x: z.number().min(0),
  y: z.number().min(0),
  width: z.number().min(1),
  height: z.number().min(1),
});

module.exports = {
  action,
  cell,
  clickAction,
  cursorMoveAction,
  dragAction,
  keyAction,
  multiClickAction,
  point,
  region,
  span,
  start,
  viewMoveAction,
};
