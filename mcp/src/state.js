'use strict';

// Runwave's raw state carries a full WebGL renderer probe and every canvas on
// the page. Useful for a playtest report, mostly noise for an agent deciding a
// next move, and it is paid for on every single turn. Only the fields that
// change a decision survive.
function compactState(raw) {
  const generic = (raw && raw.generic) || raw || {};
  const canvases = Array.isArray(generic.canvases) ? generic.canvases : [];
  const state = {};
  if (generic.title) state.title = generic.title;
  if (generic.url) state.url = generic.url;

  const active = generic.activeElement;
  if (active && active.tagName && active.tagName !== 'BODY') {
    state.focus = [active.tagName, active.id ? `#${active.id}` : ''].filter(Boolean).join('');
  }

  // The largest canvas is almost always the game surface. Its client rect tells
  // an agent which part of the viewport is actually playable.
  const surface = canvases
    .filter((canvas) => canvas && canvas.clientWidth > 0 && canvas.clientHeight > 0)
    .sort((left, right) => right.clientWidth * right.clientHeight - left.clientWidth * left.clientHeight)[0];
  if (surface) {
    state.pointer_locked = Boolean(generic.pointerLockElement && generic.pointerLockElement.tagName);
    state.game_area = {
      x: Math.round(surface.left ?? surface.x ?? 0),
      y: Math.round(surface.top ?? surface.y ?? 0),
      width: Math.round(surface.clientWidth),
      height: Math.round(surface.clientHeight),
    };
  }
  if (canvases.length > 1) state.canvas_count = canvases.length;

  // A stateExpression is opt-in and game-specific, so whatever it returns is
  // assumed relevant and passed through intact.
  if (raw && raw.custom !== undefined) state.custom = raw.custom;
  if (raw && raw.customError) state.custom_error = String(raw.customError).slice(0, 300);
  return state;
}

module.exports = {
  compactState,
};
