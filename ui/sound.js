/**
 * Sound effects: a one-shot for things the player does and for the month
 * turning, and a quiet loop for the mode of the selected line. The files
 * live in soundfx/, credited in its Attribution.txt and the README.
 *
 * Muting is the player's choice and is remembered in this browser, with the
 * music's (a placeholder until there is music).
 *
 * Web Audio rather than <audio> elements: a loop plays back gapless, and a
 * one-shot can overlap itself. Browsers only let a page make sound after the
 * player has touched it, so nothing is loaded until the first click or key.
 * Everything is quiet by design — see AUDIO in config.js.
 */

import { AUDIO } from '../config.js';

const PREFERENCES_KEY = 'otomig.audio';

/** The player's mute settings, or none. Storage can be missing or throw. */
function loadPreferences() {
  try { return { muted: false, musicMuted: false, ...JSON.parse(localStorage.getItem(PREFERENCES_KEY) || '{}') }; }
  catch { return { muted: false, musicMuted: false }; }
}

/** Sound files, by what they are for. */
const FILES = [
  'bulldoze', 'month', 'finances', 'stop', 'button',
  'new-line-bus', 'new-line-tram', 'new-line-metro', 'new-line-train', 'new-line-ferry',
  'loop-bus', 'loop-tram', 'loop-metro', 'loop-train', 'loop-ferry',
];

/**
 * Wire the game's sounds. Returns the mute switches, and `played` (the
 * one-shots played so far) and `loopMode` (the loop playing), which the
 * browser tests read.
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
  const preferences = loadPreferences();
  const masterLevel = () => (preferences.muted ? 0 : AUDIO.MASTER);
  function savePreferences() {
    try { localStorage.setItem(PREFERENCES_KEY, JSON.stringify(preferences)); } catch { /* not remembered */ }
  }

  /** Start on the first touch, as browsers require, and load every file. */
  function wake() {
    if (!context) {
      context = new AudioContext();
      master = context.createGain();
      master.gain.value = masterLevel();
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
  // A vehicle bought or sold, New line, Cancel. (A stop filling up rang it
  // at first, which in a big network never stopped — Alex, Oct 18 2026.)
  game.on('buttonPressed', () => play('button'));

  // The month turning and the selected line's loop are read off the game
  // after each tick.
  let month = game.clock.month;
  game.onTick(() => {
    if (game.clock.month !== month) {
      month = game.clock.month;
      play('month');
    }

    const selection = game.selection;
    setLoop(selection?.segments !== undefined && game.network.lines.has(selection.id) ? selection.mode : null);
  });

  return {
    play, played,
    get muted() { return preferences.muted; },
    /** Silence everything, or not; remembered in this browser. */
    setMuted(muted) {
      preferences.muted = muted;
      savePreferences();
      if (master) master.gain.setTargetAtTime(masterLevel(), context.currentTime, 0.05);
    },
    get musicMuted() { return preferences.musicMuted; },
    /** The music's switch: remembered, though there is no music yet. */
    setMusicMuted(muted) { preferences.musicMuted = muted; savePreferences(); },
    get loopMode() { return loop?.mode ?? null; },
    get loaded() { return [...buffers.keys()]; },
    get state() { return context?.state ?? 'asleep'; },
  };
}
