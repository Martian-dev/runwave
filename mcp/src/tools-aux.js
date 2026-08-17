'use strict';

const { z } = require('zod');
const { region } = require('./schema');
const { captureFrame, frameResult } = require('./frame');
const { renderPlaythrough } = require('./replay');
const { errorResult, pauseNote, textBlock } = require('./result');

function registerZoom(server, registry) {
  server.registerTool('zoom', {
    title: 'Zoom',
    description: 'Screenshot a rectangle of the viewport at full resolution. Use this to read small UI or confirm a target before clicking, instead of paying for a full-resolution frame.',
    inputSchema: {
      session_id: z.string(),
      region: region.describe('Viewport rectangle in real pixels.'),
    },
  }, async (args) => {
    try {
      const session = registry.get(args.session_id);
      return session.run(async () => {
        try {
          await session.pauseForAgent('awaiting_agent');
          const name = `zoom-${String(session.turn).padStart(3, '0')}`;
          const { file } = await captureFrame(session, { name, grid: false });
          const state = await session.browser.state(session.config.stateExpression);
          return frameResult({
            file, margin: 0, state, fullRes: true, region: args.region,
            label: `zoom ${args.region.width}x${args.region.height} at (${args.region.x},${args.region.y})`,
            extra: [pauseNote(session.pauseMode)],
          });
        } finally {
          await session.pauseForAgent('awaiting_agent');
        }
      });
    } catch (error) {
      return errorResult(error);
    }
  });
}

function registerCapture(server, registry) {
  server.registerTool('capture', {
    title: 'Capture deliverable',
    description: 'Save a clean, full-resolution, un-annotated screenshot to disk and return its path. Use this for the final artifact once the target is reached.',
    inputSchema: {
      session_id: z.string(),
      name: z.string().describe('File label, e.g. "target-reached".'),
      preview: z.boolean().optional().describe('Also return a downscaled preview to confirm what was saved.'),
    },
  }, async (args) => {
    try {
      const session = registry.get(args.session_id);
      return session.run(async () => {
        try {
          await session.pauseForAgent('awaiting_agent');
          const { file } = await captureFrame(session, { name: `capture-${args.name}`, grid: false });
          session.note({ event: 'capture', name: args.name, path: file });
          const summary = textBlock(`saved ${session.config.viewport.width}x${session.config.viewport.height} clean capture\npath: ${file}\n${pauseNote(session.pauseMode)}`);
          if (!args.preview) return { content: [summary] };
          const state = await session.browser.state(session.config.stateExpression);
          const preview = frameResult({ file, margin: 0, state, label: 'saved' });
          return { content: [summary, ...preview.content] };
        } finally {
          await session.pauseForAgent('awaiting_agent');
        }
      });
    } catch (error) {
      return errorResult(error);
    }
  });
}

function registerSessionTools(server, registry) {
  server.registerTool('focus_game', {
    title: 'Focus game controls',
    description: 'Acquire pointer lock on the game canvas without moving the FPS camera. Call this when state reports pointer_locked=false before using view_move. Middle click avoids firing in most games; retry with left only if the game requires it.',
    inputSchema: {
      session_id: z.string(),
      button: z.enum(['left', 'middle', 'right']).optional()
        .describe('Button used to acquire focus. Default middle.'),
    },
  }, async (args) => {
    try {
      const session = registry.get(args.session_id);
      return session.run(async () => {
        let focus;
        try {
          await session.prepareForGameplay('focus_game');
          session.nextStepIndex();
          focus = await session.browser.focusGame({ button: args.button || 'middle' });
          if (!focus.pointerLocked) {
            throw new Error(`game canvas did not acquire pointer lock with ${focus.button} click`);
          }
        } finally {
          await session.pauseForAgent('awaiting_agent');
        }
        session.appendPlaythroughStep({
          duration: 75,
          actions: [{
            type: 'focus_game',
            start: 0,
            end: 75,
            x: focus.x,
            y: focus.y,
            button: focus.button,
          }],
          note: 'acquire pointer lock without camera movement',
        });
        session.note({ event: 'focus_game', button: focus.button, pointer_locked: true });
        const { file } = await captureFrame(session, {
          name: `focus-${String(session.stepIndex).padStart(3, '0')}`,
          grid: false,
        });
        session.lastFrame = file;
        const state = await session.browser.state(session.config.stateExpression);
        return frameResult({
          file, margin: 0, state, label: 'game focused',
          extra: [pauseNote(session.pauseMode)],
        });
      });
    } catch (error) {
      return errorResult(error);
    }
  });

  server.registerTool('reset_game', {
    title: 'Reset game',
    description: 'Reload the game at its launch URL. Use this when stuck or to start a fresh attempt.',
    inputSchema: { session_id: z.string() },
  }, async (args) => {
    try {
      const session = registry.get(args.session_id);
      return session.run(async () => {
        try {
          await session.prepareForGameplay('reset_game');
          await session.browser.navigate({ url: session.browser.launchUrl });
          session.stepIndex = 0;
          session.resetPlaythrough();
          session.note({ event: 'reset' });
          await session.pauseForAgent('awaiting_agent');
          const { file } = await captureFrame(session, { name: `reset-${session.turn}`, grid: false });
          session.lastFrame = file;
          const state = await session.browser.state(session.config.stateExpression);
          return frameResult({
            file, margin: 0, state, label: 'after reset',
            extra: [pauseNote(session.pauseMode)],
          });
        } finally {
          await session.pauseForAgent('awaiting_agent');
        }
      });
    } catch (error) {
      return errorResult(error);
    }
  });

  // Cheap way back into context after a compaction: text only, no frames.
  server.registerTool('journal', {
    title: 'Journal',
    description: 'Read the log of what has been tried this session. Use this to re-orient without replaying screenshots.',
    inputSchema: {
      session_id: z.string(),
      limit: z.number().int().positive().max(200).optional().describe('Most recent entries to return. Default 40.'),
    },
  }, async (args) => {
    try {
      const session = registry.get(args.session_id);
      const limit = args.limit ?? 40;
      const entries = session.journal.slice(-limit);
      const lines = entries.map((entry) => {
        const seconds = (entry.at / 1000).toFixed(1);
        const rest = Object.entries(entry)
          .filter(([key]) => !['turn', 'at', 'event'].includes(key))
          .map(([key, value]) => `${key}=${Array.isArray(value) ? value.join('+') : value}`)
          .join(' ');
        return `[${seconds}s] turn ${entry.turn} ${entry.event}${rest ? ` ${rest}` : ''}`;
      });
      const header = `${session.journal.length} entries, showing last ${entries.length}`;
      return { content: [textBlock([header, ...lines].join('\n'))] };
    } catch (error) {
      return errorResult(error);
    }
  });

  server.registerTool('list_sessions', {
    title: 'List sessions',
    description: 'List running game sessions.',
    inputSchema: {},
  }, async () => {
    const sessions = registry.list();
    if (!sessions.length) return { content: [textBlock('no sessions running')] };
    return { content: [textBlock(JSON.stringify(sessions, null, 2))] };
  });

  server.registerTool('end_game', {
    title: 'End game',
    description: 'Close the browser and stop the game process. Always call this when finished.',
    inputSchema: { session_id: z.string() },
  }, async (args) => {
    try {
      const summary = await registry.end(args.session_id);
      return { content: [textBlock(JSON.stringify(summary, null, 2))] };
    } catch (error) {
      return errorResult(error);
    }
  });

  server.registerTool('render_playthrough', {
    title: 'Render clean playthrough',
    description: 'Replay the successful act timeline in a fresh isolated browser and record a smooth game-only WebM. The live agent session remains paused, so model reasoning and screenshot latency do not appear in the video.',
    inputSchema: {
      session_id: z.string(),
      tail_ms: z.number().int().min(0).max(5000).optional()
        .describe('Extra live time after the final action. Default 1000ms.'),
    },
  }, async (args) => {
    try {
      const session = registry.get(args.session_id);
      return session.run(async () => {
        try {
          await session.pauseForAgent('render_playthrough');
          const replay = await renderPlaythrough(session, { tailMs: args.tail_ms ?? 1000 });
          session.note({
            event: 'render_playthrough',
            steps: replay.step_count,
            video: replay.video,
          });
          return { content: [textBlock(JSON.stringify(replay, null, 2))] };
        } finally {
          await session.pauseForAgent('awaiting_agent');
        }
      });
    } catch (error) {
      return errorResult(error);
    }
  });

  server.registerTool('pause_game', {
    title: 'Pause game immediately',
    description: 'Immediately pause the browser game at the harness level. This is a higher-authority override and does not wait behind an in-progress gameplay call. Call resume_game before act if you paused manually.',
    inputSchema: {
      session_id: z.string(),
      reason: z.string().optional().describe('Why the pause was requested.'),
    },
  }, async (args) => {
    try {
      const session = registry.get(args.session_id);
      await session.pause({ mode: 'manual', reason: args.reason || 'manual_pause' });
      return { content: [textBlock(JSON.stringify(session.summary(), null, 2))] };
    } catch (error) {
      return errorResult(error);
    }
  });

  server.registerTool('resume_game', {
    title: 'Resume game',
    description: 'Release a manual pause so the next act or reset_game call can continue gameplay.',
    inputSchema: { session_id: z.string() },
  }, async (args) => {
    try {
      const session = registry.get(args.session_id);
      await session.resume({ force: true, reason: 'manual_resume' });
      return { content: [textBlock(JSON.stringify(session.summary(), null, 2))] };
    } catch (error) {
      return errorResult(error);
    }
  });
}

module.exports = { registerCapture, registerSessionTools, registerZoom };
