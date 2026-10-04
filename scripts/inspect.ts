import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { parseCaptures } from "../src/anchors.ts";
import { pairDumps, parseRounds, segment, simulate } from "../src/replay.ts";

const path = process.argv[2];
if (!path) {
  console.error("usage: pnpm inspect <replay.ttr|.ttrm|bundle.json.gz> [states.json.gz]");
  process.exit(1);
}

/** Dumps are written gzipped; told apart by the magic bytes rather than the name. */
const read = (file: string) => {
  const bytes = readFileSync(file);
  return (bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes) : bytes).toString("utf8");
};

const file = JSON.parse(read(path));
const dump = process.argv[3];
// A bundle from the capture script holds both halves and names them; otherwise the states are a
// second file, or there are none and the run is reconstructed from the input stream alone.
const states = dump ? JSON.parse(read(dump)) : file.ttr ? file : null;
const captures = states ? parseCaptures(states) : [];
if (states)
  console.log(
    `${captures.length} capture(s) from ${dump ?? path}: ` +
      `${captures.map((c) => `${c.length} anchors`).join(", ")}`
  );
const rounds = parseRounds(file.ttr ?? file);
// A league match stores both players of a game under one seed, and a capture holds one of them.
const paired = pairDumps(rounds, captures);
console.log(`${path}\n${rounds.length} round(s)\n`);

for (const round of rounds) {
  const o = round.options;
  const kinds = new Map<string, number>();
  for (const e of round.events)
    kinds.set(
      e.type === "ige" ? `ige:${e.data.type}` : e.type,
      (kinds.get(e.type === "ige" ? `ige:${e.data.type}` : e.type) ?? 0) + 1
    );

  console.log(`── ${round.label}`);
  console.log(
    `   bag ${o.bagtype ?? "7-bag (default)"} · kicks ${o.kickset ?? "SRS+ (default)"} · spins ${o.spinbonuses ?? "T-spins (default)"}`
  );
  console.log(`   events: ${[...kinds].map(([k, n]) => `${k}=${n}`).join(" ")}`);

  // Periodic board snapshots would let the reconstruction re-sync; attack confirms would pin
  // down garbage entry. Their absence is what limits how much of a run can be trusted.
  console.log(`   board snapshots (full frames): ${kinds.get("full") ?? 0}`);
  console.log(`   garbage confirms: ${kinds.get("ige:interaction_confirm") ?? 0}`);

  try {
    const { placements, dropped } = simulate(round, paired[rounds.indexOf(round)]);
    const spins = placements.filter((p) => p.spin !== "none").length;
    console.log(
      `   trainable: ${placements.length} placements · ${segment(placements, 8).length} segments · ${spins} spins` +
        (dropped ? ` (${dropped} dropped: unverifiable garbage)` : "")
    );
  } catch (error) {
    console.log(`   trainable: none — ${(error as Error).message}`);
  }
  console.log();
}
