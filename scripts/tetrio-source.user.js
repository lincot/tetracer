// ==UserScript==
// @name         TETR.IO engine source locator
// @namespace    tetracer
// @version      2.0
// @description  Finds the script the replay engine actually runs from, so its garbage-entry rule can be read rather than guessed at.
// @match        https://tetr.io/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

/*
 * Every remaining gap in the reconstruction is one rule: when Zenith lets a queued garbage row into
 * the well. It cannot be fitted from outside, because entry depends on whether the player cleared
 * and clearing depends on when garbage entered -- a loop no fixed schedule reproduces.
 *
 * The client's bundle is built by an obfuscated bootstrap, so it has no script tag to read, and the
 * stack at the moment it pushes an engine state names a blob: URL. Reading that URL back usually
 * fails: a loader revokes it as soon as the script tag has loaded. So this takes the text at the one
 * moment it is unambiguously in hand -- when the blob URL is created -- and keeps it.
 *
 * This reads scripts your browser has already downloaded and is already running. It does not modify
 * the client, touch a live game, or add server traffic.
 *
 *   1. open a replay and let it load
 *   2. run  zsource()
 */

(() => {
  "use strict";

  const say = (...rest) => console.log("%c[zsource]", "color:#4f8cff;font-weight:bold", ...rest);

  /** Text of every blob the page makes a URL for, taken before anything can revoke it. */
  const blobs = new Map();
  const createObjectURL = URL.createObjectURL.bind(URL);
  URL.createObjectURL = (object) => {
    const url = createObjectURL(object);
    if (object instanceof Blob && !/^(image|audio|video|font)\//.test(object.type))
      blobs.set(
        url,
        object
          .text()
          .then((text) => {
            blobs.set(url, text);
            return text;
          })
          .catch(() => "")
      );
    return url;
  };

  /** Script URLs seen on the stack when the engine pushed a state. */
  const urls = new Set();
  let stack = "";

  const isState = (value) =>
    value.started === true && typeof value.frame === "number" && value.game;

  const push = Array.prototype.push;
  Array.prototype.push = function (...args) {
    if (!stack)
      for (const value of args)
        if (value !== null && typeof value === "object" && isState(value)) {
          stack = new Error().stack ?? "";
          for (const match of stack.matchAll(/(?:blob:|https?:)[^\s)'"]+/g))
            urls.add(match[0].replace(/:\d+:\d+$/, ""));
          break;
        }
    return push.apply(this, args);
  };

  /** Terms that say a script is the engine rather than a loader or a vendor bundle. */
  const MARKERS = [
    "garbageare",
    "garbagephase",
    "impendingdamage",
    "garbageareentries",
    "garbagearelockeduntil"
  ];

  const save = (name, text) => {
    const a = document.createElement("a");
    a.href = createObjectURL(new Blob([text], { type: "text/plain" }));
    a.download = name;
    a.click();
  };

  /** Whatever the page kept for this URL, falling back to asking for it again. */
  const read = async (url) => {
    if (blobs.has(url)) return { text: await blobs.get(url), how: "captured at creation" };
    try {
      return { text: await (await fetch(url)).text(), how: "fetched" };
    } catch (error) {
      return { text: "", how: `unreadable (${error.message})` };
    }
  };

  window.zsource = async () => {
    if (!stack) {
      say("no state seen yet — open a replay and let it load, then run zsource() again");
      return;
    }
    if (!urls.size) {
      say("a state was pushed, but nothing on its stack names a script. The stack was:");
      say(stack);
      return;
    }
    say(`stack named ${urls.size} script(s). Blobs captured this session: ${blobs.size}`);

    let saved = 0;
    for (const url of urls) {
      const { text, how } = await read(url);
      if (!text) {
        say(`  ${url}\n    ${how}`);
        continue;
      }
      const hits = MARKERS.filter((marker) => text.includes(marker));
      say(
        `  ${url}\n    ${how}, ${text.length.toLocaleString()} chars, ` +
          `markers: ${hits.join(" ") || "none"}`
      );
      // Saved either way: a script the engine ran from is worth having even if it was minified
      // past the point where these particular words survive.
      save(`tetrio-engine-${++saved}.js`, text);
      say(`    saved as tetrio-engine-${saved}.js`);
    }

    if (saved) return;
    // The stack named nothing readable, so fall back to the biggest script-shaped blob the page made.
    const candidates = [];
    for (const [url, held] of blobs) {
      const text = await held;
      if (text.length > 100000) candidates.push([url, text]);
    }
    candidates.sort((a, b) => b[1].length - a[1].length);
    if (!candidates.length) {
      say("nothing on the stack was readable and no large blob was captured.");
      say("Reload the page with this script already enabled, then open the replay.");
      return;
    }
    const [url, text] = candidates[0];
    say(`falling back to the largest captured blob: ${url}, ${text.length.toLocaleString()} chars`);
    say(`  markers: ${MARKERS.filter((m) => text.includes(m)).join(" ") || "none"}`);
    save("tetrio-engine-1.js", text);
    say("    saved as tetrio-engine-1.js");
  };

  window.zstack = () => say(stack || "no state seen yet");

  say("armed. Open a replay, let it load, then run  zsource()");
})();
