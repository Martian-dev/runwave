#!/usr/bin/env node
'use strict';

const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { createServer } = require('../src/server');

async function main() {
  const { server, registry, workspace } = createServer();
  // stdout is the MCP transport, so diagnostics go to stderr only.
  process.stderr.write(`runwave-mcp workspace: ${workspace}\n`);

  // Chromium and any game process are detached children. Without this a host
  // shutting the server down orphans the whole tree, leaving browsers running.
  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stderr.write(`runwave-mcp shutting down on ${signal}\n`);
    await registry.closeAll();
    await server.close().catch(() => {});
    process.exit(0);
  };

  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signal, () => { shutdown(signal); });
  }
  process.on('uncaughtException', async (error) => {
    process.stderr.write(`runwave-mcp uncaught: ${error.stack || error.message}\n`);
    await shutdown('uncaughtException');
  });
  process.on('unhandledRejection', (reason) => {
    process.stderr.write(`runwave-mcp unhandled rejection: ${reason}\n`);
  });

  await server.connect(new StdioServerTransport());
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exit(1);
});
