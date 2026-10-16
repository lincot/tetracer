import { deepCopy, type Engine, legal, type Tile, tetrominoes } from "@haelp/teto/engine";
import type { Game } from "@haelp/teto/types";
import { finesseFaults } from "./finesse";
import type { View } from "./render";
import {
  cellKey,
  createEngine,
  describe,
  type Placement,
  type Round,
  type Segment,
  stackedOnto
} from "./replay";
import { type Action, actions, type Settings } from "./settings";
import { clearSfx, sfx } from "./sfx";

/** `ACTION_SOFTDROP`, which the engine sets on a piece the player guided down. */
const SOFT_DROPPED = 4096;

const frameMs = 1000 / 60;
const tintMs = 260;

/**
 * Why a placement was rejected: it went somewhere else, it took more inputs than it had to, or it
 * was not played at the pace asked for.
 */
export type Fault = "misplaced" | "finesse" | "slow";

export interface SessionHandlers {
  render: (view: View) => void;
  progress: (placed: number) => void;
  fail: (fault: Fault, got: string, want: string) => void;
  pass: () => void;
}

/** The "do" phase: you play the reference queue on the reference engine and must match it piece for piece. */
export class Session {
  #engine: Engine;
  #ref: Placement[];
  #segment: Segment;
  #settings: Settings;
  #handlers: SessionHandlers;
  #binds: Map<string, Action>;

  #placed = 0;
  #verdict: "pass" | { fault: Fault; got: string; want: string } | null = null;
  #tintFault: Fault = "misplaced";
  /** Reference indices already reproduced this attempt, which need not be a prefix. */
  readonly #filled = new Set<number>();
  /** Rotations the falling piece has been given, so a kick is announced once per turn of it. */
  #turns = 0;
  /** The run's own gravity, kept so the switch can be thrown back to it. */
  readonly #fall: { base: number; increase: number; margin: number };
  /** Rows that rose under the last reference piece, owed to the next one as spawn height. */
  #risen = 0;
  /** Frame the first piece of the turn landed on, from which the pace of the rest is counted. */
  #rolling = -1;
  #queued: { type: "keydown" | "keyup"; key: Game.Key; at: number }[] = [];
  #down = new Set<Action>();
  #frameStart = 0;
  #tintUntil = 0;
  #raf = 0;

  constructor(
    round: Round,
    ref: Placement[],
    segment: Segment,
    settings: Settings,
    handlers: SessionHandlers
  ) {
    this.#ref = ref;
    this.#segment = segment;
    this.#settings = settings;
    this.#handlers = handlers;
    this.#binds = new Map(actions.map((a) => [settings.binds[a], a]));
    this.#engine = createEngine(round.options, settings.handling);
    const g = this.#engine.dynamic.gravity;
    this.#fall = { base: g.base, increase: g.increase, margin: g.margin };
    this.#engine.events.on("falling.lock.pre", () => this.#judge());
    this.#engine.events.on("falling.new", () => {
      this.#lift();
      this.#gravity();
    });
    this.restart();
  }

  start() {
    this.#frameStart = performance.now();
    this.#raf = requestAnimationFrame(this.#tick);
  }

  stop() {
    cancelAnimationFrame(this.#raf);
    this.#raf = 0;
  }

  /**
   * Gravity as the drill asks for it. Reapplied rather than set once: the run's own value comes
   * back with every snapshot restore, and the switch can be thrown in the middle of a turn.
   */
  #gravity() {
    const g = this.#engine.dynamic.gravity;
    const { base, increase, margin } = this.#settings.gravity
      ? this.#fall
      : { base: 0, increase: 0, margin: 0 };
    g.base = base;
    g.increase = increase;
    g.margin = margin;
    // Where the ramp stands at this frame, which is what the tracker would have reached on its own.
    g.set(base + (Math.max(0, g.frame - margin) * increase) / 60);
  }

  restart() {
    this.#filled.clear();
    this.#placed = 0;
    this.#verdict = null;
    this.#queued.length = 0;
    this.#down.clear();
    this.#engine.fromSnapshot(deepCopy(this.#ref[this.#segment.start].start));
    this.#gravity();
    this.#engine.input = neutral();
    // The snapshot is taken once the piece is already the falling one, by which time the original
    // player's held keys have moved and rotated it -- and under Zenith's gravity it has usually
    // dropped to the stack in the same frame. Respawn it outright rather than nudging it, or a piece
    // already resting gets slid sideways into the stack it is sitting on.
    const piece = this.#engine.falling;
    const { width, height } = this.#engine.board;
    piece.location = [
      Math.floor(width / 2 - tetrominoes[piece.symbol].matrix.w / 2),
      height + 2.04
    ];
    piece.rotation = 0;
    piece.highestY = height + 2;
    // Their inputs, not yours: the count has to start from nothing for finesse to mean anything.
    piece.keys = 0;
    // The well the reference piece actually came down on, garbage and all. Without it a target that
    // depended on a row rising mid-fall sits a row above anywhere the piece can reach.
    this.#engine.board.state = deepCopy(this.#ref[this.#segment.start].before);
    surface(piece, this.#engine.board.state);
    // Taken from the piece rather than zeroed: the snapshot carries the turns the original player
    // had already given it, and starting from nothing would hear the next one as two.
    this.#turns = piece.rotResets;
    // The opening piece is placed by hand, above the well the snapshot came with.
    this.#risen = 0;
    this.#rolling = -1;
    this.#frameStart = performance.now();
    this.#handlers.progress(0);
  }

  /**
   * Starts the new piece as high above the well as the garbage that rose under the last one. The
   * engine spawns two rows above the field whatever is underneath, which is right when the well
   * is the one the piece was thrown into and wrong when it has since been pushed up.
   *
   * Held for the whole turn rather than spent on the first piece of it: swapping to the hold
   * spawns another piece, and that one was thrown into the same well as the one it replaced.
   */
  #lift() {
    const piece = this.#engine.falling;
    piece.location[1] += this.#risen;
    piece.highestY += this.#risen;
    surface(piece, this.#engine.board.state);
  }

  keydown(event: KeyboardEvent) {
    this.#press("keydown", event);
  }

  keyup(event: KeyboardEvent) {
    this.#press("keyup", event);
  }

  #press(type: "keydown" | "keyup", event: KeyboardEvent) {
    const key = this.#binds.get(event.code);
    if (!key) return;
    event.preventDefault();
    if (type === "keyup") this.#down.delete(key);
    else {
      // The OS repeats a held key; the engine wants the press once and tracks the hold itself.
      if (event.repeat || this.#down.has(key)) return;
      this.#down.add(key);
    }
    this.#queued.push({ type, key, at: event.timeStamp || performance.now() });
  }

  #tick = (now: number) => {
    this.#raf = requestAnimationFrame(this.#tick);
    // A backgrounded tab must not be caught up in one burst of simulated frames.
    if (now - this.#frameStart > 500) this.#frameStart = now;

    while (now - this.#frameStart >= frameMs) {
      const end = this.#frameStart + frameMs;
      this.#engine.tick(this.#drain(end));
      // There is no rotation event to hook, so the count of them stands in: it rises only in the
      // engine's rotate branch, which makes every turn audible and not merely the one that first
      // reached a spin. A fall zeroes the count along with the spin itself, so a change back down
      // to nothing is the piece dropping a row rather than the player turning it.
      const turns = this.#engine.falling.rotResets;
      const spinning = (this.#engine.lastSpin ?? "none") !== "none";
      if (spinning && turns > 0 && turns !== this.#turns) sfx("twist");
      this.#turns = turns;
      this.#frameStart = end;

      if (!this.#verdict) continue;
      if (this.#verdict === "pass") {
        this.stop();
        this.#handlers.pass();
        return;
      }
      const { fault, got, want } = this.#verdict;
      this.restart();
      this.#tintUntil = now + tintMs;
      this.#tintFault = fault;
      this.#handlers.fail(fault, got, want);
      break;
    }

    this.#handlers.render(this.#view());
  };

  #drain(until: number): Game.Replay.Frame[] {
    const frames: Game.Replay.Frame[] = [];
    while (this.#queued.length && this.#queued[0].at < until) {
      const { type, key, at } = this.#queued.shift()!;
      frames.push({
        type,
        frame: this.#engine.frame,
        data: { key, subframe: subframeOf(at - this.#frameStart) }
      });
    }
    return frames;
  }

  /**
   * Runs while the locked piece is still `engine.falling`, so the board can be re-synced to the
   * reference before the next piece spawns onto it.
   */
  #judge() {
    const actual = {
      piece: this.#engine.falling.symbol,
      rotation: this.#engine.falling.rotation,
      x: this.#engine.falling.x,
      y: this.#engine.falling.y,
      spin: this.#engine.lastSpin ?? "none",
      hold: this.#engine.held,
      cells: this.#engine.falling.absoluteBlocks
    };
    // A later target will do, not merely the next one: holding a piece to place a later one first
    // reaches the same board by a different route, and a route is not what is being drilled here.
    // Only across targets the reference merely stacked, though -- past a clear or a garbage row the
    // order stops being free, and taking one early would fail on the pieces after it instead.
    const key = cellKey(actual);
    const left = this.#outstanding();
    // The spin is asked for only where the reference scored one. Under all-spin a rotation is the
    // last input before plenty of ordinary locks, and the engine scores those; the cells are the
    // same, so the board left behind is the reference's own. Failing that is failing a different
    // route to the same place, which is the one thing this is explicitly not about.
    const at = left.findIndex(
      (p) => cellKey(p) === key && (p.spin === "none" || p.spin === actual.spin)
    );
    const early = at > 0 && left.slice(0, at + 1).every((p) => this.#stacked(p));
    const expected = at === 0 || early ? left[at] : undefined;
    if (!expected) {
      sfx("misplaced");
      this.#verdict = {
        fault: "misplaced",
        got: describe(actual),
        want: describe(left[0])
      };
      return;
    }
    // The piece went where it had to; whether it got there the short way is a separate question.
    const faults = this.#settings.finesse
      ? finesseFaults({
          piece: this.#engine.falling.symbol,
          rotation: this.#engine.falling.rotation,
          column: this.#engine.falling.x + tetrominoes[this.#engine.falling.symbol].matrix.dx,
          keys: this.#engine.falling.keys,
          softDropped: !!(this.#engine.state & SOFT_DROPPED)
        })
      : 0;
    if (faults > 0) {
      sfx("finesse");
      const keys = this.#engine.falling.keys;
      this.#verdict = {
        fault: "finesse",
        got: `${keys}`,
        want: `${keys - faults}`
      };
      return;
    }
    this.#filled.add(expected.index);
    this.#placed++;
    const pace = this.#pace();
    if (this.#placed === 1) this.#rolling = this.#engine.frame;
    if (this.#settings.minPps > 0 && pace !== null && pace < this.#settings.minPps) {
      sfx("finesse");
      this.#verdict = {
        fault: "slow",
        got: pace.toFixed(2),
        want: this.#settings.minPps.toFixed(2)
      };
      return;
    }
    // Hand over the well the next piece came down on, so every target stays reachable: that carries
    // both the garbage this lock tanked and whatever rises while the next piece is falling.
    //
    // Only sound while the filled targets are the reference's own opening run -- out of order no
    // reference board describes what the player has built, so theirs is left alone. And it is the
    // end of that whole run that decides the board, not the piece just played: coming back into
    // step after placing a later target early, the piece played last is not the furthest one down.
    if (this.#inStep()) {
      const last = this.#segment.start + this.#placed - 1;
      const next = this.#ref[last + 1];
      const handed = last < this.#segment.end && next ? next.before : this.#ref[last].board;
      // Those risen rows were not there when the reference piece spawned -- they came up under it
      // while it fell -- so the next piece is given them back as height. Without it the piece
      // spawns into a well that much taller than the one the run actually threw it into, and a
      // target reached across the top of the stack can end up walled off: over the recorded runs
      // that silently makes twenty placements impossible, and with them their segments.
      this.#risen = rowsRisen(this.#ref[last].board, handed);
      this.#engine.board.state = deepCopy(handed);
    }
    // Every piece is heard, the last of the segment included. Segments are cut to end on a spin or
    // a quad, so that one is the whole point of the drill -- it used to be silenced to keep a cue
    // for finishing the segment clear of it, which muted the only placement worth hearing.
    if (expected.lines) clearSfx(expected.lines, actual.spin !== "none");
    else sfx(actual.spin === "none" ? "lock" : "spin");
    this.#handlers.progress(this.#placed);
    if (this.#placed > this.#segment.end - this.#segment.start) this.#verdict = "pass";
  }

  /**
   * Pieces a second since the first of the turn landed, or nothing while that is all there is.
   *
   * Counted from the first piece rather than from the first key: reading a board you have just
   * been handed is not playing slowly, and a rate taken over a single piece is not a rate at all
   * -- half a second of hesitation would fail a turn outright, where later the same half second
   * is averaged away by the pieces around it.
   */
  #pace() {
    if (this.#rolling < 0 || this.#placed < 2) return null;
    const seconds = (this.#engine.frame - this.#rolling) / 60;
    return seconds > 0 ? (this.#placed - 1) / seconds : null;
  }

  /**
   * Whether a target may be taken out of turn. Two things fix the order: a clear or a garbage row
   * moves every target after it (see `stackedOnto`), and a clear taken early is a different clear --
   * the lines come down on another piece, and the spin they were the point of stops being one.
   */
  #stacked(placement: Placement) {
    return placement.index === this.#segment.end
      ? placement.lines === 0
      : stackedOnto(placement, this.#ref[placement.index + 1]);
  }

  /** Whether what has been filled so far is exactly the reference's own opening run of targets. */
  #inStep() {
    for (let n = 0; n < this.#placed; n++)
      if (!this.#filled.has(this.#segment.start + n)) return false;
    return true;
  }

  /** Targets of this segment still to be filled, in reference order. */
  #outstanding() {
    const left = [];
    for (let i = this.#segment.start; i <= this.#segment.end; i++)
      if (!this.#filled.has(i)) left.push(this.#ref[i]);
    return left;
  }

  #view(): View {
    const target = this.#outstanding()[0];
    return {
      board: this.#engine.board.state,
      height: this.#engine.board.height,
      hold: this.#engine.held,
      queue: this.#engine.queue.slice(0, 5),
      piece: {
        mino: this.#engine.falling.symbol,
        cells: this.#engine.falling.absoluteBlocks
      },
      shadow: shadow(this.#engine),
      ghost:
        this.#settings.ghosts && target ? { mino: target.piece, cells: target.cells } : undefined,
      // Too slow is the same class of fault as poor finesse -- the piece went where it should --
      // and borrows its colour rather than asking for one of its own.
      tint:
        performance.now() < this.#tintUntil
          ? this.#tintFault === "slow"
            ? "finesse"
            : this.#tintFault
          : undefined
    };
  }
}

/**
 * Replays store subframes at one decimal, but live input keeps full precision: two keys that round
 * to the same subframe would cost the engine the sub-frame step between them.
 * Events are drained while `at < frameStart + frameMs`, so only the lower bound needs guarding.
 */
const subframeOf = (offsetMs: number) => Math.max(0, offsetMs / frameMs);

const shadow = (engine: Engine): [number, number][] => {
  let y = engine.falling.y;
  while (legal(engine.falling.absoluteAt({ y: y - 1 }), engine.board.state)) y--;
  return engine.falling.absoluteAt({ y });
};

/**
 * Lifts a piece until it is standing in open air. Spawn room is two rows over the field whatever
 * is underneath, so a well taller than that buries the piece where it appears: it locks on the
 * spot and the turn is lost before a key is touched. Three of the 3412 segments across the recorded
 * runs open like that, and they are unplayable without this.
 */
const surface = (piece: Engine["falling"], board: Tile[][]) => {
  while (piece.y < board.length - 1 && !legal(piece.absoluteBlocks, board)) {
    piece.location[1] += 1;
    piece.highestY += 1;
  }
};

/**
 * Garbage rows that came up between one board and the next. They enter at the foot of the well and
 * carry everything above them up, so the well is simply that many rows deeper than it was.
 */
const rowsRisen = (before: Tile[][], after: Tile[][]) => {
  const filled = (board: Tile[][]) => board.filter((row) => row.some(Boolean)).length;
  return Math.max(0, filled(after) - filled(before));
};

/** The reference snapshot carries that player's DAS charge; the trainee starts from rest. */
const neutral = (): Engine["input"] => ({
  lShift: { held: false, arr: 0, das: 0, dir: -1 },
  rShift: { held: false, arr: 0, das: 0, dir: 1 },
  lastShift: -1,
  firstInputTime: -1,
  time: { start: 0, zero: true, locked: false, prev: 0 },
  lastPieceTime: 0,
  keys: {
    softDrop: false,
    hold: false,
    rotateCW: false,
    rotateCCW: false,
    rotate180: false
  }
});
