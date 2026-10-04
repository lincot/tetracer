import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { pack } from "@haelp/teto/utils";
import { parseCaptures } from "../src/anchors.ts";
import { parseRounds } from "../src/replay.ts";

/**
 * Runs `tetrio-dump.user.js` against enough of a browser to exercise it: the replay arrives packed
 * exactly as TETR.IO packs it, the states arrive the way the client ejects them, and what the
 * script writes is read back through the trainer's own loader. The script only ever runs inside
 * the client, so a break in it is otherwise found by capturing a whole run and finding it empty.
 *
 * The button is not covered. Where it lands depends on TETR.IO's markup, which no stub predicts.
 */
const [replayPath, dumpPath] = process.argv.slice(2);
if (!replayPath) {
  console.error("usage: pnpm check-dump <bundle.json.gz> | <replay.ttr> <states.json[.gz]>");
  process.exit(1);
}

const read = (file: string) => {
  const bytes = readFileSync(file);
  return (bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes) : bytes).toString("utf8");
};

// A bundle holds both halves; before there was such a thing they were two files.
const first = JSON.parse(read(replayPath));
const replay = first.ttr ?? first;
const dump = dumpPath ? JSON.parse(read(dumpPath)) : first;
const sample = dump.states.slice(0, 400);

let saved: Blob | null = null;
const written: string[] = [];
let load: (() => void) | undefined;

class StubXHR {
  response: unknown = null;
  responseURL = "";
  addEventListener(_: string, handler: () => void) {
    load = handler;
  }
  send() {}
}

Object.assign(globalThis, {
  window: globalThis,
  // What `@require` puts there; teto ships the same build, configured by its own `theorypack`.
  msgpackr: (
    await import(`${process.cwd()}/node_modules/@haelp/teto/dist/utils/msgpackr.mjs`)
  ).default(),
  XMLHttpRequest: StubXHR,
  HTMLAnchorElement: class {},
  document: {
    createElement: () => ({
      href: "",
      download: "",
      click() {
        written.push(this.download);
      }
    }),
    querySelectorAll: () => [],
    addEventListener: () => {}
  },
  // The script watches for the replay screen forever; nothing here would ever let the process end.
  setInterval: () => 0,
  // Only the button uses these, and where the button lands is not something a stub can answer.
  addEventListener: () => {}
});
URL.createObjectURL = (blob) => {
  saved = blob as Blob;
  return "blob:stub";
};

new Function(readFileSync("public/tetrio-dump.user.js", "utf8"))();

// The client fetching the replay, packed the way TETR.IO packs it: the success envelope over a
// body with strings bundled. Wrapped under a key nobody here chose and buried a level down, so
// that the script has to find the replay rather than reach for where this test put it.
const request = new XMLHttpRequest() as unknown as StubXHR;
request.send();
request.responseURL = "https://tetr.io/api/games/8534e6ee5e86";
const packed = pack.pack({ success: true, cache: { status: "hit" }, game: { record: replay } });
request.response = packed.buffer.slice(packed.byteOffset, packed.byteOffset + packed.byteLength);
load!();

// Opening it: the client rebuilds its seekbar, ejecting a state as it goes -- every field it has,
// and the board as rows of cells -- and queues a garbage row on the way.
const client: unknown[] = [];
for (const state of sample)
  client.push({
    started: true,
    frame: state.frame,
    game: {
      ...state.game,
      board: state.game.board.map((row: string) => row.split(",").map((cell) => cell || null)),
      score: 1,
      clears: {}
    }
  });
client.push({ column: 3, size: 1, edges: 0 });

// What the button does: no name, so the script names it from the run itself.
await (globalThis as { zdump?: (name?: string) => Promise<void> }).zdump!();
if (!saved) throw new Error("no bundle was written");

// The trainer's reader, as src/main.ts runs it.
const text = await new Response(
  (saved as Blob).stream().pipeThrough(new DecompressionStream("gzip"))
).text();
const payload = JSON.parse(text) as {
  ttr?: unknown;
  captures: { states: unknown[]; garbage: unknown[] }[];
};
let dumped = false;
let captures: ReturnType<typeof parseCaptures> = [];
try {
  captures = parseCaptures(payload);
  dumped = true;
} catch {
  /* no states in it */
}
const anchors = captures[0] ?? [];
const half = payload.ttr ?? (dumped ? null : payload);
const rounds = half ? parseRounds(half) : [];

const fail = (why: string) => {
  console.error(`FAIL: ${why}`);
  process.exit(1);
};
if (!payload.ttr) fail("the replay was not unpacked from the wire");
if (anchors.length !== sample.length) fail(`${anchors.length} anchors back, ${sample.length} in`);
if (rounds.length !== 1) fail(`${rounds.length} rounds back, 1 expected`);
if (captures.length !== 1) fail(`${captures.length} captures back, 1 was simulated`);
if (payload.captures[0].garbage.length !== 1)
  fail(`${payload.captures[0].garbage.length} garbage rows back, 1 in`);
const mods = replay.replay.options.zenith_mods;
const expected =
  `${replay.users[0].username}-` +
  `${Math.floor(replay.replay.results.stats.zenith.altitude)}m-` +
  `${mods?.length ? `${mods.join("+")}-` : ""}${replay.id}.json.gz`;
if (written.at(-1) !== expected)
  fail(`bundle written as "${written.at(-1)}", wanted "${expected}"`);
if (JSON.stringify(payload.ttr) !== JSON.stringify(replay))
  fail("the unpacked replay differs from the one on the wire");
console.log(
  `ok — replay unpacked from /api/games, ${written.at(-1)} written with nothing downloaded first: ` +
    `${((saved as Blob).size / 1024).toFixed(0)}kB, ${anchors.length} anchors, ${rounds.length} round`
);
