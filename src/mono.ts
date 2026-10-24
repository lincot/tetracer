import type { Mino, Tile } from "@haelp/teto/engine";
import { frameMs, keyboard, viewOf } from "./live";
import type { View } from "./render";
import { createEngine, type ReplayOptions } from "./replay";
import type { Settings } from "./settings";
import { clearSfx, sfx } from "./sfx";

/** The well floods with the piece and drains again, and what is left behind is yours. */
const flood = 560;
const drain = 240;

/**
 * A well of one piece and nothing else, on the same engine and handling the drill is played with.
 * Nothing here is judged and nothing can be failed: the trainer is about one run's placements, and
 * this is the other thing a board is good for.
 */
export const runMono = (
  mino: Mino,
  options: ReplayOptions,
  settings: Settings,
  render: (view: View) => void
): Mono => {
  const engine = createEngine(options, settings.handling);
  const keys = keyboard(settings);

  // Every start of the well: a fresh engine spawns from the run's own bag, and a reset builds
  // itself a new queue and a new gravity tracker, so both have to be bent back each time.
  const begin = () => {
    if (!settings.gravity) {
      // Off means off, rather than merely slowed: the run's own ramp would push it back up.
      engine.dynamic.gravity.increase = 0;
      engine.dynamic.gravity.set(0);
    }
    // The engine keeps one repopulate listener, not a list, and the one being replaced only emits
    // `queue.add`, which nothing here listens for.
    engine.queue.onRepopulate(() => engine.queue.fill(mino));
    engine.queue.fill(mino);
    engine.initiatePiece(mino);
  };

  engine.events.on("falling.lock", ({ lines, spin, topout }) => {
    if (lines) clearSfx(lines, spin !== "none");
    else sfx(spin === "none" ? "lock" : "spin");
    // Nothing is being scored, so a well stacked to the ceiling is simply swept and handed back,
    // with the only cue in the place that is not telling you anything useful.
    if (topout) {
      sfx("swept");
      engine.reset();
      begin();
    }
  });

  begin();
  // The loudest thing the trainer can sound, for the one moment it is not telling you anything.
  clearSfx(4, true);

  const opened = performance.now();
  let frameStart = opened;
  let raf = 0;
  const frame = (now: number) => {
    raf = requestAnimationFrame(frame);
    const since = now - opened;
    if (since < flood + drain) {
      // The piece is not out yet, so there is nothing for a key pressed into the flood to do, and
      // the clock it would be timed against has not started either.
      keys.clear();
      frameStart = now;
      return render({
        board: wave(mino, engine.board.width, engine.board.height, level(since)),
        height: engine.board.height,
        hold: null,
        queue: engine.queue.slice(0, 5)
      });
    }
    // A backgrounded tab must not be caught up in one burst of simulated frames.
    if (now - frameStart > 500) frameStart = now;
    while (now - frameStart >= frameMs) {
      engine.tick(keys.drain(engine.frame, frameStart));
      frameStart += frameMs;
    }
    render(viewOf(engine));
  };
  raf = requestAnimationFrame(frame);

  return {
    stop: () => cancelAnimationFrame(raf),
    keydown: (event) => keys.press("keydown", event),
    keyup: (event) => keys.press("keyup", event)
  };
};

export interface Mono {
  stop: () => void;
  keydown: (event: KeyboardEvent) => void;
  keyup: (event: KeyboardEvent) => void;
}

/**
 * How full the well is: quick off the floor and settling at the brim, then let go in one fall that
 * is flat at both ends -- a drain that is still moving on its last drawn frame snaps.
 */
const level = (since: number) =>
  since < flood
    ? 1 - (1 - since / flood) ** 2
    : (1 + Math.cos((Math.PI * (since - flood)) / drain)) / 2;

/** How far behind the middle of the well the outermost column runs, as a share of the rise. */
const lag = 0.3;

/**
 * The well part-filled with the piece's own colour. The columns do not move together: each one
 * is a little behind the one inside it, so the surface rolls out from the middle of the well
 * rather than coming up as one flat slab.
 */
const wave = (mino: Mino, cols: number, rows: number, fill: number): Tile[][] => {
  const middle = (cols - 1) / 2;
  const levels = Array.from(
    { length: cols },
    (_, x) =>
      rows * Math.max(0, Math.min(1, (fill - (lag * Math.abs(x - middle)) / middle) / (1 - lag)))
  );
  return Array.from({ length: rows }, (_, y) =>
    levels.map((top) => (y < top ? { mino, connections: 0 } : null))
  );
};
