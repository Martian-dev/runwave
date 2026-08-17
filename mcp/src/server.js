'use strict';

const os = require('os');
const path = require('path');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { SessionRegistry } = require('./registry');
const { registerAct, registerObserve, registerPlayTools } = require('./tools-play');
const { registerCapture, registerSessionTools, registerZoom } = require('./tools-aux');

const VERSION = '0.1.0';

// An MCP server starts in whatever directory the host happens to use, so the
// workspace is resolved explicitly instead of from cwd. This is the same trap
// runwave's paths.js falls into by capturing cwd at require time.
function resolveWorkspace() {
  const configured = process.env.RUNWAVE_MCP_WORKSPACE;
  if (configured) return path.resolve(configured);
  return path.join(os.tmpdir(), 'runwave-mcp');
}

function createServer({ workspace = resolveWorkspace() } = {}) {
  const server = new McpServer(
    { name: 'runwave', version: VERSION },
    {
      instructions: [
        'Play browser games by looking at frames and sending timed input sequences.',
        'Call launch_game once, then loop act/observe, then end_game. Returned frames automatically leave the game paused while you reason; act and reset_game resume for their operation and pause again before returning.',
        'Use pause_game for a higher-authority manual pause and resume_game to release it.',
        'Frames come back downscaled to save context; use zoom to inspect detail and full_res only when you must.',
        'When direction, distance, or collision is uncertain, use a short 300-1200ms act as a probe and inspect the result. Commit to longer batched movement only after the heading and open route are verified.',
        'For uncertain actions longer than about 1500ms, request 2-3 captures across the sequence; if landmarks stop changing or the same surface fills them, recover instead of repeating forward movement.',
        'If state reports pointer_locked=false in a mouse-look game, call focus_game before view_move. Begin with a small view_move because sensitivity varies by game.',
        'A click span may last up to two seconds, so use one held click for sustained fire or aiming instead of many rapid click actions.',
        'When a load or animation needs controlled time, set act duration_ms; actions may be an empty array for a wait with no input.',
        'If a result says the frame did not change, the input did not land: change approach rather than repeating it.',
        'When the run is worth keeping, call render_playthrough before end_game to replay the successful input timeline in a separate recorder without reasoning gaps.',
        'Use journal to recall what you have already tried, and capture to save the final screenshot.',
      ].join(' '),
    }
  );

  const registry = new SessionRegistry({ workspace });
  registerPlayTools(server, registry);
  registerObserve(server, registry);
  registerAct(server, registry);
  registerZoom(server, registry);
  registerCapture(server, registry);
  registerSessionTools(server, registry);
  return { server, registry, workspace };
}

module.exports = {
  VERSION,
  createServer,
  resolveWorkspace,
};
