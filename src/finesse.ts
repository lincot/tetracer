import type { Mino, Rotation } from "@haelp/teto/engine";

/**
 * The fewest key presses each placement can be reached in, as TETR.IO's own table has it: indexed by
 * piece, then rotation, then the column the piece ends in offset by one, since a piece may sit one
 * step off the left edge. A 9 marks a placement the table does not reach.
 */
// biome-ignore format: a table, one line per piece and one bracketed row per rotation
const MINIMUM: Partial<Record<Mino, number[][]>> = {
  i: [[9, 9, 1, 2, 1, 0, 1, 2, 1, 9, 9], [2, 2, 2, 2, 1, 1, 2, 2, 2, 2, 9], [9, 9, 1, 2, 1, 0, 1, 2, 1, 9, 9], [9, 2, 2, 2, 2, 1, 1, 2, 2, 2, 2]],
  j: [[9, 9, 1, 2, 1, 0, 1, 2, 2, 1, 9], [9, 2, 2, 3, 2, 1, 2, 3, 3, 2, 9], [9, 9, 3, 4, 3, 2, 3, 4, 4, 3, 9], [9, 9, 2, 3, 2, 1, 2, 3, 3, 2, 2]],
  l: [[9, 9, 1, 2, 1, 0, 1, 2, 2, 1, 9], [9, 2, 2, 3, 2, 1, 2, 3, 3, 2, 9], [9, 9, 3, 4, 3, 2, 3, 4, 4, 3, 9], [9, 9, 2, 3, 2, 1, 2, 3, 3, 2, 2]],
  o: [[9, 1, 2, 2, 1, 0, 1, 2, 2, 1, 9], [9, 1, 2, 2, 1, 0, 1, 2, 2, 1, 9], [9, 1, 2, 2, 1, 0, 1, 2, 2, 1, 9], [9, 1, 2, 2, 1, 0, 1, 2, 2, 1, 9]],
  s: [[9, 9, 1, 2, 1, 0, 1, 2, 2, 1, 9], [9, 2, 2, 2, 1, 1, 2, 3, 2, 2, 9], [9, 9, 1, 2, 1, 0, 1, 2, 2, 1, 9], [9, 9, 2, 2, 2, 1, 1, 2, 3, 2, 2]],
  t: [[9, 9, 1, 2, 1, 0, 1, 2, 2, 1, 9], [9, 2, 2, 3, 2, 1, 2, 3, 3, 2, 9], [9, 9, 3, 4, 3, 2, 3, 4, 4, 3, 9], [9, 9, 2, 3, 2, 1, 2, 3, 3, 2, 2]],
  z: [[9, 9, 1, 2, 1, 0, 1, 2, 2, 1, 9], [9, 2, 2, 2, 1, 1, 2, 3, 2, 2, 9], [9, 9, 1, 2, 1, 0, 1, 2, 2, 1, 9], [9, 9, 2, 2, 2, 1, 1, 2, 3, 2, 2]]
};

export interface Attempt {
  piece: Mino;
  rotation: Rotation;
  /** Column of the piece's matrix, the origin TETR.IO counts from. */
  column: number;
  /** Movements and rotations spent on the piece; a 180 counts as two. */
  keys: number;
  /** Soft dropping is not judged, so a piece guided down is never at fault. */
  softDropped: boolean;
}

/**
 * How many key presses beyond the minimum a placement took. Mirrors the client's `_InternalFinesse`,
 * including its exemption for soft drops.
 */
export const finesseFaults = ({ piece, rotation, column, keys, softDropped }: Attempt) => {
  const rows = MINIMUM[piece];
  // Zenith's pentomino has no row of its own, and a piece the table cannot be read for is left
  // unjudged rather than charged for every input -- the client reads the same table the same way.
  if (softDropped || !rows) return 0;
  return Math.max(0, keys - (rows[rotation]?.[column + 1] ?? 0));
};
