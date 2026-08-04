'use strict';

const { z } = require('zod');
const { region } = require('./schema');
const { captureFrame, frameResult } = require('./frame');
const { errorResult, textBlock } = require('./result');

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
        const name = `zoom-${String(session.turn).padStart(3, '0')}`;
        const { file } = await captureFrame(session, { name, grid: false });
        const state = await session.browser.state(session.config.stateExpression);
        const result = frameResult({
          file, margin: 0, state, fullRes: true, region: args.region,
          label: `zoom ${args.region.width}x${args.region.height} at (${args.region.x},${args.region.y})`,
        });
        session.touch();
        return result;
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
        const { file } = await captureFrame(session, { name: `capture-${args.name}`, grid: false });
        session.note({ event: 'capture', name: args.name, path: file });
        session.touch();
        const summary = textBlock(`saved ${session.config.viewport.width}x${session.config.viewport.height} clean capture\npath: ${file}`);
        if (!args.preview) return { content: [summary] };
        const state = await session.browser.state(session.config.stateExpression);
        const preview = frameResult({ file, margin: 0, state, label: 'saved' });
        return { content: [summary, ...preview.content] };
      });
    } catch (error) {
      return errorResult(error);
    }
  });
}

function registerSessionTools(server, registry) {
  server.registerTool('reset_game', {
    title: 'Reset game',
    description: 'Reload the game at its launch URL. Use this when stuck or to start a fresh attempt.',
    inputSchema: { session_id: z.string() },
  }, async (args) => {
    try {
      const session = registry.get(args.session_id);
      return session.run(async () => {
        await session.browser.navigate({ url: session.browser.launchUrl });
        session.stepIndex = 0;
        session.note({ event: 'reset' });
        const { file } = await captureFrame(session, { name: `reset-${session.turn}`, grid: false });
        session.lastFrame = file;
        const state = await session.browser.state(session.config.stateExpression);
        const result = frameResult({ file, margin: 0, state, label: 'after reset' });
        session.touch();
        return result;
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
}

module.exports = { registerCapture, registerSessionTools, registerZoom };
