import "./style.css";
import type { Mino } from "@haelp/teto/engine";
import { type Anchor, parseCaptures } from "./anchors";
import { type Mono, runMono } from "./mono";
import { createRenderer } from "./render";
import {
  fieldHeight,
  type Placement,
  pairDumps,
  parseRounds,
  type Round,
  type Segment,
  segment,
  simulate,
  spinLabel
} from "./replay";
import { Session } from "./session";
import {
  type Action,
  actions,
  bindLabel,
  type Control,
  controls,
  handlingFields,
  handlingModes,
  handlingToggles,
  save,
  settings
} from "./settings";
import { setVolume, sfx, tapSfx, warm } from "./sfx";
import { runShow, type Show } from "./show";

const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const fileInput = el<HTMLInputElement>("file");
const presetSelect = el<HTMLSelectElement>("preset");
const roundSelect = el<HTMLSelectElement>("round");
const capInput = el<HTMLInputElement>("cap");
const ghostsInput = el<HTMLInputElement>("ghosts");
const finesseInput = el<HTMLInputElement>("finesse");
const gravityInput = el<HTMLInputElement>("gravity");
const paceInput = el<HTMLInputElement>("pace");
const demoInput = el<HTMLInputElement>("demo");
const configButton = el<HTMLButtonElement>("config");
const segmentList = el<HTMLElement>("segments");
const altitude = el<HTMLElement>("altitude");
const mods = el<HTMLElement>("mods");
const run = el<HTMLElement>("run");
const status = el<HTMLParagraphElement>("status");
const stage = el<HTMLElement>("stage");
const level = el<HTMLElement>("level");
const keys = el<HTMLElement>("keys");
const guide = el<HTMLElement>("guide");
// Where this one's source lives. The markup carries the address, an anchor being a link before any
// of this runs; a fork points VITE_GITHUB at its own, and setting it empty takes the link off.
const repo = import.meta.env.VITE_GITHUB;
if (repo !== "") {
  const source = el<HTMLAnchorElement>("source");
  if (repo) source.href = repo;
  source.hidden = false;
}

const dialog = el<HTMLDialogElement>("settings");
// A click on the backdrop is reported against the dialog itself, there being no element behind it
// to catch it. Which means the dialog's own padding reports the same way, so the point decides:
// inside the box it is a miss, outside it is the way out. Clicks on the fields within land on
// those fields, and a field reached by keyboard never reports a point at all.
dialog.addEventListener("click", (event) => {
  if (event.target !== dialog) return;
  const box = dialog.getBoundingClientRect();
  const outside =
    event.clientX < box.left ||
    event.clientX > box.right ||
    event.clientY < box.top ||
    event.clientY > box.bottom;
  if (outside) dialog.close();
});

const board = el<HTMLCanvasElement>("board");
const { draw: render, pick } = createRenderer(board);

let rounds: Round[] = [];
let dumps: Anchor[][] = [];
let anchors: Anchor[] = [];
/** The dump that recorded each round, worked out once the whole load is in. */
let paired: Anchor[][] = [];

let round: Round | null = null;
let placements: Placement[] = [];
let segments: Segment[] = [];
let current = 0;
/** Segments the player has actually cleared, which since any segment can be picked is not a prefix. */
const cleared = new Set<number>();
let trimmed = 0;
let session: Session | null = null;
let show_: Show | null = null;
let mono_: Mono | null = null;
/** What the status bar was saying before the pause, to be put back when play resumes. */
let held: { text: string; tone: string } | null = null;
/** Key that skipped a demo, held until its release so the turn does not inherit a stray keyup. */
let skipped: string | null = null;
let advance: ReturnType<typeof setTimeout> | undefined;

/**
 * The keys, spelled out under the board. Nothing on the page presses them for you -- a drill is
 * played with both hands on the keyboard, and a button for each would only sit there unused --
 * so this is the one place their existence is written down, and it follows a rebinding.
 */
function drawKeys() {
  // Nothing to press them on yet, or asked for out of the way.
  keys.hidden = !segments.length || !settings.keyHints;
  keys.replaceChildren(
    ...(
      [
        [settings.replay, "replay demo"],
        [settings.pause, "pause"],
        [settings.restart, "restart"]
      ] as const
    ).flatMap(([codes, what]) => [
      ...codes.map((code) =>
        Object.assign(document.createElement("kbd"), { textContent: bindLabel(code) })
      ),
      Object.assign(document.createElement("span"), { textContent: what })
    ])
  );
}

/**
 * The runs that ship with the trainer, so there is something to drill before you have captured
 * anything of your own. Found at build time from what is in `replays/`, and named from the file:
 * the capture script writes who climbed, how far, what the tower was set to, and the id it can be
 * found under again. Read off the name rather than the file so that picking one is still the only
 * thing that fetches six megabytes.
 */
const shipped = import.meta.glob("../replays/*.json.gz", {
  query: "?url",
  eager: true,
  import: "default"
}) as Record<string, string>;

presetSelect.replaceChildren(
  new Option("Pick a sample run…", ""),
  ...Object.entries(shipped)
    .map(([path, url]) => {
      const [, who, metres, mods] =
        /\/([^/]+?)-(\d+)m-(?:([^/]+)-)?[0-9a-f]{6,}\.json\.gz$/.exec(path) ?? [];
      return { url, who: who ?? path, metres: Number(metres ?? 0), mods };
    })
    .sort((a, b) => a.who.localeCompare(b.who) || b.metres - a.metres)
    .map(
      ({ url, who, metres, mods }) =>
        new Option(`${who} · ${metres}m${mods ? ` · ${mods.split("+").join(", ")}` : ""}`, url)
    )
);

capInput.value = String(settings.segmentCap);
drawKeys();
ghostsInput.checked = settings.ghosts;
finesseInput.checked = settings.finesse;
gravityInput.checked = settings.gravity;
paceInput.value = String(settings.minPps);
demoInput.value = String(settings.demoPps);
setVolume(settings.volume);
roundSelect.hidden = true;
say("Load a replay saved from the replay viewer, or pick a sample run.");

/** A file to read, whichever way it arrived: picked by hand or fetched from the ones shipped. */
interface Source {
  name: string;
  blob: Blob;
}

async function load(sources: Source[]) {
  // The earliest gesture there is, and parsing holds the page still for a second or two after it --
  // exactly the silence the device's wake-up pop should land in rather than under the first cue.
  warm();
  rounds = [];
  dumps = [];
  segmentList.replaceChildren();
  for (const [n, source] of sources.entries()) {
    // A dense capture runs to tens of megabytes, and parsing one holds the page still for a second
    // or two, so say what is happening and let it paint before the parse rather than after.
    busy(`reading ${source.name}`, `${n + 1} of ${sources.length}`);
    await paint();
    let payload: { ttr?: unknown };
    try {
      payload = JSON.parse(await textOf(source.blob));
    } catch (error) {
      return unplayable(`Could not read ${source.name}: ${(error as Error).message}`);
    }
    await paint();
    let dump = false;
    try {
      dumps.push(...parseCaptures(payload));
      dump = true;
    } catch {
      /* not a state dump */
    }
    // The capture script writes both halves as one file and names them -- `ttr`, since a replay
    // has a `replay` field of its own. Picked by hand, a file is one or the other whole. Naming
    // the half also keeps the round search out of the states, which outnumber everything else in
    // the file by a thousand to one.
    const replay = payload?.ttr ?? (dump ? null : payload);
    if (replay) rounds.push(...parseRounds(replay));
  }
  if (!rounds.length)
    return unplayable(
      dumps.length
        ? "That is a capture with no replay in it — load it together with the .ttr it came from."
        : `No playable rounds found in ${sources.map((s) => s.name).join(", ")}.`
    );
  // A replay holds the input stream and nothing else, and a run rebuilt from that alone drifts
  // wherever garbage enters: a league round comes back with half its lines invented. The capture
  // is what pins the reconstruction down, so a replay without one is refused rather than played
  // wrong without saying so.
  if (!dumps.length)
    return unplayable("That replay has no capture in it. Save it with the capture script instead.");
  paired = pairDumps(rounds, dumps);
  roundSelect.replaceChildren(...rounds.map((r, i) => new Option(r.label, String(i))));
  // A single-round replay has nothing to choose between, and Zenith is always one round.
  roundSelect.hidden = rounds.length < 2;
  selectRound(0);
}

fileInput.addEventListener("change", () => {
  const files = [...(fileInput.files ?? [])];
  // Cleared so that re-picking the same file still fires a change.
  fileInput.value = "";
  presetSelect.value = "";
  if (files.length) load(files.map((file) => ({ name: file.name, blob: file })));
});

presetSelect.addEventListener("change", async () => {
  const url = presetSelect.value;
  if (!url) return;
  const name = presetSelect.selectedOptions[0].textContent ?? "replay";
  busy(`fetching ${name}`);
  await paint();
  load([{ name, blob: await (await fetch(url)).blob() }]);
});

roundSelect.addEventListener("change", () => selectRound(Number(roundSelect.value)));

capInput.addEventListener("change", () => {
  settings.segmentCap = Math.max(1, Number(capInput.value) || 1);
  capInput.value = String(settings.segmentCap);
  save();
  if (round) resegment();
});

finesseInput.addEventListener("change", () => {
  settings.finesse = finesseInput.checked;
  save();
});

gravityInput.addEventListener("change", () => {
  settings.gravity = gravityInput.checked;
  save();
});

paceInput.addEventListener("change", () => {
  settings.minPps = Math.max(0, Number(paceInput.value) || 0);
  paceInput.value = String(settings.minPps);
  save();
});

demoInput.addEventListener("change", () => {
  // A demo at no speed at all would never reach its next piece.
  settings.demoPps = Math.max(0.1, Number(demoInput.value) || 1.5);
  demoInput.value = String(settings.demoPps);
  save();
});

ghostsInput.addEventListener("change", () => {
  settings.ghosts = ghostsInput.checked;
  save();
});

/**
 * Volume on the wheel, the way the game does it, so it can be set without looking away from the
 * board. Over the board only: the list of intervals beside it scrolls, and that is what a wheel
 * over a list is for.
 */
let fading: ReturnType<typeof setTimeout> | undefined;
stage.addEventListener(
  "wheel",
  (event) => {
    event.preventDefault();
    const step = event.deltaY > 0 ? -0.05 : 0.05;
    settings.volume = Math.round(Math.min(1, Math.max(0, settings.volume + step)) * 100) / 100;
    setVolume(settings.volume);
    // Turning the wheel is a gesture, which is the moment the audio device may be opened.
    warm();
    // The level as it will be heard rather than only seen, and the cue to hear it on is the one
    // every placement makes. Turned down to nothing it plays nothing, which is the honest answer.
    sfx("lock");
    level.style.setProperty("--filled", `${settings.volume * 100}%`);
    level.classList.add("show");
    clearTimeout(fading);
    fading = setTimeout(() => level.classList.remove("show"), 900);
    save();
  },
  { passive: false }
);

configButton.addEventListener("click", () => {
  stop();
  openSettings();
});

/**
 * The egg: four clicks running on the same piece, in hold or anywhere in the queue, and the board
 * is given over to that piece and nothing else. Hidden rather than offered, because it is not what
 * the trainer is for -- but a queue you can point at is an invitation, and this is behind it.
 */
let streak: Mino | null = null;
let hits = 0;
board.addEventListener("click", (event) => {
  const mino = pick(event);
  hits = mino && mino === streak ? hits + 1 : 1;
  streak = mino;
  if (!mino) return;
  // The fourth tap is not answered by the ladder: the flood it opens is the far bigger sound, and
  // the two land on the same instant.
  if (hits < 4) return tapSfx(hits);
  if (!round) return;
  // Spent, rather than left standing at four: every further click on the piece would otherwise
  // open the well again, and in there the whole queue is the piece.
  hits = 0;
  stop();
  say(`${mino.toUpperCase()} forever — esc to leave`);
  mono_ = runMono(mino, round.options, settings, render);
});

addEventListener("keydown", (event) => {
  if (dialog.open) return;
  // The egg hears its own keys and nothing else: the trainer's three would restart, replay or
  // pause a drill that is not the one being played.
  if (mono_) {
    if (event.code === "Escape") return show();
    return mono_.keydown(event);
  }
  if (settings.pause.includes(event.code)) {
    event.preventDefault();
    return setPaused(!held);
  }
  // Nothing but unpausing gets through while play is held, and the release of a key pressed
  // before it still does -- see the keyup handler.
  if (held) return;
  if (settings.restart.includes(event.code)) {
    event.preventDefault();
    // Mid-demo there is nothing to restart yet, so it means the same as any other piece key: skip
    // the watching and start the turn.
    if (!session) return show_ ? play() : undefined;
    session.restart();
    return say(turnLine(0));
  }
  if (settings.replay.includes(event.code) && segments.length) {
    event.preventDefault();
    return show();
  }
  // Reaching for a piece key during the demo means you already know this one: cut it short and hand
  // over rather than swallowing the press.
  if (!session && show_ && actions.some((a) => settings.binds[a].includes(event.code))) {
    event.preventDefault();
    skipped = event.code;
    return play();
  }
  // A fresh press settles any release still owed from a skip, so one that never arrived -- the tab
  // lost focus, say -- cannot swallow a later one.
  if (event.code === skipped) skipped = null;
  session?.keydown(event);
});
addEventListener("keyup", (event) => {
  if (dialog.open) return;
  if (mono_) return mono_.keyup(event);
  // The release of the key that cut the demo short belongs to the demo, not to the turn it started.
  if (event.code === skipped) {
    skipped = null;
    return;
  }
  session?.keyup(event);
});

async function selectRound(index: number) {
  stop();
  round = rounds[index];
  anchors = paired[index] ?? [];
  // Whose run this is and where it ended. The picker above already names the player whenever
  // there is a choice of them, and only Zenith measures a run in metres.
  const [whole, tenth] = metres(round.altitude);
  run.replaceChildren(
    ...(rounds.length < 2
      ? [Object.assign(document.createElement("b"), { textContent: round.username })]
      : []),
    ...(round.altitude
      ? [
          Object.assign(document.createElement("span"), {
            textContent: `${whole}.${tenth} M`
          })
        ]
      : [])
  );
  // What the tower was set to for this run. A mode that has none leaves the row collapsed.
  mods.replaceChildren(
    ...(round.options.zenith_mods ?? []).map((mod) =>
      Object.assign(document.createElement("span"), { textContent: mod })
    )
  );
  roundSelect.value = String(index);
  // Verifying a long run against its anchors blocks for seconds; let the notice paint first.
  busy("simulating", round.label);
  await paint();
  let dropped = 0;
  try {
    ({ placements, dropped } = simulate(round, anchors));
  } catch (error) {
    return unplayable(`${round.label} cannot be simulated — ${(error as Error).message}.`);
  }
  trimmed = dropped;
  resegment();
  if (trimmed) say(`${trimmed} placements dropped: unverifiable garbage`);
}

function unplayable(reason: string) {
  segments = [];
  segmentList.replaceChildren();
  // The rounds went with the load that failed; leaving them listed offers a choice that would
  // reach past the end of an empty array.
  roundSelect.replaceChildren();
  roundSelect.hidden = true;
  altitude.classList.remove("busy");
  altitude.replaceChildren();
  mods.replaceChildren();
  run.replaceChildren();
  ready(false);
  say(reason);
}

/**
 * The stage has two faces: how to come by a replay, or how to play the one that is loaded. The
 * keys do nothing until there is a run under them, so until then they are not advice.
 */
function ready(yes: boolean) {
  guide.hidden = yes;
  board.hidden = !yes;
  drawKeys();
}

/** Re-cutting the run invalidates what was cleared, since the segment boundaries move. */
function resegment() {
  segments = segment(placements, settings.segmentCap);
  current = 0;
  cleared.clear();
  if (!segments.length)
    return unplayable(
      trimmed
        ? "This round's garbage lands before the first piece, so none of it can be trusted."
        : "This round has no placements."
    );
  ready(true);
  drawSegmentList();
  show();
}

function select(index: number) {
  if (index < 0 || index >= segments.length) return;
  current = index;
  drawSegmentList();
  show();
}

function show() {
  stop();
  warm();
  drawAltitude();
  say("watch");
  show_ = runShow(placements, segments[current], fieldHeight(round!.options), render, play);
}

function play() {
  stop();
  const index = current;
  const next = index + 1;
  session = new Session(round!, placements, segments[index], settings, {
    render,
    progress: (placed) => say(turnLine(placed)),
    fail: (fault, got, want) =>
      fault === "finesse"
        ? say(`finesse — ${got} inputs, ${want} was enough`, "finesse")
        : fault === "slow"
          ? say(`too slow — ${got} pps, ${want} asked`, "finesse")
          : say("misplaced", "misplaced"),
    pass: () => {
      // The turn is over however it goes on from here, and a finished session must not be left
      // for the pause button to start ticking again.
      session = null;
      cleared.add(index);
      drawSegmentList();
      if (next === segments.length) {
        sfx("complete");
        return say("run complete", "cleared");
      }
      sfx("cleared");
      say("cleared", "cleared");
      advance = setTimeout(() => select(next), 700);
    }
  });
  session.start();
}

function turnLine(placed: number) {
  const seg = segments[current];
  return `${placed} / ${seg.end - seg.start + 1}`;
}

/**
 * Holds or lets go of whichever phase is running. The demo keeps its place on the clock; a turn
 * is simply not ticked, and picks its frame clock up from the moment it resumes rather than
 * catching up on everything it missed.
 */
function setPaused(wanted: boolean) {
  if (!session && !show_) return;
  if (wanted === !!held) return;
  if (held) {
    const { text, tone } = held;
    held = null;
    session?.start();
    show_?.resume();
    say(text, tone);
  } else {
    held = { text: status.textContent ?? "", tone: status.className };
    session?.stop();
    show_?.pause();
    say("paused");
  }
}

function stop() {
  held = null;
  clearTimeout(advance);
  show_?.stop();
  show_ = null;
  session?.stop();
  session = null;
  mono_?.stop();
  mono_ = null;
}

function drawSegmentList() {
  segmentList.replaceChildren(
    ...segments.map((seg, i) => {
      const button = document.createElement("button");
      button.className = "segment";
      button.classList.toggle("current", i === current);
      button.classList.toggle("done", cleared.has(i));
      const ends = placements[seg.end];
      button.innerHTML = `<b>${i + 1}</b><span>${
        spinLabel(ends) || `${seg.end - seg.start + 1} pieces`
      }</span>`;
      button.addEventListener("click", () => select(i));
      return button;
    })
  );
}

/**
 * Metres climbed, laid out as TETR.IO lays them out on its own result screen: grouped thousands, one
 * decimal place taken rather than rounded, and a capital unit.
 */
/**
 * A capture is twenty-odd megabytes of JSON that repeats itself -- the same keys eight thousand
 * times over a board that barely moves between states -- and gzips to a twenty-fifth of that, so
 * the dump script writes them packed. Sniffed by the magic bytes rather than the name, so a dump
 * taken before that still loads.
 */
const textOf = async (blob: Blob) => {
  const [magic, second] = new Uint8Array(await blob.slice(0, 2).arrayBuffer());
  if (magic !== 0x1f || second !== 0x8b) return blob.text();
  return new Response(blob.stream().pipeThrough(new DecompressionStream("gzip"))).text();
};

/** Lets the page paint before a step that will hold it still. */
const paint = () => new Promise(requestAnimationFrame);

/** Puts the big readout to work as a progress notice while something slow is happening. */
function busy(message: string, detail = "") {
  altitude.classList.add("busy");
  altitude.textContent = message;
  say(detail);
}

/** Metres as the client writes them on its own result screen: grouped, one decimal taken. */
const metres = (m: number) =>
  [Math.floor(m).toLocaleString("en-US"), Math.floor((m % 1) * 10)] as const;

function drawAltitude() {
  altitude.classList.remove("busy");
  const [whole, tenth] = metres(placements[segments[current].start].altitude);
  // Metres are Zenith's measure of a run. A league round has none, and a readout stuck at 0.0 M
  // over every segment of it says nothing; the piece it opens on does.
  altitude.innerHTML = round?.altitude
    ? `${whole}<span class="ms">.${tenth}</span><span class="unit">M</span>`
    : `${segments[current].start + 1}` + `<span class="unit">/ ${placements.length} pieces</span>`;
}

function say(text: string, tone = "") {
  status.textContent = text;
  status.className = tone;
}

function openSettings() {
  const form = document.createElement("form");
  form.method = "dialog";
  form.innerHTML = "<h2>Sound</h2>";
  form.append(
    field(
      "Volume",
      input({ type: "range", min: 0, max: 1, step: 0.05, value: settings.volume }, (i) => {
        settings.volume = Number(i.value);
        setVolume(settings.volume);
      })
    )
  );
  form.insertAdjacentHTML(
    "beforeend",
    '<p class="note">Can also be adjusted with the mouse wheel over the board.</p>' +
      "<h2>Handling</h2>"
  );

  for (const { key, label, min, max, step } of handlingFields)
    form.append(
      field(
        label,
        input({ type: "number", min, max, step, value: settings.handling[key] }, (i) => {
          settings.handling[key] = Number(i.value);
        })
      )
    );

  for (const { key, label } of handlingToggles)
    form.append(
      field(
        label,
        input({ type: "checkbox", checked: settings.handling[key] }, (i) => {
          settings.handling[key] = i.checked;
        })
      )
    );

  for (const { key, label } of handlingModes) {
    const select = document.createElement("select");
    select.replaceChildren(...(["off", "hold", "tap"] as const).map((v) => new Option(v, v)));
    select.value = settings.handling[key];
    select.addEventListener("change", () => {
      settings.handling[key] = select.value as "off" | "hold" | "tap";
    });
    form.append(field(label, select));
  }

  form.insertAdjacentHTML(
    "beforeend",
    '<h2>Keys</h2><p class="note">Two keys to a control; Escape clears the one being set.</p>'
  );
  for (const action of [...actions, ...controls]) form.append(field(action, rebinder(action)));
  // Last, under the three it is about: the piece keys above it are not the ones shown.
  form.append(
    field(
      "Show key hints under the board",
      input({ type: "checkbox", checked: settings.keyHints }, (i) => {
        settings.keyHints = i.checked;
      })
    )
  );

  const close = document.createElement("button");
  close.textContent = "Done";
  form.append(close);

  dialog.replaceChildren(form);
  dialog.showModal();
  dialog.addEventListener(
    "close",
    () => {
      save();
      drawKeys();
      if (round && segments.length) show();
    },
    { once: true }
  );
}

function field(label: string, control: HTMLElement) {
  const wrap = document.createElement("label");
  wrap.className = "field";
  wrap.append(Object.assign(document.createElement("span"), { textContent: label }), control);
  return wrap;
}

function input(
  props: Record<string, string | number | boolean>,
  onChange: (input: HTMLInputElement) => void
) {
  const node = document.createElement("input");
  Object.assign(node, props);
  node.addEventListener("change", () => onChange(node));
  return node;
}

const isControl = (action: Action | Control): action is Control =>
  (controls as string[]).includes(action);

const bindsOf = (action: Action | Control) =>
  isControl(action) ? settings[action] : settings.binds[action];

/** A button for each key a control may answer to: the ones it has, and the one it may be given. */
function rebinder(action: Action | Control) {
  const pair = document.createElement("span");
  pair.className = "binds";
  const buttons = [0, 1].map(() =>
    Object.assign(document.createElement("button"), { type: "button" })
  );
  const read = () =>
    buttons.forEach((button, slot) => {
      const code = bindsOf(action)[slot];
      button.textContent = code ? bindLabel(code) : "—";
    });
  for (const [slot, button] of buttons.entries())
    button.addEventListener("click", () => {
      button.textContent = "press a key…";
      addEventListener(
        "keydown",
        (event) => {
          event.preventDefault();
          const keys = bindsOf(action);
          // Escape is how a slot is given up: bound to one, there would be no way back out of it.
          if (event.code === "Escape") keys.splice(slot, 1);
          // Appended rather than written past the end, so that clearing the first key moves the
          // second up into it instead of leaving a hole.
          else keys[Math.min(slot, keys.length)] = event.code;
          read();
        },
        { once: true, capture: true }
      );
    });
  read();
  pair.append(...buttons);
  return pair;
}
