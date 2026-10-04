import {
  type EngineSnapshot,
  type Mino,
  type SpinType,
  type Tile,
  tetrominoes
} from "@haelp/teto/engine";

/**
 * A complete engine state, ejected by TETR.IO's own client while it re-simulates a replay.
 * Ground truth: the run can be restarted from one of these rather than reconstructed.
 */
export interface Anchor {
  frame: number;
  floor: number;
  altitude: number;
  board: Tile[][];
  snapshot: EngineSnapshot;
  /** Hole columns of the garbage rows that land during the window starting here, in order. */
  holes: number[];
}

/**
 * Every run a capture holds. The client re-simulates a replay each time one is opened, so a
 * league match watched through leaves one of these per round -- it is `captures` that carries
 * them. A file written before that, or a bare array of states, is the one run it recorded.
 */
export const parseCaptures = (payload: any): Anchor[][] => {
  const held = Array.isArray(payload?.captures)
    ? payload.captures
    : [Array.isArray(payload) ? { states: payload } : payload];
  if (!held.length || !Array.isArray(held[0]?.states) || !held[0].states[0]?.game?.board)
    throw new Error("not a TETR.IO state dump");
  return held.map(({ states, garbage }: { states: any[]; garbage?: any[] }) => {
    const anchors = states.map(toAnchor).sort((a, b) => a.frame - b.frame);
    // A row queued while `n` states had been captured belongs to the window starting at anchor n-1.
    for (const row of garbage ?? []) anchors[row.after - 1]?.holes.push(row.column);
    return anchors;
  });
};

/**
 * Whether the falling piece is currently sitting in a spin, which TETR.IO keeps as bits on the
 * piece's flags and Triangle.js keeps as `lastSpin`. It is set when a piece rotates and survives
 * until it moves, so an anchor taken between the rotation and the lock has to carry it: without it
 * the piece locks as a plain placement and the spin is lost.
 *
 * The client reads the same two bits, and a mini needs both of them:
 *   IsSpin()     -> flags & ROTATION_SPIN
 *   IsSpinMini() -> !(~flags & (ROTATION_SPIN | ROTATION_MINI))
 */
const ROTATION_SPIN = 8;
const ROTATION_MINI = 16;

const spinOf = (flags: number): SpinType | null => {
  if ((flags & (ROTATION_SPIN | ROTATION_MINI)) === (ROTATION_SPIN | ROTATION_MINI)) return "mini";
  return flags & ROTATION_SPIN ? "normal" : null;
};

/**
 * TETR.IO indexes rows from the top; Triangle.js indexes them from the bottom. A row arrives either
 * as its cells or, from a capture that packed them, as one comma-separated string.
 */
const toBoard = (rows: ((string | null)[] | string)[]): Tile[][] =>
  rows
    .map((row) =>
      (typeof row === "string" ? row.split(",") : row).map((cell) =>
        cell ? { mino: cell as Mino, connections: 0 } : null
      )
    )
    .reverse();

const toAnchor = (state: any): Anchor => {
  const g = state.game;
  const board = toBoard(g.board);
  const bag = {
    rng: g.rng,
    id: g.bagid,
    extra: [...(g.bagex ?? [])],
    lastGenerated: g.lastGenerated ?? null
  };
  return {
    frame: state.frame,
    floor: g.stats?.zenith?.floor || 1,
    altitude: g.stats?.zenith?.altitude || 0,
    board,
    holes: [],
    snapshot: {
      __meta: { isUndoRedo: false },
      frame: state.frame,
      subframe: g.subframe ?? 0,
      queue: { value: [...g.bag], bag },
      _queue: { value: [...g.bag], bag: { ...bag } },
      hold: g.hold ?? null,
      holdLocked: !!g.holdlocked,
      input: {
        lShift: {
          held: !!g.lShift?.held,
          arr: g.lShift?.arr ?? 0,
          das: g.lShift?.das ?? 0,
          dir: -1
        },
        rShift: {
          held: !!g.rShift?.held,
          arr: g.rShift?.arr ?? 0,
          das: g.rShift?.das ?? 0,
          dir: 1
        },
        lastShift: g.lastshift ?? -1,
        firstInputTime: g.firstInputTime ?? -1,
        time: { start: 0, zero: true, locked: false, prev: 0 },
        lastPieceTime: g.lastpiecetime ?? 0,
        keys: {
          softDrop: !!g.inputSoftdrop,
          hold: !!g.inputHold,
          rotateCW: !!g.inputRotateCW,
          rotateCCW: !!g.inputRotateCCW,
          rotate180: !!g.inputRotate180
        }
      },
      falling: fallingOf(g, board.length),
      lastSpin: spinOf(g.falling?.flags ?? 0),
      lastWasClear: !!g.lastwasclear,
      garbage: {
        seed: g.rngex,
        lastTankTime: g.lasttanktime ?? 0,
        lastColumn: g.lastcolumn ?? null,
        sent: g.stats?.garbage?.sent ?? 0,
        hasChangedColumn: !!g.haschangedcolumn,
        lastReceivedCount: g.lastreceivedcount ?? 0,
        queue: []
      },
      board,
      stats: {
        garbage: {
          sent: g.stats.garbage.sent ?? 0,
          attack: g.stats.garbage.attack ?? 0,
          receive: g.stats.garbage.received ?? 0,
          cleared: g.stats.garbage.cleared ?? 0
        },
        // TETR.IO counts no combo as 0 where Triangle.js counts it as -1.
        combo: (g.stats.combo ?? 0) - 1,
        b2b: (g.stats.btb ?? 0) - 1,
        pieces: g.stats.piecesplaced ?? 0,
        lines: g.stats.lines ?? 0
      },
      glock: g.glock ?? 0,
      stock: g.stock ?? 0,
      state: g.falling?.flags ?? 0,
      spike: { count: g.spike?.count ?? 0, timer: g.spike?.timer ?? 0 },
      time: { frameOffset: 0 },
      ige: { iid: 0, players: {} },
      resCache: { pieces: 0, garbage: { sent: [], received: [] }, keys: [], lastLock: 0 },
      practice: { undo: [], redo: [], retry: false, retryIter: 0, lastPiece: null }
    } as EngineSnapshot
  };
};

/**
 * TETR.IO stores the falling piece top-origin and anchored on its matrix offset; Triangle.js
 * stores it bottom-origin from the matrix corner.
 */
const fallingOf = (g: any, height: number) => {
  const { dx, dy } = tetrominoes[g.falling.type].matrix;
  const top = height - 1;
  return {
    symbol: g.falling.type,
    location: [g.falling.x - dx, top - g.falling.y + dy] as [number, number],
    locking: g.falling.locking ?? 0,
    lockResets: g.falling.lockresets ?? 0,
    rotResets: g.falling.rotresets ?? 0,
    safeLock: g.falling.safelock ?? 0,
    highestY: top - (g.falling.hy ?? g.falling.y) + dy,
    rotation: g.falling.r ?? 0,
    fallingRotations: 0,
    totalRotations: g.totalRotations ?? 0,
    irs: g.falling.irs ?? 0,
    ihs: false,
    aox: 0,
    aoy: 0,
    keys: g.falling.keys ?? 0
  };
};
