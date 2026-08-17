# Runwave Controller

The controller is the low-level session layer behind `runwave-controller`.
It starts browser or native Linux game sessions, captures state and screenshots,
executes timed input sequences, records WebM output, and writes per-action
artifacts.

See the top-level [Requirements](../../README.md#requirements) section for the
Linux, gstreamer, X server/Xvfb, and PulseAudio setup required by `record: true`.

## Start

Start from a local file:

```sh
runwave-controller '{
  "action": "start",
  "action_name": "run-start",
  "session_id": "playtest-001",
  "file": "game/index.html",
  "record": true,
  "viewport": { "width": 1024, "height": 620 },
  "videoSize": { "width": 1024, "height": 620 },
  "keyAliases": {
    "left": "a",
    "right": "d",
    "jump": "w"
  }
}'
```

Start from a URL:

```sh
runwave-controller '{
  "action": "start",
  "action_name": "run-start",
  "session_id": "playtest-001",
  "url": "http://localhost:3000",
  "record": true
}'
```

Start a native Linux game:

```sh
runwave-controller '{
  "action": "start",
  "action_name": "run-start",
  "session_id": "playtest-001",
  "kind": "linux",
  "command": "./game",
  "args": ["--windowed"],
  "cwd": "/absolute/path/to/game",
  "windowTitle": "Native Game",
  "record": true,
  "viewport": { "width": 1280, "height": 720 }
}'
```

Useful `start` options:

- `kind`: `web` by default. Use `linux` for a native Linux/X11 game.
- `url` or `file`: required target for web sessions.
- `command`, `args`, `cwd`: native Linux launch command. If `kind` is `linux`
  and no command is provided, the controller attempts to attach to an existing
  matching visible window.
- `windowTitle`, `windowClass`, or `windowId`: optional Linux window selector.
  If omitted, Runwave chooses the largest visible X11 window after launch.
- `windowWaitMs`: native Linux window wait timeout. Defaults to 15000.
- `launchSettleMs`: native Linux delay after launch and recording start before
  the first screenshot/agent call. Defaults to 30000. Use 0 for smoke tests.
- `viewport`: for native Linux sessions, the full X11 display area to
  screenshot, record, grid, and use for pointer coordinates. The detected game
  window is used for focus and best-effort resizing, not as the capture crop.
  The launched process also receives `RUNWAVE_VIEWPORT_WIDTH`,
  `RUNWAVE_VIEWPORT_HEIGHT`, `RUNWAVE_CAPTURE_X`, `RUNWAVE_CAPTURE_Y`,
  `RUNWAVE_CAPTURE_WIDTH`, and `RUNWAVE_CAPTURE_HEIGHT` environment variables
  for optional wrapper-side size hints.
- `session_id`: required session identifier. Reuse it for all actions targeting
  the same controller session.
- `record`: enable gstreamer audio+video WebM recording. Requires all the
  prerequisites in the top-level [Requirements](../../README.md#requirements)
  section. Chromium is launched headed with kiosk/fullscreen flags so
  gstreamer's `ximagesrc` can capture the rendered viewport. Override capture
  sources with `videoSource` and `audioSource`. (`recordAudio` is accepted as a
  legacy alias for `record`; they mean the same thing - audio is always captured
  when recording.)
- `headless`: defaults to `true`; set `false` to watch the browser.
- `channel`: optional Playwright browser channel, such as `chrome` or `msedge`.
- `executablePath`: optional explicit browser executable path.
- `viewport`: defaults to `{ "width": 1024, "height": 620 }`.
- `videoSize`: defaults to the viewport.
- `keyAliases`: maps semantic names used in steps to real Playwright keys.
- `stateExpression`: optional JavaScript expression evaluated in the page.
- `outputRoot`: defaults to `state/output`.
- `outDir`: defaults to `recordings/runwave-run-<timestamp>`.
- `sessionWaitMs`: overrides daemon startup wait for this start operation.

## Sequences And Actions

Inspect state:

```sh
runwave-controller '{"action":"state","action_name":"turn-001-state","session_id":"playtest-001"}'
```

Capture a screenshot:

```sh
runwave-controller '{"action":"screenshot","action_name":"turn-001-screen","session_id":"playtest-001","name":"screen"}'
```

Execute timed keyboard controls:

```sh
runwave-controller '{
  "action": "step",
  "action_name": "turn-002-jump-right",
  "session_id": "playtest-001",
  "actions": [
    { "type": "key", "start": 0, "end": 900, "key": "right" },
    { "type": "key", "start": 150, "end": 230, "key": "jump" }
  ],
  "captures": [900],
  "autoCaptures": false
}'
```

For `step`, the payload is a sequence. The sequence duration is inferred from
the latest action `end`, or from `start` for instant actions.

Click:

```sh
runwave-controller '{
  "action": "step",
  "action_name": "turn-003-click-start",
  "session_id": "playtest-001",
  "actions": [
    { "type": "click", "start": 100, "x": 512, "y": 310 }
  ]
}'
```

Screenshots include a 16x16 red mark grid by default. Overlay column labels are
shown in the top/bottom margins and overlay row labels are shown in the
left/right margins. Pointer actions may use overlay row/column grid objects
instead of exact pixels.

Single overlay grid click:

```sh
runwave-controller '{
  "action": "step",
  "action_name": "turn-003-click-start-cell",
  "session_id": "playtest-001",
  "actions": [
    { "type": "click", "start": 100, "cell": { "overlay_row": 6, "overlay_col": 7 } }
  ]
}'
```

Multi-click sends quick clicks at random points inside the selected cells:

```sh
runwave-controller '{
  "action": "step",
  "action_name": "turn-003-multi-click",
  "session_id": "playtest-001",
  "actions": [
    { "type": "multi_click", "start": 100, "cells": [{ "overlay_row": 6, "overlay_col": 7 }, { "overlay_row": 6, "overlay_col": 8 }], "count": 10 }
  ]
}'
```

Drag:

```sh
runwave-controller '{
  "action": "step",
  "action_name": "turn-004-drag",
  "session_id": "playtest-001",
  "actions": [
    { "type": "drag", "start": 100, "end": 700, "from": { "x": 420, "y": 300 }, "to": { "x": 500, "y": 300 }, "mode": "mouse", "steps": 12 }
  ]
}'
```

Use `mode: "mouse"` for canvas, pointer-based games, and native Linux games.
Use `mode: "html5"` only for browser-native draggable/drop elements.
Drag endpoints can also use grid cells:

```json
{ "type": "drag", "start": 100, "from": { "overlay_row": 8, "overlay_col": 10 }, "to": { "overlay_row": 8, "overlay_col": 11 }, "mode": "mouse" }
```

Move the cursor without clicking:

```json
{ "action": "step", "action_name": "turn-005-hover", "session_id": "playtest-001", "actions": [{ "type": "cursor_move", "start": 100, "end": 500, "cell": { "overlay_row": 6, "overlay_col": 7 } }] }
```

Move the mouse without clicking for camera control:

```sh
runwave-controller '{
  "action": "step",
  "action_name": "turn-005-look-around",
  "session_id": "playtest-001",
  "actions": [
    { "type": "view_move", "start": 200, "end": 900, "dx": 260, "dy": -40, "steps": 16 }
  ]
}'
```

`view_move` actions use relative CSS-pixel deltas. Positive `dx` moves right,
negative `dx` moves left, positive `dy` moves down, and negative `dy` moves up.

Navigate or reset web sessions:

```sh
runwave-controller '{"action":"reset","action_name":"reset-001","session_id":"playtest-001"}'
```

Stop and finalize the recording:

```sh
runwave-controller '{"action":"stop","action_name":"run-stop","session_id":"playtest-001"}'
```

List known sessions:

```sh
runwave-controller '{"action":"sessions"}'
```

When `record: true` is set, `stop` returns the recorded WebM in `video`.
Recording uses gstreamer by default; see the top-level
[Requirements](../../README.md#requirements) section for the mandatory Linux,
X server/Xvfb, and PulseAudio environment. Web sessions can instead set
`"recordingBackend":"playwright"` to capture the browser viewport directly.
That backend can run headlessly and does not require X11, but is video-only.
`recordAudio: true` continues to require the gstreamer backend and returns the
same audio/video WebM in both `video` and `audioVideo`.

## State

Every response includes generic browser state:

- URL and title.
- Viewport dimensions.
- Active element summary.
- Pointer-lock element summary.
- Canvas positions and sizes.

For native Linux sessions, state includes:

- target kind
- X11 display
- viewport/capture dimensions for the full recorded display
- selected window id and position
- launched process pid/running status when the controller owns the process

For game-specific state, pass a `stateExpression` on `start` or an individual
operation:

```json
{
  "stateExpression": "() => ({ score: window.score, lives: window.lives })"
}
```

If the expression throws, the response still includes generic state plus
`customError`.

## Output Layout

Each turn writes:

- `response.json`: the main CLI response.
- `*.png`: screenshots captured during that operation.
- `NNN-<action_name>.json`: detailed sequence log for `step` operations.
- `video/000-runwave-with-audio.webm`: final gstreamer audio+video recording.

Active sessions are tracked as JSON files in `.runwave-sessions/` by default.
The matching session file is removed by `stop`.
