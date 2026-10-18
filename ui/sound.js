/**
 * Sound effects: a one-shot for things the player does, for the month
 * turning and for a stop filling up, and a quiet loop for the mode of the
 * selected line. The files live in soundfx/, credited in its Attribution.txt
 * and the README.
 *
 * Web Audio rather than <audio> elements: a loop plays back gapless, and a
 * one-shot can overlap itself. Browsers only let a page make sound after the
 * player has touched it, so nothing is loaded until the first click or key.
 * Everything is quiet by design — see AUDIO in config.js.
 */

import { AUDIO, RENDER } from '../config.js';

/** Sound files, by what they are for. */
const FILES = [
  'bulldoze', 'month', 'finances', 'stop', 'station-full',
  'new-line-bus', 'new-line-tram', 'new-line-metro', 'new-line-train', 'new-line-ferry',
  'loop-bus', 'loop-tram', 'loop-metro', 'loop-train', 'loop-ferry',
];

/**
 * Wire the game's sounds. Returns `played`, the names of the one-shots
 * played so far, and `loopMode`, the loop playing — which the browser tests
 * read.
 * @param {import('../sim/game.js').Game} game
 * @param {{signal?: AbortSignal}} [options] aborting it silences everything
 */
export function mountSound(game, { signal } = {}) {
  let context = null;
  let master = null;
  const buffers = new Map();
  const lastPlayed = new Map();
  const played = [];
  /** The loop playing: { mode, source, gain }, or null. */
  let loop = null;

  /** Start on the first touch, as browsers require, and load every file. */
  function wake() {
    if (!context) {
      context = new AudioContext();
      master = context.createGain();
      master.gain.value = AUDIO.MASTER;
      master.connect(context.destination);
      for (const name of FILES) {
        fetch(`soundfx/${name}.mp3`)
          .then((response) => response.arrayBuffer())
          .then((bytes) => context.decodeAudioData(bytes))
          .then((buffer) => buffers.set(name, buffer))
          .catch(() => {}); // A sound that will not load is simply silent.
      }
    }
    if (context.state === 'suspended' && !document.hidden) context.resume();
  }
  for (const type of ['pointerdown', 'keydown']) {
    window.addEventListener(type, wake, { capture: true, signal });
  }
  // Quiet while the tab is hidden.
  document.addEventListener('visibilitychange', () => {
    if (!context) return;
    if (document.hidden) context.suspend(); else context.resume();
  }, { signal });
  signal?.addEventListener('abort', () => { context?.close(); context = null; });

  /** Play a one-shot by name, unless the same one has only just played. */
  function play(name) {
    const buffer = buffers.get(name);
    if (!context || context.state !== 'running' || !buffer) return;
    const now = context.currentTime;
    if (now - (lastPlayed.get(name) ?? -Infinity) < AUDIO.REPEAT_GAP_S) return;
    lastPlayed.set(name, now);
    const source = context.createBufferSource();
    source.buffer = buffer;
    const gain = context.createGain();
    gain.gain.value = AUDIO.EFFECTS;
    source.connect(gain).connect(master);
    source.start();
    played.push(name);
  }

  /** Fade the selected line's loop in, or out when `mode` is null. */
  function setLoop(mode) {
    if (loop?.mode === mode) return;
    if (!context || context.state !== 'running') return;
    const buffer = mode && buffers.get(`loop-${mode}`);
    if (mode && !buffer) return; // Not loaded yet: tried again next tick.
    const now = context.currentTime;
    if (loop) {
      const { source, gain } = loop;
      gain.gain.setTargetAtTime(0, now, AUDIO.LOOP_FADE_S / 4);
      source.stop(now + AUDIO.LOOP_FADE_S * 2);
    }
    loop = null;
    if (!mode) return;
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    const gain = context.createGain();
    gain.gain.value = 0;
    gain.gain.setTargetAtTime(AUDIO.LOOPS, now, AUDIO.LOOP_FADE_S / 4);
    source.connect(gain).connect(master);
    source.start();
    loop = { mode, source, gain };
  }

  game.on('lineCreated', (line) => play(`new-line-${line.mode}`));
  game.on('stopPlaced', () => play('stop'));
  game.on('bulldozed', () => play('bulldoze'));
  game.on('financesOpened', () => play('finances'));

  // The month turning, a stop filling up, and the selected line's loop are
  // read off the game after each tick.
  let month = game.clock.month;
  /** Stops already full, so each chimes once until it empties again. */
  const full = new Set();
  let lastFullChime = -Infinity;
  game.onTick(() => {
    if (game.clock.month !== month) {
      month = game.clock.month;
      play('month');
    }

    // Full: more waiting than a stop can show, the point where it says "+N".
    let filled = false;
    for (const stop of game.network.stops.values()) {
      if (stop.waiting.length > RENDER.MAX_PASSENGER_DOTS) {
        if (!full.has(stop.id)) { full.add(stop.id); filled = true; }
      } else {
        full.delete(stop.id);
      }
    }
    if (filled && context && context.currentTime - lastFullChime >= AUDIO.FULL_STOP_GAP_S) {
      lastFullChime = context.currentTime;
      play('station-full');
    }

    const selection = game.selection;
    setLoop(selection?.segments !== undefined && game.network.lines.has(selection.id) ? selection.mode : null);
  });

  return {
    play, played,
    get loopMode() { return loop?.mode ?? null; },
    get loaded() { return [...buffers.keys()]; },
    get state() { return context?.state ?? 'asleep'; },
  };
}
