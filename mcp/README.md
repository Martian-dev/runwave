# Runwave MCP

An MCP server that lets an agent harness such as Claude Code play a browser game
directly: look at a frame, send a timed sequence of inputs, look at the next
frame.

This is the interactive counterpart to the `runwave` CLI. The CLI runs a VLM in a
loop by itself and produces a recorded video for playtesting. Here the connected
agent *is* the player, so the OpenRouter agent loop is not used. Interactive
play itself is not recorded: successful input sequences are persisted and can
be replayed afterwards in a separate Playwright-native recorder. This needs
none of runwave's gstreamer, PulseAudio, or Xvfb setup.

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

Artifacts (screenshots, per-step JSON, `playthrough.json`, and rendered videos)
are written under
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
| `observe` | Fresh frame and state, no input sent. The game is paused while the agent reasons. |
| `act` | Resume, send a timed input sequence, pause, and return the resulting frame. |
| `zoom` | Full-resolution crop of a region, to read small UI without a full frame. |
| `capture` | Save a clean, full-resolution, un-annotated screenshot. The deliverable. |
| `focus_game` | Acquire pointer lock on the largest game canvas without rotating an FPS camera. |
| `reset_game` | Reload at the launch URL. |
| `render_playthrough` | Replay the current successful input timeline in a fresh browser and record a game-only WebM without agent reasoning gaps. |
| `journal` | Text log of what has been tried this session. |
| `list_sessions` | Running sessions. |
| `pause_game` | Immediately pause the browser game at the harness level. |
| `resume_game` | Release a manual pause. |
| `end_game` | Close the browser and stop the game process. |

## Playthrough recording

Every successful `act` is appended to an atomically replaced
`playthrough.json`. It stores the concrete pixel coordinates, resolved keys,
step durations, and optional intent notes needed to reproduce the current
attempt. `reset_game` starts a fresh attempt and clears its steps.

Call `render_playthrough` once the attempt is worth keeping. It leaves the live
game paused, opens the same launch URL in a fresh isolated browser, executes the
timeline without screenshots or model turns, and records that browser viewport
with Playwright's native screencast. The result includes paths to the WebM and a
replay manifest under the session's `replays/` directory.

This is intentionally an input replay, not a game-engine clock patch. It stays
agnostic across canvas, WebGL, and DOM games. Games with randomness, networked
state, or nondeterministic physics can diverge from the original run; the
timeline preserves the agent's inputs and timing, not private engine state.

## Pause behavior

The MCP automatically pauses the page after `launch_game`, `observe`, `act`,
`zoom`, `capture`, and `reset_game` return their frame. This keeps a live game
from progressing while the agent is inspecting the image and deciding its next
move. `act` and `reset_game` temporarily resume the page for their operation,
then pause it again before returning.

The pause is implemented in the browser harness rather than by sending the
game's own pause key. It holds animation frames and timers, virtualizes
`performance.now()`/`Date.now()` so a long reasoning turn does not create a
large simulation delta, and blocks new gameplay input while paused. Screenshots
and state reads remain available.

`pause_game` is an immediate, higher-authority manual override. It does not wait
behind an in-progress `act` call. A manually paused session rejects `act` and
`reset_game` until `resume_game` is called, so an emergency pause cannot be
silently undone by a queued gameplay action.

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
  ],
  "duration_ms": 900
}
```

This matters because an agent turn costs seconds, but the useful batch size
depends on uncertainty:

- Use a short 300-1200ms probe when calibrating direction or camera sensitivity,
  approaching a collider, or searching for an interaction range.
- Commit to a longer sequence once the heading and open route are visually
  verified.
- On an uncertain sequence longer than about 1500ms, request 2-3 spaced
  `captures`. If the same landmark or surface fills consecutive frames, stop
  pushing forward and recover. Omit trajectory frames on known traversal to
  keep context and capture overhead low.

This gives the agent feedback where mistakes are expensive without turning all
gameplay into one tap per turn.

`duration_ms` is normally inferred from the latest action end. Set it explicitly
when an action starts a load or animation that should run before the final pause;
for example, click a play button at 0ms and use `duration_ms: 3000` to receive a
settled game frame rather than the first loading frame.

To advance a loading screen or animation without sending input, use an empty
sequence with a positive duration:

```json
{
  "session_id": "game-...",
  "actions": [],
  "duration_ms": 2000
}
```

Action types: `key`, `click`, `multi_click`, `drag`, `cursor_move`, `view_move`.
Pointer actions take either `x`/`y` in viewport pixels or an
`overlay_row`/`overlay_col` grid cell. The full schema is enforced on the tool
input, so a malformed sequence is rejected before any input is sent.

In a pointer-locked game, a `click` ignores its coordinates and presses the
current mouse button. A click may be held for up to two seconds, which is useful
for continuous fire or aim and avoids a slow burst of separate browser calls.
When state reports `pointer_locked: false`, call `focus_game` before using
`view_move`; calibrate with a small delta because sensitivity is game-defined.

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
