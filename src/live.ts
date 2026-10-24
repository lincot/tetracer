import { type Engine, legal } from "@haelp/teto/engine";
import type { Game } from "@haelp/teto/types";
import type { View } from "./render";
import { type Action, actions, type Settings } from "./settings";

/** A frame of the engine's clock. A board played live is stepped in these, not in paint frames. */
export const frameMs = 1000 / 60;

/**
 * The keyboard as the engine takes it: presses of bound keys, each stamped with where inside the
 * frame it fell, handed over one frame at a time.
 */
export const keyboard = (settings: Settings): Keyboard => {
  const binds = new Map(
    actions.flatMap((a) => settings.binds[a].map((code) => [code, a] as const))
  );
  const queued: { type: "keydown" | "keyup"; key: Game.Key; at: number }[] = [];
  const down = new Set<Action>();
  return {
    press(type, event) {
      const key = binds.get(event.code);
      if (!key) return;
      event.preventDefault();
      if (type === "keyup") down.delete(key);
      else {
        // The OS repeats a held key; the engine wants the press once and tracks the hold itself.
        if (event.repeat || down.has(key)) return;
        down.add(key);
      }
      queued.push({ type, key, at: event.timeStamp || performance.now() });
    },
    drain(frame, from) {
      const frames: Game.Replay.Frame[] = [];
      while (queued.length && queued[0].at < from + frameMs) {
        const { type, key, at } = queued.shift()!;
        frames.push({ type, frame, data: { key, subframe: subframeOf(at - from) } });
      }
      return frames;
    },
    clear() {
      queued.length = 0;
      down.clear();
    }
  };
};

export interface Keyboard {
  press: (type: "keydown" | "keyup", event: KeyboardEvent) => void;
  /** The presses belonging to the frame that starts at `from`, as the engine's own events. */
  drain: (frame: number, from: number) => Game.Replay.Frame[];
  /** Forgets what is pending and what is held down, for a board that is starting over. */
  clear: () => void;
}

/** The board as the engine has it, which is as much of the view as the engine itself can say. */
export const viewOf = (engine: Engine): View => ({
  board: engine.board.state,
  height: engine.board.height,
  hold: engine.held,
  queue: engine.queue.slice(0, 5),
  piece: { mino: engine.falling.symbol, cells: engine.falling.absoluteBlocks },
  shadow: shadow(engine)
});

/**
 * Replays store subframes at one decimal, but live input keeps full precision: two keys that round
 * to the same subframe would cost the engine the sub-frame step between them.
 * Events are drained while `at < from + frameMs`, so only the lower bound needs guarding.
 */
const subframeOf = (offsetMs: number) => Math.max(0, offsetMs / frameMs);

const shadow = (engine: Engine): [number, number][] => {
  let y = engine.falling.y;
  while (legal(engine.falling.absoluteAt({ y: y - 1 }), engine.board.state)) y--;
  return engine.falling.absoluteAt({ y });
};
