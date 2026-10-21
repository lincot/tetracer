# Zenith reconstruction: what is and isn't recoverable

Notes from trying to replay a TETR.IO Quick Play (Zenith) `.ttr` through
[Triangle.js](https://triangle.haelp.dev). Written against client build `tetr.io/js/tetrio.js`
as of 2026-09 and one recorded 2194-piece run. Doubles as the write-up for an upstream issue.

## Summary

A Zenith run's **inputs and queue are fully recoverable**. Its **board is not**, because the mode
rewrites its own garbage parameters every frame from a state the replay does not store.

## The queue: solved

`bagtype` is `zenith`, which `rngMap` has no entry for. From the client's `PopulateBag`:

```js
case "zenith": {
  const bag = rng.shuffleArray([...minotypes]);          // ["z","l","o","s","i","j","t"]
  const extra = []; const o = S.cancelstreak;
  const a = setoptions.zenith_volatile ? 2 : 1;
  if (o >= 20*a) extra.push("o");
  if (o >= 30*a) extra.push(rng.nextFloat() < .5 ? "l" : "j");
  if (o >= 40*a) extra.push(rng.nextFloat() < .5 ? "s" : "z");
  if (o >= 50*a) extra.push(rng.nextFloat() < .5 ? "l" : "j");
  if (o >= 50*a) extra.push(rng.nextFloat() < .5 ? "t" : "i");
  if (o >= 60*a) extra.push(rng.nextFloat() < .5 ? "s" : "z");
  if (extra.length) rng.shuffleArray(extra);
  s = [...bag, ...extra];
  if (o >= 40 && !S.zenith.hasseenI5) { S.zenith.hasseenI5 = true; s.unshift("i5"); }
}
```

`PullFromBag` also tops the queue to **6** pieces for zenith rather than 14, so bags are generated
just-in-time against the current `cancelstreak`.

`cancelstreak` is Zenith's "canceling sickness": `+= n` when you cancel n lines, `-= 3n` when you
tank, and **reset to 0 whenever you clear any garbage**. Since a surviving player clears garbage
constantly, it rarely reaches 20 — so in ordinary play the zenith bag *is* a plain 7-bag. Verified
empirically: replaying against 7-bag holds the stack at 0-2 holes for 450 pieces, where every other
bag type buries it inside 50. Pinning the streak at 20/30/40/50/60 makes the reconstruction strictly
worse, confirming this run never crossed the threshold.

## The board: not recoverable

Four separate mechanisms, none of them in the replay:

**1. No attack confirms.** Zenith runs `passthrough: "full"`, so attacks never send the
`interaction_confirm` that stamps the frame garbage becomes tankable. The engine parks them at
`frame: MAX_SAFE_INTEGER - speed` and they never land. Recorded run: 241 attacks, 0 confirms.

**2. Continuous entry.** `garbageentry: "continuous"` queues each row and releases one every
`garbageare` frames (default 5), so the well rises *under a falling piece* rather than in a lump at
lock. Triangle.js only implements instant entry.

**3. A different column picker.** When `garbagefavor !== 0` the client does not pick uniformly. It
scores every column by `stackHeight + 5*distanceFromPreviousHole + 0.1*rng()`, sorts ascending, and
samples a weighted distribution where rank *k* gets `max(0, A + k*(20-2A)/9)` for `A = 10 + favor` —
strongly biased toward your lowest columns. It also burns 11 RNG draws per reroll against
Triangle.js's 1, so the streams desynchronise immediately.

**4. Per-frame option rewrites.** Every frame, from the current floor `a`:

```js
setoptions.messiness_inner  = 0.03 * a;              // 0.05 * a when expert
setoptions.messiness_change = 2.5 * messiness_inner;
setoptions.messiness_center = messiness_inner <= 0.15 && a <= 5;
setoptions.garbagefavor     = 33 - 3*a;              // 0 - 3*a when expert
setoptions.garbagephase     = 165 - 15*a;            // the entry delay, not garbagespeed
```

plus `TakeAllDamage` suppressing messiness by the current targeting grace
(`change -= 0.0375*grace`, `inner -= 0.015*grace`). The replay stores only the floor-1 snapshot of
these (`messiness_inner: 0.04`), while the run reached floor 10, where it is 0.3.

`survivalmode: "layer"` is **not** involved — that is set only by the `cheeselayer` mission.

## Result

Implementing all four against the real floor timeline (recoverable from `results.stats.zenith.splits`)
reaches **420 of 1312 lines** and **81 of 266 spin clears**. Unmodified Triangle.js reaches 371/56.
The remaining gap is not a tuning problem; too much of the state the model consumes is itself a
product of the simulation being correct.

Item 4 does, however, recover the one thing that matters for replaying the opening: **when the first
garbage lands**. Using `garbagephase` rather than the 20-frame default, the first row enters at piece
**468** instead of piece 67, because the player cancels almost everything before then. Three
independent signals agree on that boundary — the first lock to outrun its hard drop (467), the point
the stack starts accumulating holes (~450), and the first tank under the corrected delay (468).

`AddPendingGarbage` also scales incoming attacks by altitude
(`amt *= 1 + 0.004*(alt-a)**2/(alt+a)`, `a = max(min(3500, zthalt), min(2000, alt-1000))`), which is
why a run reports `garbage.received` far above the sum of its `ige` amounts — 1370 against 540 here.
Altitude is recoverable: `FloorDistance = [0,50,150,300,450,650,850,1100,1350,1650]` gives the
metres at each floor boundary and `splits` gives the frame each was crossed, so the climb
interpolates between ten exact anchors. Applied per attack against its own `zthalt`, this predicts
`garbage.received` as 1493 against a recorded 1370. It barely scales early attacks — at the first
one, altitude is 50.8m against the sender's 40.7 — so the first row still lands at piece 468, and
that boundary holds until the model over-delivers by more than ~35%.

What would close it: periodic `full` frames (complete board snapshots) in the stored replay. The
client already computes them — the options carry `fullinterval: 4993` and `fulloffset: 257` — but a
downloaded single-player `.ttr` contains none, so there is nothing to re-sync against.

## Correct option defaults

From the client's own options table, for anyone filling gaps in a sparse single-player replay
(these only store values that differ from default):

```
g .02   gincrease 0   gmargin 0          garbagespeed 20      garbagemultiplier 1
garbageincrease 0     garbagemargin 0    garbagecap 8         garbagecapincrease 0
garbagecapmargin 0    garbagecapmax 40   garbageabsolutecap 0 garbageholesize 1
garbageentry instant  garbageare 5       messiness_change 1   messiness_inner 0
messiness_nosame false messiness_timeout 0   messiness_center false
locktime 30   lockresets 15   spinbonuses "T-spins"   combotable "multiplier"
kickset "SRS+"   bagtype "7-bag"   boardwidth 10   boardheight 20   boardbuffer 20
stock 0   allclears true   allclear_garbage 10   allclear_b2b 0
b2bchaining false   b2bcharging false   b2bcharge_at 4   b2bcharge_base 0
infinite_movement false   infinite_hold false   allow_harddrop true   allow180 false
display_hold true   stride false   roundmode "down"   openerphase 0
garbagespecialbonus false   clutch true   garbageblocking "combo blocking"
garbagetargetbonus "none"   usebombs false   survivalmode "none"
```

## Ground truth from the client

The reconstruction above is what a downloaded replay alone supports. The client itself does better,
because it re-simulates a replay through the real engine to build its seekbar:

```js
s.setGame(n); s.setHeadless(true); s.startGame();
for (let e = 0; s.isPlaying() && e <= end; e++)
  if (s.doFrame(), e % 300 == 0) { const st = s.ejectState(); st.started = true; states.push(st); }
```

Each ejected state is complete — board, bag, hold, falling, `rng`, `rngex`, `cancelstreak`,
`bagid`, `impendingdamage`. Mapping one onto a Triangle.js `EngineSnapshot` needs two corrections:
the board is stored top-origin (reverse the rows), and the falling piece is top-origin anchored on
its matrix offset, so `x_tri = x - dx` and `y_tri = (height - 1) - y + dy` using the `dx`/`dy`
Triangle.js already exports. TETR.IO also counts "no combo" as 0 where Triangle.js uses -1.

Restored that way, windows with no garbage in play reproduce the next anchor exactly (10/10), which
is what proves the mapping. Windows with garbage reproduce 15/92 — the hole column remains
unrecoverable. Searching for it does not help: a per-window search over the exact anchor oracle
finds nothing, because windows carry up to 66 garbage rows, and reading the columns back off the
next anchor's `gb` rows recovers only two more windows.

Two things recover most of it. The first is that the column need not be known: replaying a failing
window under every hole column and keeping the placements all runs agree on is enough, because
garbage lands at the bottom while the player builds at the top. The second is that the column *is*
observable after all — `garbageentry: "continuous"` queues each row through
`garbageareentries.push({..., column, ...})`, so a capture watching array pushes sees it.

Varying the column alone over-trusts, though. `garbagephase` is known, but the ARE trickle that
releases a queued row over the following frames is not, and a window can disagree on how many rows
landed at all: 59 of 68 windows with recorded columns differ from the simulation on row count.

## The garbage model is not the lever

It is tempting to read the row counts as the problem, because the reconstruction lands far more
garbage than the client did:

```
                        rows received    landed    cancelled
client (truth)              1355           586        764
reconstruction              1356           987        369
```

Intake matches to within five rows, so the schedule of incoming attacks is exactly right and the
whole discrepancy is in how much gets cancelled before it enters. But closing it changes nothing.
Sweeping the entry delay until the landed count matches the client's does not verify one additional
window, and costs placements elsewhere. Implementing Zenith's continuous entry faithfully -- a lock
still picks the rows and their holes, but they rise one every `garbageare` frames instead of in a
lump -- is worth about 20 placements, and is the only piece of the real pipeline that is worth
anything at all (see below).

## What does work: search, not modelling

A 300-frame window holds ~21 pieces and a dozen interacting garbage events. No global setting
reproduces them all, but the client's state at the end of the window is a strong enough oracle to
search against: a board plus six counters is not something a wrong run matches by luck. So a window
that does not reproduce outright is searched, and kept whole only if some guess lands on the
anchor's whole state.

What the search needs is the right reading of the capture, and three of those took a while to find.

**A logged row is not a landed row.** `FightLines` spends an attack on `garbageareentries` before it
touches the incoming queue, and the capture logs pushes to that array, so a row can be logged and
then cancelled before it ever rises. Window 79 logs 22 rows; 8 landed.

**Cancelling takes rows off the front**, so the rows that survive to rise are the later ones. The
surviving columns in window 79 are the log's suffix -- `8,8,8,8,1,1,1,1` -- which is exactly what the
client's board shows.

**Rows carry over between windows.** A row is logged when it is tanked but rises one every
`garbageare` frames afterwards, often in the window after. Window 67 logs nothing and still takes two
rows, whose columns are in the window before it. Reading the rows as one stream rather than a
per-window tally was the single biggest gain.

So the count comes off the boards -- garbage rows gained, plus garbage lines cleared -- and never off
the log:

```
                                                  placements   verified   segments   spins
replay alone                                          468         468         86        65
+ states, whole-state check, clock schedules         1697        1623        318       219
+ cancelled rows come off the front                  1734        1662        324       224
+ rows carry over between windows                    1793        1768        333       230
+ landed count read off the boards                   1815        1790        335       231
- the agreement test, which was not sound             1792        1790        333       230
```

Those rows are the stages as they measured then, on the one replay the work was tuned against. The
code behind the middle ones is gone, and the segment counts predate sharing an over-long stretch out
evenly rather than leaving a stub -- the first row's 468 placements cut into 89 segments today, not
86.

Anchor density, not modelling, is what moves the rest. Across the nine runs, each with its own
capture, the same code recovers 59% of what their players placed at the client's stock 300-frame
spacing and all but six placements of 18575 at the ten the capture script asks for -- the only
difference between those two figures being how often the client was asked for a state.
[RECONSTRUCTION.md](RECONSTRUCTION.md) has the table, row by row.

No false accepts on any of them.

## What more runs are for

Every figure above was tuned against one replay, which is the shape of thing that overfits. Six more
runs, across three players, found two unsound rules and one real mechanic, none of them visible on
the first -- and a reported figure that was quietly wrong, since `dropped` was measured against the
plain reconstruction rather than against the pieces the anchors say the client placed.

The unsound rules were the agreement test and, after it went, a bound that assumed the replay's own
attack stream accounted for all garbage. Three windows in the third run tanked rows with nothing
pending, nothing waiting to rise, and not one attack arriving inside the window, so the bound now
concedes any window the capture logged rows in.

The mechanic is the spawn gate. An attack runs `sleeping -> caution -> danger -> spawn` on two
`garbagephase` timers, and `garbagephase` is `165 - 15 * floor`: 15 frames at floor 10, 150 at floor
1. On a floor-10 run the gate is 30 frames against 15 and measures as noise -- it cost the first run
26 placements, which is why it was dropped the first time it was tried. On a run that never leaves
the low floors it is 300 frames against 150, and the plain reconstruction reproduces 13 more windows
outright with it than without. The second run was the only way to see that.

## Verifying a window has to be able to fail

Two ways to accept a window that was reconstructed down the wrong path, both of which were doing so.

A **board** comparison passes a window whose garbage entered and was cleared again inside the same
300 frames. Piece and line counts, combo, b2b, hold and queue all have to land too. `garbage.attack`
is the one counter deliberately left out: `roundmode: "rng"` rounds fractional attack off the garbage
RNG and Zenith advances that RNG for reasons a replay does not record -- in windows where nothing
landed at all, the client still took up to 25 more steps -- so attack is not a function of the
placements, and requiring it rejects windows that were right.

The **agreement test** -- replay a failing window under every rival schedule, keep the placements
they all agree on -- says nothing at all if no rival lands any garbage in a window the client took
garbage in. They agree for the trivial reason. That hole made a larger `garbagephase` look like a
discovery worth 160 placements when every one of them was a false accept:

```
phase   placements   windows reproduced   false accepts
 x1        1951              75            4  (81 placements)
 x2        2002              74            5  (107)
 x4        2063              74            9  (190)
 x8        2110              74           13  (272)
```

Windows reproduced is flat; only the vacuous acceptances grow. Narrowing the rivals to schedules the
client's clock pins down cleared it on that run -- and a second and third run showed it was still
unsound, three more false accepts on a replay the search had not been tuned against. The test is
gone. A window either reproduces the client's whole state or it does not, and what survives a window
that does not is a bound, not an agreement: nothing the player locks before the earliest frame a row
could rise can depend on garbage.

That bound has to be conservative about where garbage comes from. Three windows in the third run
tanked rows with nothing pending, nothing waiting to rise, and not one attack arriving inside the
window -- garbage the replay's own stream does not account for. So the bound trusts the capture
rather than the reconstruction: if rows were logged as tanked in this window or the one before, it
concedes the whole window.

## The rule, and why implementing it changed nothing

The client's own bundle is reachable -- `scripts/tetrio-source.user.js` takes the stack at the moment
the engine pushes a state, which names the blob it was loaded from, and keeps the text at creation
before the loader revokes the URL. What it says:

- `garbageare` 5, `garbagearebump` 12, `cancelmultiplier` 1, `garbagequeue` false, and
  `garbageblocking: "combo blocking"`, which returns `!(lines || attack)` -- so TETR.IO tanks only on
  a non-clearing lock, exactly like Triangle.js.
- `ProcessGarbageARE` runs every frame: one row when `frame >= garbagearelockeduntil`, then
  `+= garbageare`. This is what makes `lasttanktime` the frame the last row rose, which the clock
  schedules rest on.
- An attack goes `sleeping -> caution -> danger -> spawn`, a `delay` timer each, and only `"spawn"`
  is tankable -- so the real gate is twice `garbagephase`.
- `FightLines` cancels out of `garbageareentries` first, then the incoming queue.
- Duplicate clears in all-spin push a solid, unclearable `gbd` line: present at 7 of 103 anchors.
- Triangle.js implements none of this. `garbageare` and `garbageentry` are in its option types and
  nowhere in its engine, and 4.2.7 is the latest release.

Implemented faithfully -- the 2x spawn gate, cancelling out of the ARE queue, `garbagearebump`,
restoring the incoming queue and the ARE state from the anchors -- every one of them is worth
nothing, and two are worth less than nothing:

```
                                   placements   verified
all of it                             1842        1790
without the pending-queue restore     1843        1790
without ARE-queue cancelling          1842        1790
without garbagearebump                1842        1790
```

None of it ships, because the model was never the binding constraint. The plain reconstruction still
lands 940 rows against the boards' 497, and it does so because its board has already diverged, not
because its garbage rule is wrong. Only `protectWounds` was kept, which stops Triangle.js clearing a
solid `gbd` line the moment a piece completes its row.

## Reading the holes rather than guessing them

Where nothing was cleared inside a window, the rows that arrived are still sitting at the foot of the
next anchor's board. Garbage enters at the foot, so the newest row is the bottom one and age runs
upwards: the hole columns can simply be read off, instead of being matched against the capture's log
of tanked rows. That log is the harder thing to line up, since a row is written to it when it is
tanked and may rise several windows later, or be cancelled and never rise at all.

## Where the rest of it is

The windows that do not reproduce are the ones where garbage arrives *interleaved* with the clears
that cancel it. Window 79 of the first run has the client clearing 6 garbage rows while rows keep
arriving; no schedule with a single spacing expresses that, and neither did two-run schedules with a
gap, at five times the cost.

Below 5 frames there is nothing left to learn: `garbageare` is 5, so a row cannot rise more often
than that, and asking every frame triples the capture to settle the order of a lock against a rise.
At either spacing every remaining failure is the board alone -- pieces, lines, combo, b2b, hold and
queue all land, and the boards differ by a garbage row. It was neither the timing nor the holes. A window that short has about six moments a row may rise
on, and enumerating every combination of them solved not one additional window; enumerating all ten
columns a single row could have taken was worth five placements in seven runs. What was left was
*where* the row went.

Two things live at `abovePerma`, and both had to be built.

Garbage enters there. A duplicate clear in all-spin leaves a solid, unclearable line at the
foot of the well, and every row after it stacks on top of that line rather than under it.
Triangle.js has no permanent line and splices garbage at the very bottom, so from the first
duplicate clear onwards every window holding garbage was off by one row and nothing could recover
it: 294 of 295 remaining failures in the worst run had a wound line at the foot. Letting Triangle
build the row and then lifting it over what is permanent takes that run from 87 dropped placements
to 3.

The line itself was the last of it. A repeated clear in all-spin -- same count, same spin, same piece
twice over -- drops a line with no hole, which no clear removes and only a timer takes away. Every
one of the seven placements still missing across eleven runs was in a window where one appeared. The
boards say when that happened, so the frame is the only thing left to find, and a window five frames
wide does not hide it for long.

## The same line under the allspin mod

Zenith's mods change that line, and the first run captured under `allspin` dropped 234 of its 440
placements on it. It is not solid there: nine `gbd` cells and one `gb`, the `gb` standing where the
hole of a garbage row would be. After a while it becomes exactly that row -- the `gbd` cells turn to
`gb`, the plug empties -- in place, and `received` does not move when it does. Fourteen opened over
that run, every one of them the oldest first, which is the one standing *highest*: a line enters at
the very foot of the well and the lines already there ride up over it. The base game cannot tell,
its lines being identical to one another, and garbage still enters above the lot.

So the test for one is a full row of nothing but garbage rather than a row of `gbd`, and the garbage
count has to stop counting the ones standing complete -- a row counted as garbage the moment its plug
appears is a row the window believes arrived. What is left is a frame, twice over: the one the line
appeared on and the one it opened on, neither of which the replay gives up. Both are searched the way
a rising row is, and the line is read off the next anchor rather than built, the anchor knowing which
column the plug took. That run then reconstructs whole, and the base-game runs come back unchanged
to the placement.

Protecting the line was a reconstruction concern only until a drill restored a board with one
standing on it: Triangle.js takes it at the first lock, which drops the stack a row and misjudges
every target after it. Half the segments of the allspin run start that way, and 21 of itamuyu's 386
do -- so the protection belongs to every engine built from a replay's options, not just the one the
reconstruction runs.

The lever is a shorter window. Seeking does not give one: the client builds its seek index once and
afterwards restores from it, and the seekbar is drawn on canvas so there is no control to drive. But
the index itself is built by reproducing the replay exactly:

```js
for (let e = 0; n.isPlaying() && e <= h; e++)
  if (n.doFrame(), e % 300 == 0) { const e = n.ejectState(); i.states.push(e) }
```

The client steps every frame of the run through the real engine and keeps every three-hundredth. The
whole reconstruction exists to guess at what it threw away, and the interval is one literal that
occurs exactly once in the bundle. `public/tetrio-dump.user.js` rewrites it as the script text is
handed to `new Blob`, before the browser runs it, so the client keeps a state every 10 frames
instead. That is the only place any of these scripts changes the client rather than watching it.

What a failing window still gives up is all of it bar its opening, and that is deliberate. The
alternative was an agreement test that looked like it recovered six times as much and was quietly
wrong about some of it.

## The piece that locks under another name

The bag above hands out an `i5` the first time the cancel streak reaches 40 -- once a run, and
never again. Of every run captured so far one has one: 5han's 2041m climb under `volatile_reversed`,
piece 798 of 846, stood on end in the second column on floor 10. Triangle.js has the pentomino,
kicks and all, and lays it exactly where the client did.

Where the two part is the name it leaves behind. The client colours pieces through
`tetrominoes_color`, which maps `i5` to `i` as it does every other piece outside the seven, so what
it writes into the board is five plain `i` cells; Triangle.js writes the piece's own symbol. The
window the pentomino locks in then differs from its anchor in those five cells and nothing else,
and a window that misses its anchor is dropped whole -- so the one piece a run is given once was
the one piece the trainer could never show. Reading the two names as the same mino on the board is
the whole of the fix, and that run comes back whole with it: 846 placements of 846.

Two smaller things follow from the same table. The pentomino is cyan, being coloured as an I, and
the trainer draws the falling piece and its preview that way rather than in the grey it keeps for a
mino it does not know. And finesse passes over it: the client's table carries a row per tetromino
and none for the pentomino, and `_InternalFinesse` charges nothing for a piece it cannot look up,
where the trainer had been charging every input it took.

## The Warlock pays for a spin that clears nothing

`allspin_reversed` -- "The Warlock" in the client's own table of mods -- rewrites what a clear is
worth, and one of its two rules moves a counter the windows are checked against:

```js
const spin = IsSpin();                       // set for a mini too, which carries both flags
if (zenith_mods[0] === "allspin_reversed") {
  if (lines && !spin) lines = 1;             // a clear without a spin is worth one line
  if (!lines && spin && stats.btb > setoptions.b2bcharge_at) b2bGain++;   // a spin without a clear
}                                            // is worth a back-to-back, once the bar is up
```

Triangle.js has neither rule. The second one cost inkly's 2292m run six of its 537 placements.
Seven pieces in it are spun into place and clear nothing; six of those find the bar already up,
`b2bcharge_at` being 4 and the counter standing at 25, 12, 11, 30, 34 and 6, while the seventh
finds it at 1 and earns nothing. Each of the six ends its window with the board, the piece and line
counts, the combo, the hold and the queue all landing on the anchor and the back-to-back one short
-- which is enough to throw the window away whole. Crediting the lock the way the client does
brings the run back entire, and leaves every other run in the corpus at the placement.

The first rule is left unmodelled. It changes what a clear *sends*, not what it clears, so it can
only reach an anchor through garbage that a window's attack would have cancelled, and the three
non-spin doubles in the run it would rewrite sit in windows that reproduce without it. The same
clause also means a quad with no spin pays no back-to-back under this mod; nothing in the corpus
has one.
