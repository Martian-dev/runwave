'use strict';

const { z } = require('zod');
const { runStep } = require('../../runwave/controller/src/step-runner');
const { action } = require('./schema');
const { captureFrame, frameResult } = require('./frame');
const { errorResult } = require('./result');
const { changedSince } = require('./diff');
const { applyGrid } = require('./frame');

// Returning several frames from one turn is occasionally worth it to see a
// trajectory, but each one costs context, so the count is capped.
const MAX_FRAMES_PER_TURN = 4;

const frameOptions = {
  full_res: z.boolean().optional().describe('Return the frame at full resolution. Costs ~4x the context of the default.'),
  grid: z.boolean().optional().describe('Overlay a labelled row/column grid to help aim. Adds a label margin around the image.'),
};

function registerPlayTools(server, registry) {
  server.registerTool('launch_game', {
    title: 'Launch game',
    description: 'Start a headless browser game session and return the first frame. Provide either url, or game_dir plus port for a directory containing start.sh.',
    inputSchema: {
      url: z.string().optional().describe('URL to open, e.g. http://127.0.0.1:3000/'),
      game_dir: z.string().optional().describe('Directory containing start.sh. Launched with the given port.'),
      port: z.number().int().positive().optional().describe('Port for game_dir, also used to build the URL.'),
      viewport: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }).optional(),
      session_id: z.string().optional().describe('Reuse a specific id. Generated when omitted.'),
      state_expression: z.string().optional().describe('JS expression evaluated in the page each turn for game-specific state.'),
      ...frameOptions,
    },
  }, async (args) => {
    try {
      if (!args.url && !args.game_dir) throw new Error('launch_game requires url or game_dir');
      const session = await registry.create({
        url: args.url,
        gameDir: args.game_dir,
        port: args.port,
        viewport: args.viewport,
        sessionId: args.session_id,
        stateExpression: args.state_expression,
      });
      return session.run(async () => {
        const { file, margin } = await captureFrame(session, { name: 'launch', grid: args.grid });
        session.lastFrame = file;
        session.note({ event: 'launch', url: session.browser.launchUrl });
        const state = await session.browser.state(session.config.stateExpression);
        const result = frameResult({
          file, margin, state, fullRes: args.full_res, label: 'initial',
          extra: [`session_id: ${session.id}`, `viewport: ${session.config.viewport.width}x${session.config.viewport.height}`],
        });
        session.touch();
        return result;
      });
    } catch (error) {
      return errorResult(error);
    }
  });
}

// runStep writes clean captures. The grid, when asked for, is applied afterwards
// to the frames actually being returned, so the on-disk originals stay usable.
function actResult({ session, step, args, previousFrame, actionName }) {
  const captures = Array.isArray(step.captures) ? step.captures : [];
  if (!captures.length) throw new Error('step produced no frames');
  const wanted = captures.slice(-MAX_FRAMES_PER_TURN);
  const finalCapture = wanted[wanted.length - 1];
  session.lastFrame = finalCapture.path;

  const changed = changedSince(previousFrame, finalCapture.path);
  session.note({
    event: 'act',
    action: actionName,
    duration_ms: step.duration,
    inputs: step.actions.map((item) => item.type === 'key' ? item.key : item.type),
    changed,
    ...(args.note ? { intent: args.note } : {}),
  });

  const content = [];
  for (const capture of wanted.slice(0, -1)) {
    const frame = frameResult({
      file: capture.path, margin: 0, state: capture.state,
      fullRes: args.full_res, label: `t=${capture.at}ms`,
    });
    content.push(...frame.content);
  }
  const last = frameResult({
    file: finalCapture.path,
    margin: args.grid ? applyGrid(session, finalCapture.path) : 0,
    state: step.endState,
    fullRes: args.full_res,
    label: wanted.length > 1 ? `t=${finalCapture.at}ms` : null,
    extra: [
      `sequence ran ${step.duration}ms`,
      changed === false
        ? 'frame is byte-identical to the previous one: the input probably did not reach the game. Check focus, try a different key, or hold it longer.'
        : null,
    ],
  });
  session.touch();
  return { content: [...content, ...last.content] };
}

function registerObserve(server, registry) {
  server.registerTool('observe', {
    title: 'Observe',
    description: 'Take a fresh screenshot and read game state without sending any input.',
    inputSchema: {
      session_id: z.string(),
      ...frameOptions,
    },
  }, async (args) => {
    try {
      const session = registry.get(args.session_id);
      return session.run(async () => {
        const name = `observe-${String(session.turn).padStart(3, '0')}`;
        const { file, margin } = await captureFrame(session, { name, grid: args.grid });
        const state = await session.browser.state(session.config.stateExpression);
        session.lastFrame = file;
        const result = frameResult({ file, margin, state, fullRes: args.full_res });
        session.touch();
        return result;
      });
    } catch (error) {
      return errorResult(error);
    }
  });
}

function registerAct(server, registry) {
  server.registerTool('act', {
    title: 'Act',
    description: [
      'Send a timed sequence of inputs, then return the resulting frame.',
      'Offsets are milliseconds from the start of the sequence and actions may overlap, so one call can express "hold right for 900ms and jump at 150ms".',
      'This is the main way to play: prefer one sequence that commits to a move over many single-input calls.',
    ].join(' '),
    inputSchema: {
      session_id: z.string(),
      actions: z.array(action).min(1).describe('Inputs to run. Total sequence should stay under 8000ms.'),
      captures: z.array(z.number().min(0)).max(MAX_FRAMES_PER_TURN).optional()
        .describe('Offsets in ms to screenshot at. Defaults to the end of the sequence. Each extra frame costs context.'),
      note: z.string().optional().describe('Short intent for the journal, e.g. "cross bridge east".'),
      ...frameOptions,
    },
  }, async (args) => {
    try {
      const session = registry.get(args.session_id);
      return session.run(async () => {
        const stepIndex = session.nextStepIndex();
        const actionName = `act-${String(stepIndex).padStart(3, '0')}`;
        const previousFrame = session.lastFrame;
        const step = await runStep({
          input: {
            action: 'step',
            action_name: actionName,
            actions: args.actions,
            ...(args.captures ? { captures: args.captures } : {}),
            autoCaptures: false,
          },
          config: session.config,
          browser: session.browser,
          outputDir: session.actionDir(actionName),
          nextStepIndex: stepIndex,
          actionName,
          profiler: null,
        });
        return actResult({ session, step, args, previousFrame, actionName });
      });
    } catch (error) {
      return errorResult(error);
    }
  });
}

module.exports = { MAX_FRAMES_PER_TURN, frameOptions, registerAct, registerObserve, registerPlayTools };
