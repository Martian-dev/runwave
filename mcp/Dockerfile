# Runwave MCP server: lets an agent harness play browser games.
#
# The Playwright base image already carries every system library Chromium needs
# (libnss3, libnspr4, libgbm, the X client libs), which is the whole reason to
# start from it rather than a plain node image.
#
# No recording means no gstreamer, no PulseAudio, and no Xvfb: Chromium runs
# headless, so this image stays far smaller than the playtest runner's.
FROM mcr.microsoft.com/playwright:v1.61.1-noble

ENV NODE_ENV=production \
    RUNWAVE_MCP_WORKSPACE=/var/lib/runwave-mcp

WORKDIR /opt/runwave

# Dependencies are copied first so a source edit does not invalidate the
# install layer.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY runwave ./runwave
COPY mcp ./mcp

RUN mkdir -p "$RUNWAVE_MCP_WORKSPACE"

# Chromium's sandbox needs privileges a default container does not grant. The
# base image ships a non-root user with the right setup; use it rather than
# disabling the sandbox.
USER pwuser

# stdio transport: the host speaks MCP over stdin/stdout, so nothing is exposed
# on the network and no port is published.
ENTRYPOINT ["node", "/opt/runwave/mcp/bin/runwave-mcp.js"]
