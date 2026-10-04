import type { Game } from "@haelp/teto/types";

export type Action =
  | "moveLeft"
  | "moveRight"
  | "softDrop"
  | "hardDrop"
  | "rotateCW"
  | "rotateCCW"
  | "rotate180"
  | "hold";

export interface Settings {
  handling: Game.Handling;
  binds: Record<Action, string>;
  restart: string;
  replay: string;
  pause: string;
  ghosts: boolean;
  /** Let pieces fall on their own. Off, a piece waits where it is until you take it down. */
  gravity: boolean;
  /** Spell the three trainer keys out under the board. */
  keyHints: boolean;
  /** Cue loudness, nothing to full. */
  volume: number;
  /** How fast the demo lays pieces down, in pieces per second. */
  demoPps: number;
  /** The pace a turn must keep to count, in pieces per second; nothing asked at zero. */
  minPps: number;
  /** Fail a placement that took more inputs than it had to, the way the client counts them. */
  finesse: boolean;
  segmentCap: number;
}

export const actions: Action[] = [
  "moveLeft",
  "moveRight",
  "softDrop",
  "hardDrop",
  "rotateCCW",
  "rotateCW",
  "rotate180",
  "hold"
];

/** Bound keys that drive the trainer rather than the piece. */
export type Control = "restart" | "replay" | "pause";

export const controls: Control[] = ["restart", "replay", "pause"];

export const handlingFields = [
  { key: "das", label: "DAS", min: 0, max: 20, step: 0.1 },
  { key: "arr", label: "ARR", min: 0, max: 5, step: 0.1 },
  { key: "sdf", label: "SDF", min: 5, max: 41, step: 1 },
  { key: "dcd", label: "DCD", min: 0, max: 20, step: 0.1 }
] as const satisfies readonly {
  key: keyof Game.Handling;
  label: string;
  min: number;
  max: number;
  step: number;
}[];

export const handlingToggles = [
  { key: "safelock", label: "Prevent accidental hard drops" },
  { key: "cancel", label: "Cancel DAS on direction change" },
  { key: "may20g", label: "Allow 20G on soft drop" }
] as const satisfies readonly { key: keyof Game.Handling; label: string }[];

export const handlingModes = [
  { key: "irs", label: "IRS" },
  { key: "ihs", label: "IHS" }
] as const satisfies readonly { key: keyof Game.Handling; label: string }[];

const defaults: Settings = {
  handling: {
    arr: 0,
    das: 9,
    dcd: 0,
    // 41 is the client's sentinel for an instant soft drop rather than a multiplier.
    sdf: 41,
    safelock: true,
    cancel: false,
    may20g: true,
    irs: "tap",
    ihs: "tap"
  },
  binds: {
    moveLeft: "ArrowLeft",
    moveRight: "ArrowRight",
    softDrop: "ArrowDown",
    hardDrop: "Space",
    rotateCW: "ArrowUp",
    rotateCCW: "KeyZ",
    rotate180: "KeyA",
    hold: "ShiftLeft"
  },
  restart: "KeyR",
  replay: "KeyD",
  pause: "KeyP",
  ghosts: true,
  gravity: true,
  keyHints: true,
  volume: 0.7,
  demoPps: 1.5,
  minPps: 0,
  finesse: false,
  segmentCap: 8
};

// Still the old name: this is what every saved set of binds and handling is filed under, and
// nobody sees it.
const storageKey = "tetrio-trainer/settings";

export const settings: Settings = read();

export const save = () => localStorage.setItem(storageKey, JSON.stringify(settings));

export const bindLabel = (code: string) =>
  code
    .replace(/^Key|^Digit/, "")
    .replace(/^Arrow/, "")
    .replace(/([a-z])([A-Z])/g, "$1 $2");

function read(): Settings {
  const stored = localStorage.getItem(storageKey);
  if (!stored) return structuredClone(defaults);
  const saved = JSON.parse(stored) as Partial<Settings>;
  return {
    ...defaults,
    ...saved,
    handling: { ...defaults.handling, ...saved.handling },
    binds: { ...defaults.binds, ...saved.binds }
  };
}
