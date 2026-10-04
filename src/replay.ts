import {
  type BagType,
  deepCopy,
  Engine,
  type EngineSnapshot,
  type IncomingGarbage,
  kickData,
  type Mino,
  type Rotation,
  rngMap,
  type SpinType,
  type Tile,
  tetrominoes
} from "@haelp/teto/engine";
import type { Game } from "@haelp/teto/types";
import type { Anchor } from "./anchors";

/** Options as TETR.IO writes them into a replay; fields come and go between client versions. */
export type ReplayOptions = Partial<Game.ReadyOptions> & {
  zenith?: boolean;
  zenith_expert?: boolean;
  zenith_mods?: string[];
};

export interface Round {
  label: string;
  /** Who played it. Carried apart from the label, which also numbers the game. */
  username: string;
  options: ReplayOptions;
  /** How the run ended. Both players of a league game share a seed; they do not share this. */
  tally: { pieces: number; lines: number };
  events: Game.Replay.Frame[];
  /** Frames at which a Zenith run changed floor; empty for every other mode. */
  floors: number[];
  /** Altitude a Zenith run finished at, in metres. */
  altitude: number;
}

export interface Placement {
  index: number;
  /** Frame the piece locked on. */
  frame: number;
  /** Metres climbed at that point, as Zenith counts them. */
  altitude: number;
  piece: Mino;
  rotation: Rotation;
  x: number;
  y: number;
  cells: [number, number][];
  spin: SpinType;
  /** Where the piece sat just before the rotation that placed it, for a spin. */
  spinFrom: [number, number][] | null;
  lines: number;
  usedHold: boolean;
  hold: Mino | null;
  queue: Mino[];
  /** Board the piece was about to land on: after any garbage rose, before the piece merged. */
  before: Tile[][];
  /** Board after the piece locked and lines cleared. */
  board: Tile[][];
  /** Engine state at the moment this piece spawned. */
  start: EngineSnapshot;
}

export interface Run {
  placements: Placement[];
  /** Placements cut because they depended on garbage the replay does not pin down. */
  dropped: number;
}

export interface Segment {
  start: number;
  end: number;
}

/** Collects every per-player round in a .ttr / .ttrm, whatever nesting that client version used. */
export const parseRounds = (payload: unknown): Round[] => {
  const rounds: Round[] = [];
  /** Games in the order they were played; a league match stores both players of each. */
  const games = new Map<number, number>();
  const visit = (node: unknown) => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!node || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    const options = record.options as ReplayOptions | undefined;
    if (Array.isArray(record.events) && typeof options?.seed === "number") {
      if (!games.has(options.seed)) games.set(options.seed, games.size + 1);
      const stats = (record.results as { stats?: Record<string, number> })?.stats;
      rounds.push({
        // Numbered by game rather than by where it sits in the file: a league match stores the
        // two players of a game one after the other, and counting records calls them 1 and 2.
        label: `${options.username ?? "player"} · game ${games.get(options.seed)}`,
        username: options.username ?? "player",
        options,
        tally: { pieces: stats?.piecesplaced ?? 0, lines: stats?.lines ?? 0 },
        events: record.events as Game.Replay.Frame[],
        floors: floorFrames(options, record.results),
        altitude: zenithStats(record.results)?.altitude ?? 0
      });
      return;
    }
    Object.values(record).forEach(visit);
  };
  visit(payload);
  // By game, and within one by player. A match stores the two sides of a game in the order they
  // finished it, so the file alternates and a list in that order cannot be scanned: your own
  // rounds land on odd lines in one game and even in the next.
  return rounds.sort(
    (a, b) =>
      games.get(a.options.seed!)! - games.get(b.options.seed!)! ||
      (a.options.username ?? "").localeCompare(b.options.username ?? "")
  );
};

/**
 * Which run each dump recorded. The seed narrows it down, so several replays and their dumps can
 * be loaded at once -- but in a league match both players of a game are stored under one seed,
 * and a capture is of one player's board. They are told apart by how the round ended: the last
 * state carries the piece and line count of whoever was being watched.
 *
 * A dump with no seed match at all is taken on trust when there is one of each, since a capture
 * that began after the first draw from the RNG no longer carries the seed it started from.
 */
/**
 * How far a capture's last state may sit from how the round ended, counting pieces and lines
 * together. A state is ejected every ten frames, so the real end is a piece or two beyond it.
 */
const SAME_ROUND = 12;

export const pairDumps = (rounds: Round[], dumps: Anchor[][]): Anchor[][] => {
  const owner = new Map<Anchor[], number>();
  for (const dump of dumps) {
    const seed = dump[0]?.snapshot.garbage.seed;
    const end = dump[dump.length - 1]?.snapshot.stats;
    let best = -1;
    let closest = Infinity;
    rounds.forEach((candidate, i) => {
      if (candidate.options.seed !== seed) return;
      const off =
        Math.abs((end?.pieces ?? 0) - candidate.tally.pieces) +
        Math.abs((end?.lines ?? 0) - candidate.tally.lines);
      if (off < closest) {
        closest = off;
        best = i;
      }
    });
    // A capture of a round watched only part way through ends nowhere near how that round ended,
    // and would otherwise be hung on whichever of the two players it happened to sit closer to.
    // Anchors covering a fraction of a round are worth less than none: the reconstruction keeps
    // only what lies between them, so the rest of the round would be thrown away with them.
    if (closest > SAME_ROUND) best = -1;
    if (best < 0 && dumps.length === 1 && rounds.length === 1) best = 0;
    if (best >= 0) owner.set(dump, best);
  }
  return rounds.map((_, i) => dumps.find((dump) => owner.get(dump) === i) ?? []);
};

/**
 * Replays the input stream and records what the player did with every piece.
 *
 * Garbage the replay never confirms has to be modelled by us, and a guess there moves the whole
 * board. So the run is played under every model we consider plausible and only the placements all
 * of them agree on are kept, since those provably cannot depend on the guess.
 */
export const simulate = (round: Round, anchors: Anchor[] = []): Run => {
  if (anchors.length > 1) return fromAnchors(round, anchors);

  // Confirmation says when an attack lands, not where the hole in it is -- that is the sender's
  // own RNG, and the sender is not simulated here. So a confirmed round is no more certain than
  // an unconfirmed one and goes through the same test: played both ways, trusted only as far as
  // the two agree. Without it a league round quietly invents a game -- on the match this was
  // checked against, 51 lines cleared where the player really cleared 108, the well growing to
  // thirty-eight rows of garbage nobody could clear and pieces stacked into it.
  const garbage = incomingGarbage(round);
  const placements = play(round, unconfirmedGarbage(round));
  if (!garbage.size) return { placements, dropped: 0 };

  // Stripped rather than merely unmodelled: a confirmed attack is applied by the engine from the
  // replay's own events, so leaving them in would play the same run twice and agree with itself.
  const ungarbaged = play(round, new Map(), true);
  let agreed = 0;
  while (
    agreed < Math.min(placements.length, ungarbaged.length) &&
    placementKey(placements[agreed]) === placementKey(ungarbaged[agreed])
  )
    agreed++;
  return {
    placements: placements.slice(0, agreed),
    dropped: placements.length - agreed
  };
};

/**
 * With a dump of the client's own engine states, each window between two of them can be restarted
 * from ground truth instead of reconstructed, so a wrong guess cannot travel past one window.
 *
 * What a window still has to guess is its garbage: the replay says when each attack arrived, but not
 * when its rows rose into the well. So a window that does not reproduce its end anchor outright is
 * searched -- over the holes the client recorded and over how entry was paced -- and kept whole only
 * if some guess lands on that anchor's whole state. Failing that, it is replayed under every hole
 * column the garbage could have taken and only the placements all of them agree on are kept: those
 * provably do not depend on which column was real. Garbage lands at the bottom while the player is
 * building at the top, so most of a window survives that test.
 */
const fromAnchors = (round: Round, anchors: Anchor[]): Run => {
  const engine = createEngine(round.options);
  const collected = collect(engine);
  const attacks = unconfirmedGarbage(round);
  const { frames } = groupByFrame(round.events, true);
  const entry = continuousEntry(engine);
  const paced: Pacing = {
    rate: round.options.garbageare ?? 5,
    cap: engine.garbageQueue.options.cap.max
  };

  const arrivals = new Map<string, number>();
  for (const rows of attacks.values())
    for (const row of rows) arrivals.set(`${row.gameid}:${row.cid}`, row.frame);

  /** Where a piece was placed on the climb, between the two anchors that bracket it. */
  const climbed = (from: Anchor, to: Anchor, placement: Placement) =>
    from.altitude +
    ((to.altitude - from.altitude) * (placement.frame - from.frame)) /
      Math.max(1, to.frame - from.frame);

  const restore = restorer(engine, anchors[anchors.length - 1].frame);

  const playWindow = (from: Anchor, to: Anchor, probe: Probe) => {
    restore(from.snapshot);
    engine.garbageQueue.options.garbage.speed = probe.delay;
    engine.garbageQueue.options.cap.max = probe.cap;
    collected.reset(from.snapshot);
    entry.reset(from, probe);
    for (let frame = from.frame; frame < to.frame; frame++) {
      for (const row of attacks.get(frame) ?? [])
        engine.receiveGarbage({ ...row, frame, confirmed: true });
      entry.release(frame);
      collected.sample();
      engine.tick(frames.get(frame) ?? []);
    }
    return collected.placements;
  };

  const kept: Placement[] = [];
  for (let i = 0; i < anchors.length - 1; i++) {
    const from = anchors[i];
    const to = anchors[i + 1];
    const plain: Probe = { columns: () => null, delay: phaseAt(from), ...paced };
    let window = playWindow(from, to, plain);

    let trusted = window.length;
    if (!reproduces(engine, to)) {
      // Where the replay confirms its own attacks there is nothing of ours to schedule, and the
      // only account of what landed is the board it landed on.
      const guesses = attacks.size
        ? [...onTheClock(anchors[i - 1], from, to, paced), ...attempts(from, paced)]
        : fromTheBoard(from, to, paced);
      const solved = guesses.find((probe) => {
        playWindow(from, to, probe);
        return reproduces(engine, to);
      });
      if (solved) {
        for (const placement of playWindow(from, to, solved))
          kept.push({
            ...placement,
            index: kept.length,
            altitude: climbed(from, to, placement)
          });
        continue;
      }
      // Nothing reproduced it, so nothing in it is evidence of anything.
      window = playWindow(from, to, plain);
      trusted = 0;
    }
    for (const placement of window.slice(0, trusted))
      kept.push({
        ...placement,
        index: kept.length,
        altitude: climbed(from, to, placement)
      });
  }
  // The anchors say how many pieces the client placed across the span they cover, which is the only
  // honest denominator: a window the search solved can hold a piece the plain reconstruction missed.
  const placed =
    anchors[anchors.length - 1].snapshot.stats.pieces - anchors[0].snapshot.stats.pieces;
  return { placements: kept, dropped: Math.max(0, placed - kept.length) };
};

type Columns = (() => number) | null;

/** How the engine is told to let garbage in: one row every `rate` frames, `cap` released per lock. */
interface Pacing {
  rate: number;
  cap: number;
}

/** One guess at the garbage a window took: which holes it used, and how its entry was paced. */
interface Probe extends Pacing {
  columns: () => Columns;
  delay: number;
  /** Exact frames to place rows on, when the client's own clock pins them down. */
  schedule?: number[];
  /** Duplicate-clear penalty lines the window took, each with the frame to lay it down on. */
  wounds?: Scar[];
  /** Frames on which a penalty line already standing opens, oldest first. */
  opens?: number[];
}

/** A penalty line to lay at the foot of the well, and the frame it appeared on. */
interface Scar {
  frame: number;
  row: Tile[];
}

/** Zenith's `garbagephase`: the frames one stage of an attack's countdown takes at a given floor. */
const garbagePhase = (anchor: Anchor) => 165 - 15 * anchor.floor;

/**
 * An attack runs `sleeping -> caution -> danger -> spawn`, a `garbagephase` timer on each of the
 * last two, and only `spawn` may be tanked. At floor 10 that is 30 frames against 15 and barely
 * shows; on a run that never leaves the low floors it is 300 against 150, and decides most of them.
 */
const phaseAt = (anchor: Anchor) => 2 * garbagePhase(anchor);

/**
 * The next anchor records `lasttanktime`, the frame the last garbage row entered the well, and the
 * capture records how many rows entered during the window. Continuous entry lays them down one every
 * `garbageare` frames, so a run of that many ending on that frame is fully determined and there is
 * nothing left to guess but the spacing.
 *
 * The count is only good to about a row: entry runs to the very last frame of most windows, so a row
 * queued either side of the boundary is easily booked to the wrong one. Hence the neighbouring counts,
 * which draw their overflow from the next window's rows.
 */
const onTheClock = (prev: Anchor | undefined, from: Anchor, to: Anchor, paced: Pacing): Probe[] => {
  const probes: Probe[] = [];

  // A penalty line that opens becomes a garbage row without one arriving, so it has to come back
  // off the count below. The other way round -- a line laid down -- takes nothing out of the well.
  const laid = permaRows(to.board) - permaRows(from.board);

  // How many rows the capture logged is not how many landed: a row is logged when it is tanked, and
  // an attack spends itself on those before it touches the incoming queue, so a logged row can be
  // cancelled before it ever rises. The boards say how many truly arrived.
  const landed =
    garbageRows(to.board) -
    garbageRows(from.board) +
    (to.snapshot.stats.garbage.cleared - from.snapshot.stats.garbage.cleared) +
    Math.min(0, laid);

  const frames = Array.from({ length: to.frame - from.frame }, (_, n) => from.frame + n);

  // A repeated clear drops a penalty line, and since one enters under everything the boards say
  // which line it was as well as that it appeared. All that is left to find is the frame, so cross
  // it with whatever garbage the window also took.
  const scars =
    laid > 0
      ? frames.map((frame) =>
          to.board
            .slice(0, laid)
            .reverse()
            .map((row) => ({ frame, row }))
        )
      : [[]];

  // The same for a line opening, except that the boards say nothing of which line that was: the
  // oldest goes first and the rest follow in order. Several open together as readily as one, so
  // they go down as a batch on each frame in turn.
  const opens = laid < 0 ? frames.map((frame) => new Array(-laid).fill(frame)) : [[]];

  // A window this short holds one rise, maybe two, and all that is unknown about them is the frame
  // and the hole. That is a small enough space to exhaust outright, and unlike everything below it
  // needs no help from the capture's log of tanked rows -- which is the part hardest to line up,
  // since a row is written there when it is tanked and may rise several windows later or never.
  if (landed >= 0 && landed <= 2 && to.frame - from.frame <= 2 * paced.rate) {
    const one = Array.from({ length: 10 }, (_, column) => [column]);
    const picks =
      landed === 0 ? [[]] : landed === 1 ? one : one.flatMap((a) => one.map((b) => [...a, ...b]));
    // Frame-major, so every hole is tried against the earliest frame before any is tried against a
    // later one. The frame is the part the window pins down and the hole the part it does not, and
    // searching the other way round walked the whole frame range ten times over to reach the hole.
    for (let start = from.frame; start < to.frame; start++)
      for (const rows of picks) {
        const schedule = rows.map((_, n) => start + n * paced.rate);
        if (rows.length && schedule[schedule.length - 1] >= to.frame) continue;
        for (const wound of scars)
          for (const open of opens)
            if (rows.length || wound.length || open.length)
              probes.push({
                columns: () => {
                  let next = 0;
                  return () => rows[next++] ?? 0;
                },
                delay: phaseAt(from),
                ...paced,
                schedule,
                wounds: wound,
                opens: open
              });
      }
  }

  const last = to.snapshot.garbage.lastTankTime;
  if (last <= from.frame || last >= to.frame) return probes;

  // A row is logged when it is tanked, but it rises one every `garbageare` frames afterwards, so a
  // window's rows can be ones the window before it queued. The run to try is a window into that
  // stream, not the rows this window happens to have booked.
  const stream = [...(prev?.holes ?? []), ...from.holes, ...to.holes];
  const base = prev?.holes.length ?? 0;

  // Where nothing was cleared, the rows that arrived are still sitting at the foot of the next
  // anchor's board, newest first, so their holes can be read rather than guessed at.
  const settled =
    to.snapshot.stats.garbage.cleared === from.snapshot.stats.garbage.cleared
      ? holesOf(to.board, garbageRows(to.board) - garbageRows(from.board))
      : null;

  for (const count of new Set([0, -1, 1, -2, 2, -3, 3].map((off) => landed + off)))
    for (const are of [1, 2, 3, 4, 5, 6, 7, 8, 10, 12, 15, 20, 25, 30]) {
      if (count < 1 || last - (count - 1) * are < from.frame) continue;
      const schedule = Array.from({ length: count }, (_, n) => last - (count - 1 - n) * are);
      // A row that was queued but cancelled before it rose still shows up in the capture, and
      // cancelling takes them off the front, so the rows that actually landed are the later ones.
      // Cancelling takes rows off the front of the ARE queue, so the ones that survive to rise are
      // the later ones: line these runs up with the end of what this window queued, not the start.
      const ends = new Set([
        base + from.holes.length,
        base + from.holes.length - 1,
        base + from.holes.length + 1,
        base + count,
        stream.length
      ]);
      const sources = [...ends]
        .map((end) => Math.max(0, Math.min(end, stream.length) - count))
        .map((start) => stream.slice(start, start + count));
      if (settled?.length === count) sources.unshift(settled);
      for (const rows of sources)
        probes.push({
          columns: () => {
            let next = 0;
            return () => rows[next++] ?? 0;
          },
          delay: phaseAt(from),
          ...paced,
          schedule
        });
    }
  return probes;
};

/**
 * What a window of a versus round has to account for. The attacks are the opponent's and their
 * holes come from the opponent's RNG, so neither can be worked out from this side -- but the
 * rows that landed are sitting at the foot of the next anchor's board with their holes in plain
 * sight, and ten frames leave few moments for them to have risen in. So: those rows, those
 * holes, tried against every frame of the window, as a lump and as a trickle.
 */
const fromTheBoard = (from: Anchor, to: Anchor, paced: Pacing): Probe[] => {
  const landed =
    garbageRows(to.board) -
    garbageRows(from.board) +
    (to.snapshot.stats.garbage.cleared - from.snapshot.stats.garbage.cleared);
  const holes = landed > 0 ? holesOf(to.board, landed) : [];
  if (holes.length !== landed) return [];

  const probes: Probe[] = [];
  for (let start = from.frame; start < to.frame; start++)
    for (const gap of [0, 1]) {
      const schedule = Array.from({ length: landed }, (_, n) => start + n * gap);
      if (schedule[schedule.length - 1] >= to.frame) continue;
      probes.push({
        columns: () => {
          let next = 0;
          return () => holes[next++] ?? 0;
        },
        delay: phaseAt(from),
        ...paced,
        schedule
      });
    }
  return probes;
};

/**
 * Guesses worth trying against a window the plain reconstruction missed. `garbagephase` follows
 * from the floor, but how fast rows rise and how many one lock releases do not: the client's
 * nominal figures reproduce far fewer windows than searching around them does, so they are only
 * the first guess here rather than the only one.
 */
const attempts = (from: Anchor, paced: Pacing): Probe[] => {
  const phase = phaseAt(from);
  const recorded = () => {
    let next = 0;
    return () => from.holes[next++] ?? 0;
  };
  const sources = from.holes.length ? [recorded, () => null] : [() => null];

  const probes: Probe[] = [];
  for (const delay of [phase, 5, 10, 20, 30, 40, 60, 90, 120, 150, phase - 20, phase + 20])
    for (const columns of sources)
      for (const rate of [paced.rate, 3, 16, 40])
        for (const cap of [paced.cap, 1]) probes.push({ columns, delay, rate, cap });
  return probes;
};

/**
 * Restores an engine to an anchor's snapshot. `Engine.fromSnapshot` rebuilds the difficulty ramps by
 * ticking them up from frame zero, so a restore costs as many iterations as the frame it lands on --
 * and a capture anchors every five frames, so restoring once per window makes that quadratic. On a
 * forty-thousand-frame run it comes to half a billion iterations, which is the whole cost of the
 * reconstruction. The ramps are a pure function of the frame, so they are tabulated once and the
 * engine is handed a snapshot claiming frame zero, leaving it nothing to catch up on.
 *
 * Must be built before the engine has ticked: the table is read off the engine's own ramps, which
 * are only at frame zero until then.
 */
const restorer = (engine: Engine, last: number) => {
  const ramps = Object.entries(engine.dynamic).map(([name, tracker]) => {
    const values = new Float64Array(last + 1);
    // Ticked rather than solved for, so each value is the one repeated addition actually arrives at.
    values[0] = tracker.get();
    for (let frame = 1; frame <= last; frame++) values[frame] = tracker.tick();
    return [name as keyof Engine["dynamic"], values] as const;
  });

  return (snapshot: EngineSnapshot) => {
    // Not copied first: every field the engine takes from a snapshot it takes by value or clones.
    engine.fromSnapshot({ ...snapshot, frame: 0 });
    engine.frame = snapshot.frame;
    for (const [name, values] of ramps) {
      const tracker = engine.dynamic[name];
      tracker.frame = snapshot.frame;
      tracker.set(values[snapshot.frame]);
    }
  };
};

/**
 * Zenith's duplicate-clear penalty lines are not garbage: they stand complete, and they go away on
 * a timer rather than by being cleared. Triangle.js has no unclearable line and would take one the
 * instant a piece locked beside it, so hide them from the line check and put them back afterwards.
 *
 * Wrapped before anything else is wrapped around `clearLines`, so that a board taken on the way past
 * still has its permanent lines on it.
 */
const protectWounds = (engine: Engine) => {
  const board = engine.board;
  const clearLines = board.clearLines.bind(board);
  board.clearLines = () => {
    const wounds: Tile[][] = [];
    while (board.state.length && isWound(board.state[0])) wounds.push(board.state.shift()!);
    for (const _ of wounds) board.state.push(new Array(board.width).fill(null));
    const cleared = clearLines();
    board.state.splice(board.state.length - wounds.length, wounds.length);
    board.state.unshift(...wounds);
    return cleared;
  };
};

/**
 * Zenith sets `garbageentry: "continuous"`. A lock still decides *which* rows come -- that is where
 * their hole is picked and where they stop being cancellable -- but they then rise into the well one
 * every `garbageare` frames instead of in a lump, so they land under a piece that is already falling
 * rather than all at once before it spawns.
 *
 * `columns` overrides the hole of every row that rises, so a window can be probed against each
 * choice the replay does not pin down.
 */
const continuousEntry = (engine: Engine) => {
  type Row = Parameters<Engine["board"]["insertGarbage"]>[0];
  const board = engine.board;
  const insertAtFoot = board.insertGarbage.bind(board);

  /**
   * Garbage enters `abovePerma`: a duplicate clear leaves a solid, unclearable line at the foot of
   * the well and later rows stack on top of it, not under it. Triangle.js only ever splices at the
   * very bottom, so let it build the row and then lift it over whatever is permanent.
   */
  const insert = (row: Parameters<typeof insertAtFoot>[0]) => {
    let perma = 0;
    while (perma < board.state.length && isWound(board.state[perma])) perma++;
    insertAtFoot(row);
    if (perma > 0) board.state.splice(perma, 0, board.state.splice(0, 1)[0]);
  };
  const waiting: Row[] = [];
  board.insertGarbage = (row) => void waiting.push(row);

  /**
   * The penalty for repeating a clear in all-spin: a line no clear removes, which only leaves on a
   * timer. Unlike garbage it enters under everything, the lines already standing riding up over it.
   *
   * Handed the row rather than building one, since the two modes write it differently and the anchor
   * it was read off knows which. Copied, so the simulation cannot write back into the ground truth.
   */
  const insertWound = (row: Tile[]) => {
    board.state.unshift(row.map((cell) => cell && { ...cell }));
    board.state.pop();
  };

  /**
   * What the allspin mod's penalty line comes to in the end: the garbage row it stood in for, hole
   * open where the plug was. The oldest goes first, and that is the one standing highest, later
   * lines having arrived underneath it.
   */
  const openWound = () => {
    const oldest = board.state.findLastIndex(isWound);
    board.state[oldest] = board.state[oldest].map((cell) =>
      String(cell?.mino) === "gbd" ? { mino: "gb" as Mino, connections: 0 } : null
    );
  };

  let wounds: Scar[] = [];
  let opens: number[] = [];
  let choose: Columns = null;
  let next = 0;
  let period = 0;
  let schedule: number[] | null = null;
  return {
    reset(from: Anchor, probe: Probe) {
      wounds = probe.wounds ? [...probe.wounds] : [];
      opens = probe.opens ? [...probe.opens] : [];
      choose = probe.columns();
      period = probe.rate;
      schedule = probe.schedule ? [...probe.schedule] : null;
      // Both halves of where entry had got to: rows already tanked and waiting, and the frame the
      // next of them is allowed to rise on.
      next = from.frame;
      waiting.length = 0;
    },
    release(frame: number) {
      while (wounds[0]?.frame === frame) {
        insertWound(wounds.shift()!.row);
        engine.falling.y++;
        engine.falling.highestY++;
      }
      while (opens[0] === frame) {
        opens.shift();
        openWound();
      }
      // A scripted window ignores what the engine wanted to tank and lays its rows down on the
      // clock the client recorded instead.
      if (schedule) {
        // All of the rows named for this frame, not one: a versus attack lands as a lump, where
        // Zenith trickles. A schedule naming distinct frames behaves as it always did.
        while (schedule[0] === frame) {
          schedule.shift();
          insert({
            amount: 1,
            size: 1,
            column: choose ? choose() : 0,
            bombs: false,
            isBeginning: true,
            isEnd: true
          });
          engine.falling.y++;
          engine.falling.highestY++;
        }
        return;
      }
      if (frame < next || waiting.length === 0) return;
      next = frame + period;
      const row = waiting.shift()!;
      insert({ ...row, column: choose ? choose() : row.column });
      // The well rises under a piece in mid-air; the piece keeps its place above the stack.
      engine.falling.y++;
      engine.falling.highestY++;
    }
  };
};

/**
 * A window counts as reproduced only when the engine lands on the client's whole state, not just its
 * board. Garbage that enters and is cleared again inside one window leaves the board identical while
 * the line and b2b counters still record that it happened, so the board alone accepts windows that
 * were rebuilt down the wrong path. `garbage.attack` is deliberately left out: `roundmode: "rng"`
 * rounds fractional attack off the garbage RNG, and Zenith advances that RNG for reasons a replay
 * does not show, so attack is not a function of the placements.
 */
const reproduces = (engine: Engine, anchor: Anchor) => {
  const { stats, hold, queue } = anchor.snapshot;
  // Counters before the board: six compares against a sweep of four hundred cells.
  return (
    engine.stats.pieces === stats.pieces &&
    engine.stats.lines === stats.lines &&
    engine.stats.combo === stats.combo &&
    engine.stats.b2b === stats.b2b &&
    engine.held === hold &&
    engine.queue[0] === queue.value[0] &&
    sameBoard(engine.board.state, anchor.board)
  );
};

/**
 * The hole columns of the lowest `count` garbage rows, oldest first. Garbage is inserted at the foot
 * of the well, so the newest row is the bottom one and age runs upwards from there.
 */
const holesOf = (board: Tile[][], count: number): number[] => {
  const rows: number[] = [];
  for (let y = 0; y < count && y < board.length; y++) {
    const hole = board[y].findIndex((cell) => !cell);
    if (hole < 0) return [];
    rows.unshift(hole);
  }
  return rows;
};

/**
 * A line a duplicate clear left at the foot of the well, which no clear removes and only a timer
 * takes away. The base game writes it solid `gbd`; under the allspin mod a `gb` cell plugs the hole
 * of the garbage row it stands in for. Either is a full row of nothing but garbage, which is what
 * tells them apart from the rest: a row a piece completed holds that piece.
 */
const isWound = (row: Tile[]) => row.every((cell) => ["gb", "gbd"].includes(String(cell?.mino)));

/** How many penalty lines stand at the foot of the well. */
const permaRows = (board: Tile[][]) => board.filter(isWound).length;

/** Where a piece's blocks sit on the board in a given pose, the way the engine lays them out. */
const cellsOf = (type: Mino, rotation: number, x: number, y: number): [number, number][] =>
  tetrominoes[type].matrix.data[rotation].map(([bx, by]) => [bx + x, -by + y]);

/** A copy of `board` with `cells` emptied, which is how it stood before the piece merged into it. */
const without = (board: Tile[][], cells: [number, number][]): Tile[][] => {
  const copy = deepCopy(board);
  for (const [x, y] of cells) if (copy[y]) copy[y][x] = null;
  return copy;
};

/** Rows holding garbage, which is how many arrived once clears are added back in. */
const garbageRows = (board: Tile[][]) =>
  board.filter((row) => row.some((cell) => String(cell?.mino) === "gb") && !isWound(row)).length;

/** Whether two boards hold the same minos in the same cells. */
const sameBoard = (a: Tile[][], b: Tile[][]) => {
  if (a.length !== b.length) return false;
  for (let y = 0; y < a.length; y++)
    for (let x = 0; x < a[y].length; x++) if (a[y][x]?.mino !== b[y][x]?.mino) return false;
  return true;
};

/**
 * `handled` says the attacks in the replay are ours to deliver, so the engine is not shown them.
 * Passing none under it is how a run is played as though nothing was ever sent.
 */
const play = (round: Round, garbage: GarbageByFrame, handled = garbage.size > 0): Placement[] => {
  const altitude = climb(round, groupByFrame(round.events, true).last);
  const engine = createEngine(round.options);
  const collected = collect(engine);
  const { frames, last } = groupByFrame(round.events, handled);
  for (let frame = 0; frame <= last; frame++) {
    if (round.floors.length) engine.garbageQueue.options.garbage.speed = entryDelay(round, frame);
    for (const row of garbage.get(frame) ?? [])
      engine.receiveGarbage({ ...row, frame, confirmed: true });
    collected.sample();
    engine.tick(frames.get(frame) ?? []);
  }
  return collected.placements.map((placement) => ({
    ...placement,
    altitude: altitude(placement.frame)
  }));
};

/** Whether anything stands over the piece where it came to rest, so it cannot have been dropped in. */
const covered = (cells: [number, number][], board: Tile[][]) => {
  const own = new Set(cells.map(([x, y]) => `${x},${y}`));
  return cells.some(([x, y]) => {
    for (let above = y + 1; above < board.length; above++)
      if (board[above]?.[x] && !own.has(`${x},${above}`)) return true;
    return false;
  });
};

/** Attaches the recording hooks to an engine; `reset` starts a fresh run of placements. */
const collect = (engine: Engine) => {
  let placements: Placement[] = [];
  let start = engine.snapshot();
  let usedHold = false;
  let pose: { type: Mino; x: number; y: number; rotation: number } | null = null;
  let spinFrom: [number, number][] | null = null;

  // `falling.lock.pre` fires once the piece has merged, its lines have gone and its garbage has
  // tanked, so the board a piece was aiming at has to be taken on the way past.
  const board = engine.board;
  const clearLines = board.clearLines.bind(board);
  let settled: Tile[][] = [];
  board.clearLines = () => {
    settled = deepCopy(board.state);
    return clearLines();
  };

  engine.events.on("falling.new", ({ isHold }) => {
    usedHold = isHold;
    pose = null;
    spinFrom = null;
  });
  // Fires while the locked piece is still `engine.falling`, before the next one spawns.
  engine.events.on("falling.lock.pre", () => {
    // A piece is usually rotated and dropped inside one frame, so the placing rotation has most
    // often not been seen by `sample` yet: the pose the frame opened on is where it turned from.
    if (pose && pose.type === engine.falling.symbol && pose.rotation !== engine.falling.rotation)
      spinFrom = cellsOf(pose.type, pose.rotation, pose.x, pose.y);
    const before = without(settled, engine.falling.absoluteBlocks);
    // A pose that runs through the stack was never held: re-running a window leaves the watcher
    // carrying one from a run that went differently. Better no outline than one inside the well.
    // Not "was it a spin" but "could it have been dropped here": a piece the engine scored
    // nothing for still had to be turned in under whatever is standing over it, and that is the
    // one thing the destination outline cannot say.
    const turned =
      spinFrom?.every(([x, y]) => !before[y]?.[x]) &&
      (engine.lastSpin || covered(engine.falling.absoluteBlocks, before))
        ? spinFrom
        : null;
    placements.push({
      index: placements.length,
      frame: engine.frame,
      altitude: 0,
      piece: engine.falling.symbol,
      rotation: engine.falling.rotation,
      x: engine.falling.x,
      y: engine.falling.y,
      cells: engine.falling.absoluteBlocks,
      spin: engine.lastSpin ?? "none",
      spinFrom: turned,
      lines: 0,
      usedHold,
      hold: engine.held,
      queue: engine.queue.slice(0, 5),
      before,
      board: deepCopy(engine.board.state),
      start
    });
  });
  // Taken here rather than on "falling.new": the next piece has already spawned, but the engine
  // still has bookkeeping left to do afterwards — clearing `lastSpin` among it.
  engine.events.on("falling.lock", ({ lines }) => {
    placements[placements.length - 1].lines = lines;
    start = engine.snapshot();
  });

  return {
    get placements() {
      return placements;
    },
    /**
     * Watches the falling piece for the rotation that finishes a spin. Nothing but the outcome is
     * recorded anywhere, so where the piece had to be standing to rotate into place -- the one thing
     * a spin is actually about -- has to be noticed as it goes past.
     */
    sample() {
      const falling = engine.falling;
      const y = Math.floor(falling.location[1]);
      // A rotation in the previous frame that did not lock there still shows up here.
      if (pose && pose.type === falling.symbol && pose.rotation !== falling.rotation)
        spinFrom = cellsOf(pose.type, pose.rotation, pose.x, pose.y);
      pose = {
        type: falling.symbol,
        x: falling.location[0],
        y,
        rotation: falling.rotation
      };
    },
    reset(from: EngineSnapshot) {
      // `pose` and `spinFrom` are deliberately kept: windows are five frames apart and a piece lives
      // for fifteen, so the rotation that places it usually happened in a window before the one it
      // locks in. Both belong to the falling piece and are cleared when the next one arrives.
      settled = [];
      placements = [];
      start = from;
      usedHold = false;
    }
  };
};

/**
 * Zenith rewrites its entry delay every frame as `garbagephase` — 165 - 15*floor, or 66 - 6*floor
 * on expert — rather than using the 20-frame default. The difference is most of a second per floor,
 * which is the difference between an attack landing and the player cancelling it first.
 */
const entryDelay = ({ options, floors }: Round, frame: number) => {
  let floor = 1;
  while (floor <= floors.length && floors[floor - 1] <= frame) floor++;
  return options.zenith_expert ? 66 - 6 * floor : 165 - 15 * floor;
};

/**
 * A Zenith run records the time it reached each floor. Reversed mods use a different phase table,
 * so they are left on the engine's default rather than modelled wrongly.
 */
const floorFrames = (options: ReplayOptions, results: unknown): number[] => {
  if (!options.zenith) return [];
  if (options.zenith_mods?.some((mod) => mod.includes("_reversed"))) return [];
  const splits = zenithStats(results)?.splits;
  if (!Array.isArray(splits)) return [];
  return splits.filter((ms) => typeof ms === "number").map((ms) => ms * 0.06);
};

const zenithStats = (results: unknown) =>
  (results as { stats?: { zenith?: { splits?: unknown; altitude?: number } } })?.stats?.zenith;

/** Cuts the run into segments that each end on a spin, or on `cap` pieces when no spin lands. */
export const segment = (placements: Placement[], cap: number): Segment[] => {
  const segments: Segment[] = [];
  let start = 0;

  /**
   * Cuts everything up to and including `end` into as few parts as the cap allows, sharing the
   * pieces out evenly between them: fifteen under a cap of eight is 8 and 7 rather than 8 and then
   * a stub of 7, and ten is 5 and 5 rather than 8 and 2.
   */
  const divide = (end: number) => {
    const length = end - start + 1;
    const parts = Math.ceil(length / cap);
    for (let taken = 0, n = 0; n < parts; n++) {
      const size = Math.ceil((length - taken) / (parts - n));
      segments.push({ start: start + taken, end: start + taken + size - 1 });
      taken += size;
    }
    start = end + 1;
  };

  // What a segment is built towards. A spin that took no line is not it: it scores nothing, and
  // under all-spin the engine hangs the label on any number of ordinary locks that merely happened
  // to end on a rotation. Four lines or more stands on its own -- Zenith counts a pentris as a quad.
  const notable = (index: number) => {
    const placement = placements[index];
    return (
      !!placement && ((placement.spin !== "none" && placement.lines > 0) || placement.lines >= 4)
    );
  };

  // A segment closes on the *last* of a run of them rather than on each: cutting at every one turns
  // a string of spins into a string of one-piece segments, which is no drill at all. A run too long
  // for the cap still gets divided.
  for (let i = 0; i < placements.length; i++) if (notable(i) && !notable(i + 1)) divide(i);
  if (start < placements.length) divide(placements.length - 1);
  return segments;
};

/**
 * What a placement leaves on the board: the piece, where its cells ended up and whether the engine
 * scored it as a spin. Deliberately silent about the hold slot, which is how the player got there
 * rather than what they did -- reaching a target early by holding leaves the same board behind.
 */
export const resultKey = (p: Pick<Placement, "piece" | "spin" | "cells">) =>
  `${cellKey(p)} ${p.spin}`;

/** The piece and the cells it took, which is all the board itself remembers of a placement. */
export const cellKey = (p: Pick<Placement, "piece" | "cells">) =>
  [p.piece, ...p.cells.map(([x, y]) => `${x},${y}`).sort()].join(" ");

/** The result, plus the hold slot it was reached with. */
export const placementKey = (p: Pick<Placement, "piece" | "spin" | "hold" | "cells">) =>
  `${resultKey(p)} ${p.hold ?? "-"}`;

/**
 * Whether the reference board went from this target to the next by nothing but this piece landing
 * on it. A clear shifts every row above it down and carries the combo on; a garbage row shifts the
 * whole stack up. Either one leaves the targets after it somewhere the reference never recorded,
 * which is what makes the order they are filled in part of the result rather than a matter of route.
 */
export const stackedOnto = (p: Placement, next: Placement) =>
  sameBoard(without(next.before, p.cells), p.before);

export const describe = (p: Pick<Placement, "piece" | "rotation" | "x" | "y" | "spin" | "hold">) =>
  `${p.piece.toUpperCase()} r${p.rotation} @${p.x},${p.y}` +
  (p.spin === "none" ? "" : ` ${p.spin} spin`) +
  (p.hold ? ` hold:${p.hold.toUpperCase()}` : "");

const CLEAR = ["zero", "single", "double", "triple", "quad", "penta"];

/**
 * What a placement is worth naming for: a spin that took a line, or a quad on its own. A scoreless
 * spin is left unnamed for the same reason it never ends a segment -- it is worth nothing, and
 * naming one on a segment the cap cut would credit it with a cut it did not earn.
 */
export const spinLabel = ({ piece, spin, lines }: Placement) =>
  spin !== "none" && lines > 0
    ? `${piece.toUpperCase()}-spin${spin === "mini" ? " mini" : ""} ${CLEAR[lines] ?? lines}`
    : lines >= 4
      ? `${piece.toUpperCase()} ${CLEAR[lines] ?? lines}`
      : "";

/**
 * Multiplayer is left off on purpose: incoming garbage still lands from the replay's own ige
 * frames, but the engine skips the interaction bookkeeping that needs live opponents.
 *
 * Single-player replays only store the options that differ from TETR.IO's defaults, so every
 * fallback here has to be that default rather than a Tetra League value.
 */
export const createEngine = (
  options: ReplayOptions,
  handling: Game.Handling = options.handling ?? defaultHandling
) => {
  const declared = options.bagtype ?? "7-bag";
  const bagtype = bagAliases[declared] ?? declared;
  const kickset = options.kickset ?? "SRS+";
  if (!(bagtype in rngMap))
    throw new Error(
      `bag type "${bagtype}" is not implemented by the engine, so its queue cannot be reproduced`
    );
  if (!(kickset in kickData))
    throw new Error(`kick table "${kickset}" is not implemented by the engine`);

  const engine = new Engine({
    board: {
      width: options.boardwidth ?? 10,
      height: options.boardheight ?? 20,
      buffer: options.boardbuffer ?? 20
    },
    kickTable: kickset,
    queue: { minLength: 31, seed: options.seed ?? 0, type: bagtype },
    options: {
      spinBonuses: options.spinbonuses ?? "T-spins",
      comboTable: options.combotable ?? "multiplier",
      garbageTargetBonus: options.garbagetargetbonus ?? "none",
      garbageBlocking: options.garbageblocking ?? "combo blocking",
      clutch: options.clutch ?? true,
      stock: options.stock ?? 0
    },
    gravity: {
      value: options.g ?? 0.02,
      increase: options.gincrease ?? 0,
      marginTime: options.gmargin ?? 0
    },
    garbage: {
      boardWidth: options.boardwidth ?? 10,
      cap: {
        value: options.garbagecap ?? 8,
        increase: options.garbagecapincrease ?? 0,
        marginTime: options.garbagecapmargin ?? 0,
        max: options.garbagecapmax ?? 40,
        absolute: options.garbageabsolutecap ?? 0
      },
      multiplier: {
        value: options.garbagemultiplier ?? 1,
        increase: options.garbageincrease ?? 0,
        marginTime: options.garbagemargin ?? 0
      },
      garbage: {
        speed: options.garbagespeed ?? 20,
        holeSize: options.garbageholesize ?? 1
      },
      messiness: {
        change: options.messiness_change ?? 1,
        nosame: options.messiness_nosame ?? false,
        timeout: options.messiness_timeout ?? 0,
        within: options.messiness_inner ?? 0,
        center: options.messiness_center ?? false
      },
      bombs: options.usebombs ?? false,
      seed: options.seed ?? 0,
      rounding: options.roundmode ?? "down",
      openerPhase: options.openerphase ?? 0,
      specialBonus: options.garbagespecialbonus ?? false
    },
    pc:
      options.allclears === false
        ? false
        : {
            garbage: options.allclear_garbage ?? 10,
            b2b: options.allclear_b2b ?? 0
          },
    b2b: {
      chaining: options.b2bchaining ?? false,
      charging: options.b2bcharging
        ? { at: options.b2bcharge_at ?? 4, base: options.b2bcharge_base ?? 0 }
        : false
    },
    misc: {
      movement: {
        infinite: options.infinite_movement ?? false,
        lockResets: options.lockresets ?? 15,
        lockTime: options.locktime ?? 30,
        may20G: options.gravitymay20g ?? true
      },
      allowed: {
        spin180: options.allow180 ?? false,
        hardDrop: options.allow_harddrop ?? true,
        hold: options.display_hold ?? true,
        undo: false,
        retry: false
      },
      infiniteHold: options.infinite_hold ?? false,
      stride: options.stride ?? false,
      username: options.username,
      date: new Date()
    },
    handling
  });
  protectWounds(engine);
  return engine;
};

/**
 * Zenith's bag, per TETR.IO's own `PopulateBag`, is a shuffled 7-bag plus extra pieces that only
 * appear once `cancelstreak` (its "canceling sickness" counter) reaches 20. Clearing any garbage
 * resets that counter to 0, so in ordinary play the bag never leaves plain 7-bag territory.
 */
const bagAliases: Record<string, BagType> = { zenith: "7-bag" };

const defaultHandling: Game.Handling = {
  arr: 2,
  das: 10,
  dcd: 0,
  sdf: 6,
  safelock: true,
  cancel: false,
  may20g: true,
  irs: "tap",
  ihs: "tap"
};

/** An attack plus the altitude its sender was at, which is what Zenith scales the amount by. */
type SenderGarbage = IncomingGarbage & { zthalt: number };

type GarbageByFrame = Map<number, SenderGarbage[]>;

/** Whether the replay tells the engine when each attack becomes tankable. */
const confirmsGarbage = (round: Round) =>
  round.events.some((event) => event.type === "ige" && event.data.type === "interaction_confirm");

/**
 * A versus replay confirms each attack in a later frame, which is what tells the engine when the
 * garbage becomes tankable. Single-player replays (`passthrough: "full"`) never send those, so the
 * attacks would sit in the queue forever; they are pulled out here and delivered on arrival.
 */
const unconfirmedGarbage = (round: Round): GarbageByFrame =>
  confirmsGarbage(round) ? new Map() : incomingGarbage(round);

/** Every attack the replay records, whoever is going to deliver it. */
const incomingGarbage = (round: Round): GarbageByFrame => {
  const garbage: GarbageByFrame = new Map();
  let end = 0;
  for (const event of round.events) {
    if (event.type !== "ige") continue;
    if (event.data.type !== "interaction" || event.data.data.type !== "garbage") continue;
    end = Math.max(end, event.frame);
    const { amt, size, iid, gameid } = event.data.data;
    const bucket = garbage.get(event.frame) ?? [];
    bucket.push({
      frame: event.frame,
      amount: amt,
      size,
      cid: iid,
      gameid,
      confirmed: true,
      zthalt: (event.data.data as { zthalt?: number }).zthalt ?? 0
    });
    garbage.set(event.frame, bucket);
  }
  if (!round.floors.length) return garbage;

  const altitude = climb(round, end);
  for (const rows of garbage.values())
    for (const row of rows)
      row.amount = Math.round(amplify(row.amount, row.zthalt, altitude(row.frame)));
  return garbage;
};

/** Altitude in metres at each Zenith floor boundary; a run's splits say when it crossed each one. */
const FLOOR_ALTITUDE = [0, 50, 150, 300, 450, 650, 850, 1100, 1350, 1650];

/** Interpolates a Zenith run's altitude from the floors it crossed and where it finished. */
const climb = ({ floors, altitude }: Round, end: number) => {
  const anchors: [number, number][] = [[0, 0]];
  for (const [i, frame] of floors.entries())
    anchors.push([frame, FLOOR_ALTITUDE[i + 1] ?? altitude]);
  anchors.push([Math.max(end, anchors[anchors.length - 1][0] + 1), altitude]);

  return (frame: number) => {
    for (let i = 1; i < anchors.length; i++) {
      const [f1, a1] = anchors[i];
      if (frame > f1) continue;
      const [f0, a0] = anchors[i - 1];
      return a0 + ((a1 - a0) * (frame - f0)) / Math.max(1, f1 - f0);
    }
    return altitude;
  };
};

/**
 * Zenith scales an incoming attack by how far above its sender you have climbed, which is why a
 * run's `garbage.received` runs far above the sum of its raw ige amounts — 1370 against 540 on the
 * run this was checked against. Early attacks come from senders at your own altitude and are barely
 * scaled at all, which is what decides when the first row actually lands.
 */
const amplify = (amount: number, zthalt: number, altitude: number) => {
  const sender = Math.max(Math.min(3500, zthalt), Math.min(2000, altitude - 1000));
  if (sender >= altitude) return amount;
  return amount * (1 + (0.004 * (altitude - sender) ** 2) / (altitude + sender));
};

const groupByFrame = (events: Game.Replay.Frame[], garbageHandled: boolean) => {
  const frames = new Map<number, Game.Replay.Frame[]>();
  let last = 0;
  for (const event of events) {
    if (!Number.isFinite(event.frame)) continue;
    if (event.type === "end") return { frames, last: event.frame };
    if (garbageHandled && event.type === "ige") continue;
    if (!["keydown", "keyup", "ige"].includes(event.type)) continue;
    const bucket = frames.get(event.frame);
    if (bucket) bucket.push(event);
    else frames.set(event.frame, [event]);
    last = Math.max(last, event.frame);
  }
  return { frames, last };
};
