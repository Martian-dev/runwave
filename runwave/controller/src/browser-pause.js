'use strict';

// This script is installed before the game page's own scripts. It pauses the
// browser game rather than sending a game-specific key such as Escape, which
// makes the control independent of the game UI. The clock is virtualized so a
// long model turn does not become a large physics delta when the page resumes.
const BROWSER_PAUSE_INIT_SCRIPT = String.raw`
(() => {
  const name = '__runwavePauseController';
  if (window[name]) return;

  const native = {
    dateNow: Date.now.bind(Date),
    performanceNow: window.performance.now.bind(window.performance),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    setTimeout: window.setTimeout.bind(window),
    clearTimeout: window.clearTimeout.bind(window),
    setInterval: window.setInterval.bind(window),
    clearInterval: window.clearInterval.bind(window),
  };
  const state = {
    paused: false,
    performanceOffset: 0,
    dateOffset: 0,
    pausePerformanceNow: 0,
    pauseDateNow: 0,
    nextId: 1,
    frames: new Map(),
    timers: new Map(),
    intervals: new Map(),
    pointerMove: null,
    suppressPointerMovesUntil: 0,
  };

  const logicalPerformanceNow = () => state.paused
    ? state.pausePerformanceNow
    : native.performanceNow() - state.performanceOffset;
  const logicalDateNow = () => state.paused
    ? state.pauseDateNow
    : native.dateNow() - state.dateOffset;

  function invoke(record) {
    if (typeof record.callback === 'function') {
      return record.callback.apply(window, record.args);
    }
    return (0, eval)(String(record.callback));
  }

  function scheduleFrame(record) {
    if (state.paused || record.nativeId !== null) return;
    record.nativeId = native.requestAnimationFrame(() => {
      record.nativeId = null;
      if (state.paused || !state.frames.has(record.id)) return;
      state.frames.delete(record.id);
      record.callback(logicalPerformanceNow());
    });
  }

  function scheduleTimer(record) {
    if (state.paused || record.nativeId !== null) return;
    const delay = Math.max(0, record.due - logicalPerformanceNow());
    record.nativeId = native.setTimeout(() => {
      record.nativeId = null;
      if (state.paused || !state.timers.has(record.id)) return;
      state.timers.delete(record.id);
      invoke(record);
    }, delay);
  }

  function scheduleInterval(record) {
    if (state.paused || record.nativeId !== null) return;
    const delay = Math.max(0, record.due - logicalPerformanceNow());
    record.nativeId = native.setTimeout(() => {
      record.nativeId = null;
      if (state.paused || !state.intervals.has(record.id)) return;
      try {
        invoke(record);
      } finally {
        if (state.intervals.has(record.id)) {
          record.due = logicalPerformanceNow() + record.delay;
          scheduleInterval(record);
        }
      }
    }, delay);
  }

  function cancelRecord(records, id, clear) {
    const record = records.get(id);
    if (!record) return false;
    if (record.nativeId !== null) clear(record.nativeId);
    records.delete(id);
    return true;
  }

  window.requestAnimationFrame = (callback) => {
    const id = state.nextId++;
    const record = { id, callback, nativeId: null };
    state.frames.set(id, record);
    scheduleFrame(record);
    return id;
  };
  window.cancelAnimationFrame = (id) => {
    cancelRecord(state.frames, id, native.cancelAnimationFrame);
  };

  window.setTimeout = (callback, delay, ...args) => {
    const id = state.nextId++;
    const record = {
      id,
      callback,
      args,
      due: logicalPerformanceNow() + Math.max(0, Number(delay) || 0),
      nativeId: null,
    };
    state.timers.set(id, record);
    scheduleTimer(record);
    return id;
  };
  window.clearTimeout = (id) => {
    cancelRecord(state.timers, id, native.clearTimeout);
    cancelRecord(state.intervals, id, native.clearInterval);
  };

  window.setInterval = (callback, delay, ...args) => {
    const id = state.nextId++;
    const interval = Math.max(1, Number(delay) || 0);
    const record = {
      id,
      callback,
      args,
      delay: interval,
      due: logicalPerformanceNow() + interval,
      nativeId: null,
    };
    state.intervals.set(id, record);
    scheduleInterval(record);
    return id;
  };
  window.clearInterval = (id) => {
    cancelRecord(state.intervals, id, native.clearInterval);
    cancelRecord(state.timers, id, native.clearTimeout);
  };

  try {
    Object.defineProperty(window.performance, 'now', {
      configurable: true,
      value: logicalPerformanceNow,
    });
  } catch {}
  try {
    Date.now = logicalDateNow;
  } catch {}

  const blockWhilePaused = (event) => {
    if (!state.paused) return;
    // Let release events through so a pause cannot leave a key or button held.
    if (event.type === 'keyup' || event.type === 'mouseup' || event.type === 'pointerup') return;
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  for (const type of [
    'keydown', 'keypress', 'mousedown', 'mousemove', 'click', 'contextmenu',
    'pointerdown', 'pointermove', 'wheel', 'touchstart', 'touchmove',
  ]) {
    window.addEventListener(type, blockWhilePaused, true);
  }

  // Chromium emits a trusted relative movement followed immediately by its
  // inverse when CDP moves a pointer-locked mouse. Games see both and the
  // camera movement cancels out. The controller arms one expected movement;
  // this early capture listener lets the trusted forward event reach the game
  // and suppresses only Chromium's matching recenter event.
  window.addEventListener('mousemove', (event) => {
    if (event.isTrusted && native.performanceNow() < state.suppressPointerMovesUntil) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    const pending = state.pointerMove;
    if (!pending || !event.isTrusted) return;
    if (native.performanceNow() > pending.deadline) {
      state.pointerMove = null;
      return;
    }
    const x = Number(event.movementX || 0);
    const y = Number(event.movementY || 0);
    if (!pending.forwardSeen && x === pending.dx && y === pending.dy) {
      pending.forwardSeen = true;
      return;
    }
    if (pending.forwardSeen && x === -pending.dx && y === -pending.dy) {
      state.pointerMove = null;
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }, true);

  function pause() {
    if (state.paused) return false;
    state.pausePerformanceNow = logicalPerformanceNow();
    state.pauseDateNow = logicalDateNow();
    state.paused = true;
    for (const record of state.frames.values()) {
      if (record.nativeId !== null) native.cancelAnimationFrame(record.nativeId);
      record.nativeId = null;
    }
    for (const record of state.timers.values()) {
      if (record.nativeId !== null) native.clearTimeout(record.nativeId);
      record.nativeId = null;
    }
    for (const record of state.intervals.values()) {
      if (record.nativeId !== null) native.clearTimeout(record.nativeId);
      record.nativeId = null;
    }
    return true;
  }

  function resume() {
    if (!state.paused) return false;
    state.performanceOffset = native.performanceNow() - state.pausePerformanceNow;
    state.dateOffset = native.dateNow() - state.pauseDateNow;
    state.paused = false;
    for (const record of state.frames.values()) scheduleFrame(record);
    for (const record of state.timers.values()) scheduleTimer(record);
    for (const record of state.intervals.values()) {
      // Do not replay every interval that elapsed during the model's turn.
      record.due = logicalPerformanceNow() + record.delay;
      scheduleInterval(record);
    }
    return true;
  }

  window[name] = {
    pause,
    resume,
    isPaused: () => state.paused,
    preparePointerMove: (dx, dy) => {
      if (!document.pointerLockElement) return false;
      state.suppressPointerMovesUntil = 0;
      state.pointerMove = {
        dx: Number(dx),
        dy: Number(dy),
        forwardSeen: false,
        deadline: native.performanceNow() + 15000,
      };
      return true;
    },
    preparePointerLock: () => {
      state.pointerMove = null;
      // Chromium may defer the lock-acquisition recenter event until the page
      // receives another rendered frame. On a paused software-rendered game,
      // that can be minutes later, after the agent has inspected the returned
      // screenshot. Keep acquisition noise blocked until the controller arms
      // the first intentional view movement, which clears this sentinel.
      state.suppressPointerMovesUntil = Number.POSITIVE_INFINITY;
      return true;
    },
  };
})();
`;

function browserPauseInitScript() {
  return BROWSER_PAUSE_INIT_SCRIPT;
}

module.exports = {
  BROWSER_PAUSE_INIT_SCRIPT,
  browserPauseInitScript,
};
