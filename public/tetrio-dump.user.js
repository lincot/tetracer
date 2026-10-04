// ==UserScript==
// @name         TETR.IO replay state dump
// @namespace    tetracer
// @version      25.0
// @description  Makes TETR.IO eject engine states more often while analysing a replay, and captures them with the replay itself.
// @match        https://tetr.io/*
// @run-at       document-start
// @grant        none
// @require      https://cdn.jsdelivr.net/npm/msgpackr@1.12.1/dist/index.min.js#sha256=m/bTxCU7pB/QEa6cipUUQO4tEc2GnPtORypN4wMqpsE=
// ==/UserScript==

/*
 * A downloaded .ttr has its periodic board snapshots stripped by the client's own StripBloat, and
 * Zenith's board cannot be rebuilt from the input stream alone. But when the client opens a replay
 * it re-simulates it headlessly to build the seekbar, and two things it computes pass through plain
 * arrays on the way:
 *
 *   - a complete engine state every 300 frames, tagged `started`
 *   - every garbage row, carrying the hole column it will land in (Zenith enters garbage
 *     continuously, so each row is queued via `garbageareentries.push`)
 *
 * The hole column is the one thing a downloaded replay cannot give up, so capturing it closes the
 * gap. The replay itself is read from the response the client already asked for, so the whole run
 * comes out of one visit with nothing to download by hand.
 *
 * This observes objects and responses the page has already built, in your own browser. It does not
 * touch a live game and asks TETR.IO for nothing of its own. Two things are worth knowing: it
 * rewrites one number in the client's own script before the browser runs it (see INTERVAL below),
 * and `@require` has your userscript manager fetch a msgpack decoder once, from a pinned version
 * with its checksum, because the replay arrives packed and there is no reading it otherwise.
 */

(() => {
  "use strict";

  const say = (...a) => console.log("%c[zdump]", "color:#4f8cff;font-weight:bold", ...a);

  /*
   * The client reproduces a replay exactly -- it steps the whole thing frame by frame to build the
   * seekbar -- and throws almost all of it away:
   *
   *   for (let e = 0; n.isPlaying() && e <= h; e++)
   *     if (n.doFrame(), e % 300 == 0) { const e = n.ejectState(); i.states.push(e) }
   *
   * Every 300th frame is kept, and what happens between two of them has to be reconstructed and
   * guessed at. That interval is one literal, and it appears exactly once in the bundle, so asking
   * for a state more often is a single substitution.
   *
   * This is the one part of these scripts that changes the client rather than watching it. It edits
   * the script text as it is handed to `new Blob`, before the browser ever runs it, and touches
   * nothing but that number: no file is written, no account or online play is involved, and a reload
   * without this script restores the stock client.
   */
  /*
   * 10 is where a run reconstructs whole. `garbageare` is 5, so ten frames hold at most one garbage
   * row rising and at most one piece locking -- nothing for two events to be ambiguous about. Twenty
   * leaves tens of placements per run unaccounted for; five is no better than ten and twice the file.
   */
  const INTERVAL = 10;
  const ANCHOR = "%300==0";

  let patched = false;
  const RealBlob = Blob;
  const rewrite = (part) => {
    const text =
      typeof part === "string"
        ? part
        : ArrayBuffer.isView(part) || part instanceof ArrayBuffer
          ? new TextDecoder().decode(part)
          : null;
    if (text === null || !text.includes(ANCHOR)) return null;
    patched = true;
    return text.replace(ANCHOR, `%${INTERVAL}==0`);
  };
  // biome-ignore lint/complexity/useArrowFunction: the page calls it with `new`
  window.Blob = function (parts, options) {
    if (Array.isArray(parts)) {
      let changed = false;
      const next = parts.map((part) => {
        const out = rewrite(part);
        if (out === null) return part;
        changed = true;
        return out;
      });
      if (changed) {
        say(`patched: a state every ${INTERVAL} frames instead of every 300`);
        return new RealBlob(next, options);
      }
    }
    return new RealBlob(parts, options);
  };
  window.Blob.prototype = RealBlob.prototype;

  // Everything the trainer's `parseAnchors` reads; the rest is ~70% of the bytes.
  const KEEP = [
    "board",
    "bag",
    "bagex",
    "bagid",
    "lastGenerated",
    "rng",
    "rngex",
    "hold",
    "holdlocked",
    "falling",
    "lShift",
    "rShift",
    "lastshift",
    "firstInputTime",
    "lastpiecetime",
    "inputSoftdrop",
    "inputHold",
    "inputRotateCW",
    "inputRotateCCW",
    "inputRotate180",
    "lastwasclear",
    "lasttanktime",
    "lastcolumn",
    "haschangedcolumn",
    "lastreceivedcount",
    "stats",
    "glock",
    "stock",
    "spike",
    "subframe",
    "totalRotations",
    // Where garbage entry had got to: what is still counting down, what is tanked and waiting to
    // rise, and the frame the next row may rise on.
    "impendingdamage",
    "garbageareentries",
    "garbagearelockeduntil"
  ];

  const states = [];
  const garbage = [];
  let capturing = true;

  const isState = (v) => v.started === true && typeof v.frame === "number" && v.game;
  const isGarbageRow = (v) =>
    typeof v.column === "number" && typeof v.size === "number" && "edges" in v;

  const push = Array.prototype.push;
  Array.prototype.push = function (...args) {
    if (capturing)
      for (const value of args) {
        if (value === null || typeof value !== "object") continue;
        if (isState(value)) {
          const game = {};
          for (const key of KEEP) if (key in value.game) game[key] = value.game[key];
          // Half of a state is its board, and as rows of cells it is nearly all punctuation.
          if (Array.isArray(game.board))
            game.board = game.board.map((row) => row.map((cell) => cell ?? "").join(","));
          push.call(states, { frame: value.frame, game });
        } else if (isGarbageRow(value)) {
          // `after` pins the row to the window that was running when it was queued.
          push.call(garbage, { after: states.length, column: value.column, size: value.size });
        }
      }
    return push.apply(this, args);
  };

  /*
   * The other half. The trainer needs the input stream as well as these states, and the client
   * fetches it from `/api/games/<id>` on its way to playing the replay -- so it is taken there,
   * and nothing has to be downloaded by hand first.
   *
   * It arrives in theorypack: msgpackr under two extensions of TETR.IO's own, wrapping the body
   * in a success envelope, with strings bundled. Those are the settings below, and they are the
   * client library's own (`@haelp/teto`'s `theorypack`), not guesses -- a response packed by it
   * comes back through this identical.
   */
  const unpacker = (() => {
    msgpackr.addExtension({
      Class: undefined,
      type: 1,
      read: (value) => (value === null ? { success: true } : { success: true, ...value })
    });
    msgpackr.addExtension({
      Class: undefined,
      type: 2,
      read: (value) => (value === null ? { success: false } : { success: false, error: value })
    });
    return new msgpackr.Unpackr({
      int64AsType: "number",
      bundleStrings: true,
      sequential: false
    });
  })();

  let replay = null;

  /**
   * Named for the run rather than for the day it was downloaded: who climbed, how far they got,
   * and the id it can be found under again. Whichever of those the replay does not carry is left
   * out rather than written as a blank.
   */
  const bundleName = () => {
    const metres = replay?.replay?.results?.stats?.zenith?.altitude;
    // Joined with a plus, the name being cut on hyphens by whoever reads it back.
    const mods = replay?.replay?.options?.zenith_mods;
    const parts = [
      replay?.users?.[0]?.username ?? replay?.replay?.options?.username,
      metres && `${Math.floor(metres)}m`,
      mods?.length && mods.join("+"),
      replay?.id
    ].filter(Boolean);
    return parts.length ? `${parts.join("-")}.json.gz` : null;
  };

  /**
   * The replay file itself, dug out of whatever the API wrapped it in. Searched for rather than
   * reached for by name: the envelope's own key is not something to assume, and taking the
   * envelope instead leaves a bundle that still loads but cannot say whose run it holds.
   *
   * A replay file is the node carrying the players and the round; a round alone, which is what
   * the trainer looks for, sits inside it and knows neither name nor altitude.
   */
  const findReplay = (node) => {
    if (Array.isArray(node)) {
      for (const item of node) {
        const found = findReplay(item);
        if (found) return found;
      }
      return null;
    }
    if (!node || typeof node !== "object") return null;
    if (Array.isArray(node.users) && node.replay) return node;
    for (const value of Object.values(node)) {
      const found = findReplay(value);
      if (found) return found;
    }
    return null;
  };

  const takeReplay = (url, bytes) => {
    if (replay || !capturing || !/\/api\/games\//.test(url)) return;
    let body;
    try {
      body = unpacker.unpack(new Uint8Array(bytes));
    } catch (error) {
      const head = [...new Uint8Array(bytes).slice(0, 8)]
        .map((b) => b.toString(16).padStart(2, "0"))
        .join(" ");
      return say(`${url} would not unpack (starts ${head}):`, error);
    }
    const found = findReplay(body);
    if (!found) return say(`${url} unpacked into {${Object.keys(body)}}, with no replay in it`);
    replay = found;
    say(`replay taken from ${url} — the bundle will be ${bundleName()}`);
  };

  const send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (...args) {
    // The client asks for these as bytes; anything else it asked for is not the replay.
    this.addEventListener("load", () => {
      if (this.response instanceof ArrayBuffer) takeReplay(this.responseURL, this.response);
    });
    return send.apply(this, args);
  };

  const realFetch = window.fetch;
  window.fetch = async (...args) => {
    const response = await realFetch.apply(window, args);
    if (capturing && !replay && /\/api\/games\//.test(response.url))
      response
        .clone()
        .arrayBuffer()
        .then(
          (bytes) => takeReplay(response.url, bytes),
          () => {}
        );
    return response;
  };

  /*
   * The button. The replay view is the only place it can go: the states are made by opening the
   * replay, so on the screen before it there would be nothing to write. It is put beside the way
   * out, which is where you are once you have finished watching, and takes the way out's own
   * classes so it does not look bolted on. If that cannot be found it floats in the corner, so a
   * change to the client's markup leaves it awkward rather than missing.
   */
  /** Whether this is the way out of a replay, which is the one landmark worth looking for. */
  const isLabel = (el) => /^\s*exit\s*$/i.test(el.textContent ?? "");
  /** The node inside the button that holds its words, found once it no longer says EXIT. */
  const wording = (el) =>
    [el, ...el.querySelectorAll("*")].reverse().find((n) => n.children.length === 0) ?? el;
  const isExit = (el) => el.children.length < 2 && isLabel(el) && el.offsetParent;
  const findExit = () =>
    [...document.querySelectorAll("button, a, [role=button], div")].find(isExit);

  /**
   * A copy of the way out, so the new button is styled as one of the row rather than bolted on.
   */
  const modelledOn = (exit) => {
    const copy = exit.cloneNode(true);
    for (const node of [copy, ...copy.querySelectorAll("*")]) {
      node.removeAttribute("id");
      // Inline handlers come across with the clone and would still do what the original did.
      for (const { name } of [...node.attributes])
        if (name.startsWith("on")) node.removeAttribute(name);
    }
    copy.id = "zdump-save";
    return copy;
  };

  /** What the button says at rest. Not "bundle": that is a word from the workshop, not the game. */
  /** Where each re-simulated run begins; the client starts every one of them over at frame one. */
  const starts = () => {
    const at = [];
    for (const [i, s] of states.entries()) if (s.frame <= 1) at.push(i);
    if (!at.length && states.length) at.push(0);
    return at;
  };

  /**
   * What the button says at rest. Carries the count, because a league match is captured a round
   * at a time and there is otherwise no way to tell from the screen how much is in hand -- and
   * two runs come of each round, one per player.
   */
  const IDLE = "SAVE REPLAY";
  const idle = () => {
    const runs = starts().length;
    return runs > 1 ? `${IDLE} · ${runs} RUNS` : IDLE;
  };

  /**
   * Put where the way out is, not where it sits in the markup. `.watch_header` lays its buttons
   * out without a row to join -- both it and `.exit` are display:block -- so a sibling inserted
   * beside the way out lands underneath it however it is styled. Measuring instead works whatever
   * the client does, and anchoring by the right edge means the new button grows leftwards from
   * the way out's left edge and never depends on how wide its own label is.
   */
  const GAP = 10;
  const pin = (save, exit) => {
    const box = exit.getBoundingClientRect();
    Object.assign(save.style, {
      position: "fixed",
      margin: "0",
      top: `${box.top}px`,
      // The measured height is the whole box; without this it is the content's, and whatever
      // padding and border the way out carries is then added underneath it.
      boxSizing: "border-box",
      height: `${box.height}px`,
      right: `${window.innerWidth - box.left + GAP}px`,
      zIndex: "9999"
    });
  };

  /**
   * Waits for the way out to stop moving. The client slides a screen into place, and a box
   * measured mid-slide pins the button where it will not stay -- it then sits wrong until the
   * next sweep a second later drags it down, which is worse than arriving a few frames late.
   */
  const settled = async (exit) => {
    for (let still = 0, last = ""; still < 3; ) {
      await new Promise(requestAnimationFrame);
      if (!exit.isConnected) return false;
      const box = exit.getBoundingClientRect();
      const here = `${box.top} ${box.left} ${box.height}`;
      still = here === last ? still + 1 : 0;
      last = here;
    }
    return true;
  };

  let waited = 0;
  let placing = false;
  const place = async () => {
    const button = document.getElementById("zdump-save");
    const exit = findExit();
    // No way out on screen means no replay on screen, so the button goes with it.
    if (!exit) {
      button?.remove();
      if (states.length && ++waited === 10)
        say("no EXIT found to sit beside — press zdump() instead, and run zdumpWhere() for why");
      return;
    }
    // Kept level with the way out as the window changes under it.
    if (button) {
      pin(button, exit);
      // Kept current as more rounds are opened; left alone while a save is in flight.
      if (!button.dataset.busy) {
        wording(button).textContent = idle();
      }
      return;
    }
    // The sweep keeps running while the slide is waited out; only one button comes of it.
    if (!states.length || placing) return;
    placing = true;

    const save = modelledOn(exit);
    // The label lives wherever it lived in the original, which may be inside the box, not on it.
    const label = [save, ...save.querySelectorAll("*")].reverse().find(isLabel) ?? save;
    label.textContent = idle();
    const show = (text, busy) => {
      label.textContent = text;
      save.dataset.busy = busy ? "1" : "";
      save.style.pointerEvents = busy ? "none" : "";
      save.style.opacity = busy ? "0.6" : "";
    };
    save.addEventListener("click", async (event) => {
      // The client may well be listening for this further up, on a class the clone carries.
      event.preventDefault();
      event.stopPropagation();
      show("SAVING…", true);
      // Serialising a capture holds the thread for a second or two, so let the label it replaced
      // reach the screen first -- otherwise the only thing ever seen is the word after it.
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
      await window.zdump();
      show("SAVED", true);
      setTimeout(() => show(idle(), false), 2000);
    });
    if (await settled(exit)) {
      exit.parentElement.append(save);
      pin(save, exit);
    }
    placing = false;
  };
  setInterval(place, 1000);
  window.addEventListener("resize", () => {
    const button = document.getElementById("zdump-save");
    const exit = findExit();
    if (button && exit) pin(button, exit);
  });

  /** Says how the way out is laid out, for when the button still lands somewhere daft. */
  window.zdumpWhere = () => {
    const exit = findExit();
    if (!exit) return say("no EXIT on screen");
    const describe = (el) => {
      const style = getComputedStyle(el);
      const box = el.getBoundingClientRect();
      return (
        `${el.tagName.toLowerCase()}.${[...el.classList].join(".") || "(no class)"} · ` +
        `${style.display}/${style.position}${style.float === "none" ? "" : `/float:${style.float}`} · ` +
        `${Math.round(box.left)},${Math.round(box.top)} ${Math.round(box.width)}x${Math.round(box.height)}`
      );
    };
    for (let node = exit; node && node !== document.body; node = node.parentElement) {
      say(describe(node));
      // What else shares the bar says how its buttons are laid out beside each other.
      if (node.children.length > 1)
        for (const sibling of node.children) say("   ", describe(sibling));
    }
  };

  /**
   * What has been captured so far, without writing anything. The client builds a replay's seekbar
   * by re-simulating it, and does so progressively -- so this is how to tell whether a round has
   * finished building before moving on to the next, which watching it cannot tell you.
   */
  window.zstates = () => {
    const starts = [];
    for (const [i, s] of states.entries()) if (s.frame <= 1) starts.push(i);
    if (!starts.length) return say("nothing captured yet");
    say(
      `${starts.length} run(s): ` +
        starts
          .map((from, n) => {
            const to = starts[n + 1] ?? states.length;
            return `${to - from} states to frame ${states[to - 1].frame}`;
          })
          .join(" · ")
    );
    say("run it again; if the last count has stopped growing, that round is fully built");
  };

  window.zdumpOff = () => {
    capturing = false;
    say("capture off (reload to remove the hook entirely)");
  };

  window.zdump = async (name) => {
    if (!states.length) {
      say("nothing captured yet — open a replay and let its seekbar build, then run zdump() again");
      return;
    }
    // The client re-simulates a replay every time one is opened, starting over at frame one, so
    // a league match watched through leaves one run here per round. All of them are written: it
    // is the only way to anchor more than the round that happened to be on screen last.
    const starts = [];
    for (const [i, s] of states.entries()) if (s.frame <= 1) starts.push(i);
    if (!starts.length) starts.push(0);
    const captures = starts.map((from, n) => {
      const to = starts[n + 1] ?? states.length;
      return {
        states: states.slice(from, to),
        garbage: garbage
          .filter((g) => g.after > from && g.after <= to)
          .map((g) => ({ ...g, after: g.after - from }))
      };
    });
    const kept = captures[captures.length - 1].states;
    const rows = captures.reduce((n, c) => n + c.garbage.length, 0);
    const gaps = kept.slice(1).map((x, i) => x.frame - kept[i].frame);
    const spacing = gaps.length ? Math.min(...gaps) : 0;
    say(
      `${captures.length} run(s) captured: ${captures.map((c) => c.states.length).join(", ")} states` +
        `, the last of them frames ${kept[0].frame} to ${kept[kept.length - 1].frame} every ${spacing}`
    );
    if (!patched)
      say(
        "the client was NOT patched — this is the stock 300-frame spacing. Reload the page with this " +
          "script enabled *before* opening the replay, and check the bundle still contains " +
          ANCHOR
      );
    say(`${rows} garbage rows with hole columns`);
    say("game keys:", Object.keys(kept[0].game).join(", "));

    if (!replay)
      say(
        "the replay itself was not captured, so this file holds the states alone — load the .ttr " +
          "alongside it. To get both in one file, save the replay from the client first, then run " +
          "zdump() again: it is taken as the client writes it, and it cannot be read off the wire, " +
          "where it arrives packed in theorypack."
      );

    // Written packed: the same keys eight thousand times over a board that barely moves between
    // states, which gzip takes to a twenty-fifth. The trainer sniffs the magic bytes, so nothing
    // depends on the name.
    const json = new Blob([JSON.stringify({ ttr: replay, captures })]);
    const packed = await new Response(
      json.stream().pipeThrough(new CompressionStream("gzip"))
    ).blob();
    say(`${(json.size / 1e6).toFixed(1)}MB of JSON, ${(packed.size / 1e6).toFixed(2)}MB packed`);

    const a = document.createElement("a");
    a.href = URL.createObjectURL(packed);
    a.download = name ?? bundleName() ?? "replay-states.json.gz";
    a.click();
  };

  // Says what this copy does, so a console reporting anything else is an older one still installed
  // -- which is otherwise only visible as a spacing that does not match INTERVAL.
  say(`armed, v25: a state every ${INTERVAL} frames, replay unpacked from /api/games.`);
  say(`Open a replay, let the seekbar finish, then press ${IDLE} next to EXIT.`);
  say("zstates() says how much has been captured; zdumpOff() stops; zdump() writes by hand.");
})();
