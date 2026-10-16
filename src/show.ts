import type { View } from "./render";
import type { Placement, Segment } from "./replay";
import { settings } from "./settings";
import { clearSfx, sfx } from "./sfx";

/**
 * How one piece of the demo is spent: outlined where it stood before the rotation that placed it,
 * outlined where it lands, then solid. The three keep their proportions and the whole is stretched
 * to whatever pace is asked for -- a demo that reads well at a learner's speed crawls for someone
 * who plays at four pieces a second.
 */
const beats = { turn: 320, ghost: 420, solid: 220 };
/** What a plain piece costs at the pace the beats were written for. */
const perPiece = beats.ghost + beats.solid;

/**
 * The "show" phase: steps through the reference placements of one segment. The outline is always
 * drawn here whatever the ghost setting says -- showing where the pieces go is the whole point of
 * the demo, and the setting is about whether you get that help on your own turn.
 */
export const runShow = (
  ref: Placement[],
  segment: Segment,
  height: number,
  render: (view: View) => void,
  done: () => void
) => {
  let index = segment.start;
  let stage: Stage = opening(ref[index]);
  let until = performance.now() + duration(stage);
  let raf = 0;
  let held = 0;

  const frame = (now: number) => {
    if (now >= until) {
      if (stage === "turn") {
        stage = "ghost";
        // The turn beat exists only where the piece had to be turned in, and this is that turn.
        sfx("twist");
      } else if (stage === "ghost") {
        stage = "solid";
        const placement = ref[index];
        const spin = placement.spin !== "none";
        if (placement.lines) clearSfx(placement.lines, spin);
        else sfx(spin ? "spin" : "lock");
      } else {
        if (++index > segment.end) return done();
        stage = opening(ref[index]);
      }
      until = now + duration(stage);
    }
    render(view(ref[index], stage, height));
    raf = requestAnimationFrame(frame);
  };

  raf = requestAnimationFrame(frame);
  return {
    stop: () => cancelAnimationFrame(raf),
    pause: () => {
      cancelAnimationFrame(raf);
      held = performance.now();
    },
    // The stage was due at a moment on the clock, and the clock ran on while it was held.
    resume: () => {
      until += performance.now() - held;
      raf = requestAnimationFrame(frame);
    }
  };
};

export interface Show {
  stop: () => void;
  pause: () => void;
  resume: () => void;
}

type Stage = "turn" | "ghost" | "solid";

/**
 * A piece that had to be turned into place gets an extra beat first, outlining where it stood
 * before that rotation. Seeing only the destination says nothing about how a piece got into a slot
 * it cannot be dropped into, which is the whole difficulty of the placement.
 */
const opening = (placement: Placement): Stage => (placement.spinFrom ? "turn" : "ghost");

const duration = (stage: Stage) => (beats[stage] * 1000) / settings.demoPps / perPiece;

const view = (placement: Placement, stage: Stage, height: number): View =>
  stage !== "solid"
    ? {
        board: placement.before,
        height,
        hold: placement.hold,
        queue: placement.queue,
        ghost: {
          mino: placement.piece,
          cells: (stage === "turn" && placement.spinFrom) || placement.cells
        }
      }
    : {
        board: placement.board,
        height,
        hold: placement.hold,
        queue: placement.queue,
        tint: placement.spin === "none" ? undefined : "pass"
      };
