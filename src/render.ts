import { type Mino, type Tile, tetrominoes } from "@haelp/teto/engine";

export interface View {
  board: Tile[][];
  hold: Mino | null;
  queue: Mino[];
  piece?: { mino: Mino; cells: [number, number][] };
  shadow?: [number, number][];
  ghost?: { mino: Mino; cells: [number, number][] };
  tint?: "misplaced" | "finesse" | "pass";
}

const cell = 26;
/**
 * The playfield proper and the room over it. TETR.IO shows about five rows above the twenty
 * while you play -- its own window flexes with the viewport, ours does not, so this takes the
 * figure from playing it. Fixed, because a board that resizes under your hands is worse than one
 * that hides what the game hides too: of 14882 recorded placements, five rows leave seven with
 * anything cut off at all.
 */
const field = 20;
const spawnRoom = 5;
const rows = field + spawnRoom;
const panel = 5 * cell;
const previews = 5;

export const createRenderer = (canvas: HTMLCanvasElement) => {
  const ctx = canvas.getContext("2d")!;
  // Kept so the board can be redrawn at its new size when the window changes under it; the two
  // phases redraw every frame on their own, but a finished run sits still.
  let last: View | null = null;

  const draw = (view: View) => {
    last = view;
    const cols = view.board[0]?.length ?? 10;
    resize(canvas, ctx, panel * 2 + cols * cell, rows * cell);

    ctx.fillStyle = "#0c0716";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.save();
    ctx.translate(panel, 0);
    drawWell(ctx, cols);
    for (let y = 0; y < rows; y++)
      for (let x = 0; x < cols; x++) {
        const tile = view.board[y]?.[x];
        if (tile) block(ctx, x, screenY(y), colors[tile.mino] ?? "#888", 1);
      }
    for (const [x, y] of view.shadow ?? []) block(ctx, x, screenY(y), "#ffffff", 0.12);
    if (view.ghost) outline(ctx, view.ghost.cells, colors[view.ghost.mino] ?? "#888");
    if (view.piece)
      for (const [x, y] of view.piece.cells)
        block(ctx, x, screenY(y), colors[view.piece.mino] ?? "#888", 1);
    if (view.tint) {
      ctx.fillStyle =
        view.tint === "misplaced"
          ? "#ff2d5511"
          : view.tint === "finesse"
            ? "#e8822018"
            : "#3ddc8411";
      ctx.fillRect(0, 0, cols * cell, rows * cell);
    }
    ctx.restore();

    drawSlot(ctx, "HOLD", 0, 0, view.hold ? [view.hold] : []);
    drawSlot(ctx, "NEXT", panel + cols * cell, 0, view.queue.slice(0, previews));
  };

  addEventListener("resize", () => last && draw(last));
  return draw;
};

export const colors: Record<string, string> = {
  i: "#1ac3d6",
  // Zenith's pentomino, which the client lays down as plain `i` once it locks.
  i5: "#1ac3d6",
  j: "#3557d6",
  l: "#e88220",
  o: "#e5c022",
  s: "#42c451",
  t: "#a349cf",
  z: "#d63a4c",
  gb: "#635a7d",
  // Zenith's penalty line, the garbage no clear takes away. Violet rather than grey, which is how
  // the client tells it apart, lifted off its near-black so that it reads against the well.
  gbd: "#4a2c6b",
  bomb: "#ff9500"
};

/**
 * Sizes the canvas to the room the stage has for it and scales the context to match, so that
 * everything above can go on drawing in whole 26-pixel cells whatever the board ends up being.
 * Whichever of the two runs out first decides: twenty-five rows stand taller than the viewport at
 * 150% browser zoom, and a wide window with a short one is the other way about.
 */
const resize = (
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number
) => {
  const spare = room(canvas);
  const scale = Math.min(spare.width / width, spare.height / height);
  const dpr = devicePixelRatio * scale;
  if (canvas.width !== Math.round(width * dpr)) {
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.width = `${width * scale}px`;
    canvas.style.height = `${height * scale}px`;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
};

/** What is left of the stage once the readouts above and below have taken theirs. */
const room = (canvas: HTMLCanvasElement) => {
  const stage = canvas.parentElement;
  if (!stage) return { width: Infinity, height: Infinity };
  const gap = parseFloat(getComputedStyle(stage).rowGap) || 0;
  let taken = 0;
  for (const child of stage.children) {
    if (child === canvas) continue;
    // The volume toast is laid over the board rather than above it, and a hidden readout is not
    // there at all. Neither takes a row, so neither takes a gap.
    if (getComputedStyle(child).position === "absolute") continue;
    const height = (child as HTMLElement).offsetHeight;
    if (height) taken += height + gap;
  }
  return { width: stage.clientWidth, height: stage.clientHeight - taken };
};

const screenY = (y: number) => rows - 1 - y;

const drawWell = (ctx: CanvasRenderingContext2D, cols: number) => {
  ctx.fillStyle = "#1b1233";
  ctx.fillRect(0, 0, cols * cell, rows * cell);
  // The spawn rows sit above the playfield proper.
  ctx.fillStyle = "#140c26";
  ctx.fillRect(0, 0, cols * cell, spawnRoom * cell);
  ctx.strokeStyle = "#352558";
  ctx.lineWidth = 1;
  ctx.beginPath();
  // Only the playfield is ruled. The rows over it are not cells to aim at, and ruling them like the
  // rest says they are -- the darker wash alone reads as shading rather than as a different place.
  // The one line it does keep is the ceiling, which is the boundary itself.
  const ceiling = spawnRoom * cell;
  for (let x = 1; x < cols; x++) {
    ctx.moveTo(x * cell + 0.5, ceiling);
    ctx.lineTo(x * cell + 0.5, rows * cell);
  }
  for (let y = spawnRoom; y < rows; y++) {
    ctx.moveTo(0, y * cell + 0.5);
    ctx.lineTo(cols * cell, y * cell + 0.5);
  }
  ctx.stroke();
};

const block = (
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  color: string,
  alpha: number
) => {
  ctx.globalAlpha = alpha;
  ctx.fillStyle = color;
  ctx.fillRect(x * cell, y * cell, cell - 1, cell - 1);
  ctx.globalAlpha = 1;
};

const outline = (ctx: CanvasRenderingContext2D, cells: [number, number][], color: string) => {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 2;
  ctx.setLineDash([4, 3]);
  for (const [x, y] of cells) {
    ctx.globalAlpha = 0.18;
    ctx.fillRect(x * cell, screenY(y) * cell, cell - 1, cell - 1);
    ctx.globalAlpha = 0.95;
    ctx.strokeRect(x * cell + 1, screenY(y) * cell + 1, cell - 3, cell - 3);
  }
  ctx.restore();
};

const drawSlot = (
  ctx: CanvasRenderingContext2D,
  title: string,
  left: number,
  top: number,
  minos: Mino[]
) => {
  ctx.fillStyle = "#a194c4";
  ctx.font = "600 11px ui-monospace, monospace";
  ctx.fillText(title, left + 12, top + 20);
  minos.forEach((mino, i) => {
    const { w, h, data } = tetrominoes[mino].preview;
    const size = cell * 0.7;
    const x = left + (panel - w * size) / 2;
    const y = top + 34 + i * (3 * size) + (2 - h) * size * 0.5;
    ctx.fillStyle = colors[mino] ?? "#888";
    for (const [bx, by] of data) ctx.fillRect(x + bx * size, y + by * size, size - 1, size - 1);
  });
};
