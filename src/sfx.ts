/**
 * Plays one cue. Browsers leave an audio context suspended until the page has seen a gesture, so
 * the context is built on the first cue rather than at import, and resumed on every one after.
 */
export const sfx = (sound: Sound) => play(sounds[sound]);

/**
 * The cue a landing piece earns when it took lines with it. No fixed entry covers this: the stack
 * of notes grows with the count, and a spin counts for two lines beyond the ones it took.
 */
export const clearSfx = (lines: number, spin: boolean) => play(clear(lines, spin));

/**
 * A tap on a piece, answered a rung higher each time it repeats: the ladder of fourths a clear
 * climbs, walked from the bottom, so how far a run of them has got is heard rather than counted.
 */
export const tapSfx = (step: number) => play(tap(step));

/**
 * Opens the audio device before there is anything to play. The stream pops as it opens, the way a
 * sound card does when a jack goes in, and building the context lazily puts that pop underneath the
 * first cue instead of under silence.
 */
export const warm = () => {
  audio();
};

/**
 * Sets how loud the cues are, from nothing to full. Squared on the way in: the ear hears loudness
 * roughly that way, so a slider that halves the number should sound about half as loud.
 */
export const setVolume = (level: number) => {
  volume = Math.min(1, Math.max(0, level));
  if (engine) engine.master.gain.value = volume ** 2;
};

let volume = 1;

/** Cues are named for what happened, not for how they sound. */
type Sound = "lock" | "twist" | "spin" | "finesse" | "misplaced" | "cleared" | "complete" | "swept";

interface Layer {
  hz: number;
  /** Swept to by the end of the layer. Seconds throughout, which is what Web Audio counts in. */
  to?: number;
  secs: number;
  gain: number;
  delay?: number;
  wave?: OscillatorType;
  send?: number;
  /** Fraction of peak the first quarter of the decay drops to, for a two-stage fall. */
  knee?: number;
}

/**
 * What the pieces are made of. A single tone is a hollow thing: what the ear reads as a material is
 * the set of overtones over the fundamental and how fast each of them dies. This one is a stone set
 * down on a wooden board -- a sharp contact on top, the board answering an octave under it and
 * outlasting it. Two objects rather than one, which is why it reads as something being placed
 * rather than merely struck, and it lands twice, as a small hard thing does.
 */
const stone = {
  wave: "triangle" as OscillatorType,
  /** Each overtone as [multiple of the fundamental, share of the gain, share of the ring]. */
  partials: [
    [1, 1, 0.5],
    [0.5, 0.6, 1.4],
    [3.2, 0.3, 0.25]
  ] as [number, number, number][],
  /** Multiplier on how long everything rings. */
  ring: 0.4,
  /** How much of each voice goes to the tail. */
  tail: 0.18,
  /** Fraction of peak the first quarter of the decay drops to: how hard the thing is damped. */
  knee: 0.22,
  /** How much higher than the family's note it speaks. Size is pitch: small things ring high. */
  pitch: 1.8,
  /** The rebound it gets on landing, as [seconds later, share of the gain]. */
  bounce: [0.014, 0.3] as [number, number]
};

/** A4. Every cue is built off it, so the whole family stays in tune with itself. */
const root = 440;
/** How long a voice at full length rings; everything else is a fraction of it. */
const ring = 0.15;
/**
 * How long the two arrival cues wait. They sound after the closing piece has had its own say, not
 * in place of it -- segments are cut to end on a spin or a quad, and speaking over that was what
 * made the old cue both redundant and in the way.
 */
const after = 0.38;

/**
 * One struck note, spread into the overtones the stone rings with and the rebound behind them.
 * Their gains are shared out rather than piled on, so three partials are no louder than one.
 */
const struck = (hz: number, secs: number, gain: number, delay = 0): Layer[] => {
  const total = stone.partials.reduce((sum, [, level]) => sum + level, 0);
  const pitch = hz * stone.pitch;
  const contact = (at: number, share: number): Layer[] =>
    stone.partials.map(([ratio, level, fade]) => ({
      hz: pitch * ratio,
      secs: secs * stone.ring * fade,
      gain: (gain * level * share) / total,
      delay: at,
      wave: stone.wave,
      send: stone.tail,
      knee: stone.knee
    }));
  const [gap, rebound] = stone.bounce;
  return [...contact(delay, 1), ...contact(delay + gap, rebound)];
};

/**
 * The family's ladder of fourths. A clear climbs it from step 0 (D4, G4, C5, F5); step -1 is the
 * lock's own note, and -2 sits a fourth under that. An octave below where the clears began, since
 * the top of a four-line stack was the brightest thing here and the one that read as a fanfare.
 */
const rung = (n: number) => (root / 2) * 2 ** (((n + 1) * 5) / 12);

/** Root, fifth, octave, twelfth: the perfect consonances, in the order an arrival opens them. */
const open = [1, 1.5, 2, 3];

/**
 * The two cues for finishing something, built the way the spin clear is, since that one already
 * sounds earned: notes opening one after another rather than at once, the top one held out and
 * given twice the room. What made the old ladder childish was a bright quick run up a scale, not
 * the movement itself. They step off the family's ladder of fourths on purpose, though -- two of
 * its rungs make a minor seventh, the most unresolved interval there is, and an arrival built on
 * one reads as "passed, but only just". And they open on the root rather than an octave under it:
 * a finish pitched below the clear that earned it is a deflation, however consonant.
 */
const arrival = (secs: number, levels: number[]): Layer[] => [
  ...levels.flatMap((gain, i) => {
    const last = i === levels.length - 1;
    return struck(root * open[i], last ? secs * 2 : secs, gain, after + i * 0.075).map((layer) =>
      last ? { ...layer, send: stone.tail * 2 } : layer
    );
  }),
  // An octave under the chord, not two: further down than that and it thuds instead of supporting.
  { hz: root / 2, secs, gain: 0.05, delay: after, wave: "sine" }
];

/** The half of a clear that is felt rather than heard, and it grows with the notes over it. */
const weight = (notes: number): Layer => ({
  hz: root / 4,
  secs: ring * 1.2,
  gain: 0.04 + notes * 0.012,
  wave: "sine"
});

/**
 * A spin counts for two lines beyond the ones it took. On line count alone a quad -- an I piece
 * dropped down a well -- outranked the spin double this whole drill exists to teach, which had the
 * easiest thing in the game sounding like the hardest.
 */
const clear = (lines: number, spin: boolean): Layer[] => {
  const notes = lines + (spin ? 2 : 0);
  const climb = Array.from({ length: notes }, (_, i) =>
    // Held out at the top of a spin and given twice the room, so it does not merely climb higher
    // than a quad but rings longer once it gets there.
    struck(rung(i), spin && i === notes - 1 ? ring * 2 : ring, 0.12, i * 0.055).map((layer) =>
      spin && i === notes - 1 ? { ...layer, send: stone.tail * 2 } : layer
    )
  );
  return [...climb.flat(), weight(notes)];
};

/** Harder, brighter and longer the further up it is: a climb the ear counts without being told. */
const tap = (step: number): Layer[] =>
  struck(rung(step - 1), ring * (0.4 + step * 0.2), 0.07 + step * 0.015);

// Heard several times a second where every other cue is occasional, so it is mixed well under
// them: at a shared level a cue this frequent stops being feedback and becomes a drumbeat.
const lock = struck(rung(-1), ring / 2, 0.08);

/**
 * A well filled to the ceiling and swept for it. Struck, not glided: a cue that slides down reads
 * as a joke however it is tuned. One landing heavier than any real one, and two light things
 * coming to rest after it -- the stack going over and the last of it settling. The notes over it
 * are the octave and the twelfth, not an interval with an opinion: the well is simply gone, and a
 * cue that is sour about it is a verdict on a board that keeps no score. Several low strikes in a
 * row, which is where this started, blur into one another and come out as a raspberry; there is
 * one here, and the rest is light.
 */
const swept: Layer[] = [
  ...struck(rung(-1), ring * 1.2, 0.09),
  weight(0),
  ...struck(rung(-1) * 2, ring * 0.5, 0.03, 0.04),
  ...struck(rung(-1) * 3, ring * 0.4, 0.02, 0.07)
];

const sounds: Record<Sound, Layer[]> = {
  lock,
  // The kick is recognised while the piece is still falling, and fires two and three times over
  // before the piece lands, so it sits under the lock rather than over it. Under 30ms the ear
  // takes it for a knock, not a note.
  twist: struck(rung(-2), 0.028, 0.1),
  // The lock itself and one note more: a spin is an ordinary landing that went further, not a
  // sound of its own, so it is spread from the lock rather than spelled out again beside it.
  spin: [...lock, ...struck(rung(0), ring * 0.6, 0.08, 0.05)],
  // Verdicts rather than landings, so they are glides and stay outside the material entirely --
  // nothing was struck, and they should not sound as though something was.
  finesse: [{ hz: root, to: 392, secs: ring * 0.8, gain: 0.11, send: stone.tail }],
  misplaced: [{ hz: root / 2, to: root / 4, secs: ring * 2, gain: 0.14, send: stone.tail }],
  cleared: arrival(ring * 1.6, [0.075, 0.07, 0.065]),
  // The same arrival opened one note wider and held longer, for the end of a whole run.
  complete: arrival(ring * 2.4, [0.085, 0.08, 0.075, 0.06]),
  swept
};

interface Engine {
  ctx: AudioContext;
  wet: GainNode;
  master: GainNode;
}

let engine: Engine | undefined;

const play = (layers: Layer[]) => {
  if (!volume) return;
  const ready = audio();
  // Lookahead the audio thread reads the schedule within. The session ticks the engine and paints
  // the canvas between cues, and a frame that runs long can spend this before the schedule is read:
  // then every ramp below lands in the past and collapses, turning the attack into a step.
  const at = ready.ctx.currentTime + 0.03;
  for (const layer of layers) emit(ready, layer, at);
};

const audio = () => {
  if (!engine) {
    const ctx = new AudioContext();

    // A small room, synthesised: noise fading out over 600ms is all a convolver needs for a tail.
    const convolver = ctx.createConvolver();
    const length = Math.floor(ctx.sampleRate * 0.6);
    const impulse = ctx.createBuffer(2, length, ctx.sampleRate);
    for (let channel = 0; channel < 2; channel++) {
      const decay = impulse.getChannelData(channel);
      for (let i = 0; i < length; i++) decay[i] = (Math.random() * 2 - 1) * (1 - i / length) ** 3;
    }
    const master = ctx.createGain();
    master.gain.value = volume ** 2;
    master.connect(ctx.destination);

    convolver.buffer = impulse;
    const wet = ctx.createGain();
    wet.connect(convolver).connect(master);

    // Held open for as long as the page lives. After a couple of hundred milliseconds of digital
    // silence the output device drops into a low-power state, and coming back out of it ramps
    // whatever it is handed first, eating the attack -- which is why a piece placed after a pause
    // landed soft where the same one mid-run landed hard. This never lets the output reach true
    // silence, so the device never idles and nothing has to be scheduled ahead of a cue to wake it.
    // 25Hz at -72dB is below the ear's threshold twice over: far under it in level, and at a pitch
    // where that threshold is some 60dB higher again. Wired past the volume on purpose -- turned
    // down to nothing it would stop holding the device open, and the first cue after turning the
    // sound back up would land soft.
    const awake = ctx.createGain();
    awake.gain.value = 0.00025;
    awake.connect(ctx.destination);
    const hum = ctx.createOscillator();
    hum.frequency.value = 25;
    hum.connect(awake);
    hum.start();

    engine = { ctx, wet, master };
  }
  if (engine.ctx.state === "suspended") engine.ctx.resume();
  return engine;
};

const emit = ({ ctx, wet, master }: Engine, layer: Layer, at: number) => {
  const start = at + (layer.delay ?? 0);
  const end = start + layer.secs;

  const gain = ctx.createGain();
  // Silent from birth, not merely from `start`: a gain node is created at 1, and should the
  // schedule below ever land in the past the source would open into a node still sitting at full.
  gain.gain.value = 0.0001;
  // Ramped up from near-silence rather than set outright, which clicks.
  const attack = Math.min(0.005, layer.secs / 4);
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(layer.gain, start + attack);
  if (layer.knee)
    gain.gain.exponentialRampToValueAtTime(
      layer.gain * layer.knee,
      start + attack + (layer.secs - attack) / 4
    );
  gain.gain.exponentialRampToValueAtTime(0.0001, end);
  gain.connect(master);
  if (layer.send) {
    const bus = ctx.createGain();
    bus.gain.value = layer.send;
    gain.connect(bus).connect(wet);
  }

  const source = ctx.createOscillator();
  source.type = layer.wave ?? "triangle";
  source.frequency.setValueAtTime(layer.hz, start);
  if (layer.to) source.frequency.exponentialRampToValueAtTime(layer.to, end);
  source.connect(gain);
  source.start(start);
  source.stop(end);
};
