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
        'Call launch_game once, then loop act/observe, then end_game.',
        'Frames come back downscaled to save context; use zoom to inspect detail and full_res only when you must.',
        'Prefer one act call that commits to a move (hold a key for several hundred ms) over many single taps.',
        'If a result says the frame did not change, the input did not land: change approach rather than repeating it.',
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
