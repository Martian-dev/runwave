# Runwave MCP

An MCP server that lets an agent harness such as Claude Code play a browser game
directly: look at a frame, send a timed sequence of inputs, look at the next
frame.

This is the interactive counterpart to the `runwave` CLI. The CLI runs a VLM in a
loop by itself and produces a recorded video for playtesting. Here the connected
agent *is* the player, so the OpenRouter agent loop is not used and there is no
recording — which is also why this needs none of runwave's gstreamer,
PulseAudio, or Xvfb setup.

## Requirements

- Node 20+
- Chromium's system libraries. On a bare Linux host:
  ```sh
  npx playwright install --with-deps chromium   # needs sudo for the libs
  ```
  In Docker, use `mcp/Dockerfile`, which starts from the Playwright base image
  and already has them.

No X server, no audio, no display. Chromium runs headless.

## Run

```sh
node mcp/bin/runwave-mcp.js
```

Artifacts (screenshots, per-step JSON) are written under
`RUNWAVE_MCP_WORKSPACE`, defaulting to a directory in the system temp dir. Set
it explicitly if you want to keep them:

```sh
RUNWAVE_MCP_WORKSPACE=./artifacts node mcp/bin/runwave-mcp.js
```

Register it with Claude Code:

```sh
claude mcp add runwave -- node /absolute/path/to/mcp/bin/runwave-mcp.js
```

Or in Docker:

```sh
docker build -f mcp/Dockerfile -t runwave-mcp .
claude mcp add runwave -- docker run --rm -i runwave-mcp
```

## Tools

| Tool | Purpose |
| --- | --- |
| `launch_game` | Start a session from a `url`, or a `game_dir` containing `start.sh` plus a `port`. Returns the first frame. |
| `observe` | Fresh frame and state, no input sent. |
| `act` | Send a timed input sequence, return the resulting frame. |
| `zoom` | Full-resolution crop of a region, to read small UI without a full frame. |
| `capture` | Save a clean, full-resolution, un-annotated screenshot. The deliverable. |
| `reset_game` | Reload at the launch URL. |
| `journal` | Text log of what has been tried this session. |
| `list_sessions` | Running sessions. |
| `end_game` | Close the browser and stop the game process. |

## How `act` works

An action sequence is timed, not a single keypress. Offsets are milliseconds
from the start of the sequence and actions may overlap, so one call can express
"hold right for 900ms and jump at 150ms":

```json
{
  "session_id": "game-...",
  "actions": [
    { "type": "key", "start": 0, "end": 900, "key": "ArrowRight" },
    { "type": "key", "start": 150, "end": 230, "key": "Space" }
  ]
}
```

This matters because an agent turn costs seconds. Committing to a move beats
sending one tap per turn.

Action types: `key`, `click`, `multi_click`, `drag`, `cursor_move`, `view_move`.
Pointer actions take either `x`/`y` in viewport pixels or an
`overlay_row`/`overlay_col` grid cell. The full schema is enforced on the tool
input, so a malformed sequence is rejected before any input is sent.

## Notes on the design

**Frames are downscaled by default.** A 1280x720 PNG is roughly 1200 tokens; at
half scale it is about 300. Over a long navigation that difference dominates
everything else. Pass `full_res: true` when detail genuinely matters, or use
`zoom` on the region you care about — usually cheaper than a full-resolution
frame.

**One frame per turn.** Interval captures are off. Pass `captures` with explicit
offsets to see a trajectory within a sequence.

**`act` reports whether the frame changed.** A byte-identical frame almost always
means the input never reached the game, rather than the game ignoring it. The
tool says so instead of leaving the agent to guess.

**The grid overlay is off by default.** When enabled it enlarges the PNG with a
label margin on every side, so pixels read off the image no longer match pixels
sent back as `x`/`y`. The offset is reported in the response when the grid is on,
but exact coordinates or grid cells are the better targets.

**Grid cells resolve to the cell centre.** Runwave's playtest path deliberately
scatters clicks inside a cell to vary footage; that is wrong when aiming at a
specific target, and it makes a run unreproducible. Playtest behaviour is
unchanged — this server opts into `markGridSampleMode: 'center'`.

**Calls are serialized per session.** There is one Playwright page and one shared
step counter, so concurrent calls would interleave keypresses. Subagents may
share a `session_id` safely.

**Sessions close on shutdown.** Chromium and any spawned game process are
detached children; `SIGINT`, `SIGTERM`, `SIGHUP`, and an uncaught exception all
close them. Sessions also close after 30 minutes idle, so a forgotten
`end_game` does not leak a browser.

## Tests

```sh
npm run test:mcp
```

The integration test drives a real headless Chromium against a fixture game and
skips itself when Chromium cannot launch.
