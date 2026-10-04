# How a run is reconstructed

What a downloaded replay gives up, what the client's own states add, and how much of a run
comes back either way. [ZENITH.md](ZENITH.md) has the Zenith findings in full.

## How it works

`simulate()` feeds the replay's keypress frames to `@haelp/teto/engine` one frame at a time and
records every lock: piece, rotation, position, occupied cells, spin type, hold state, lines cleared,
the board afterwards, and an engine snapshot taken at the moment the piece spawned.

`segment()` cuts that list so each segment ends on a placement worth reproducing -- a spin, or a quad
on its own. A stretch longer than the piece cap is shared out evenly rather than capped and left with
a stub: fifteen pieces under a cap of eight becomes 8 and 7, and ten becomes 5 and 5.

Each segment runs in two phases:

- **show** — the reference placements are animated. With target ghosts on, each piece is outlined at
  its destination before it drops in, over the board as it stood when the piece came down: garbage
  that rose while the piece was falling is already there, so the outline sits on the stack rather
  than above it.
- **do** — a fresh engine is restored from the segment's opening snapshot, so you get the same
  board, hold and queue, with the piece put back where it entered: the snapshot is taken once the
  piece is already falling, by which time the original player's held keys have usually moved and
  rotated it. Your keystrokes are converted to subframe-accurate keypress frames and
  ticked at 60 Hz, which means DAS, ARR, SDF, DCD, IRS/IHS and lock delay behave exactly as they do
  in game. Any placement that differs from the reference restarts the segment; matching the whole
  segment unlocks the next one. Any segment in the list can be picked at any time, passed or not, so
  a particular spin can be drilled without replaying what leads up to it.

The height climbed is shown above the board, written the way the client writes it on its own result
screen — grouped thousands, one decimal place taken rather than rounded, and a capital unit.

A placement matches when the piece, the cells it occupies, the spin the engine detected and the hold
slot all agree — the same result reached by a different rotation index still counts. It is matched
against every target of the segment still outstanding rather than only the next one, so holding a
piece to place a later one first is fine: the segment passes once all of its targets are filled, and
the board that leaves is the same board whichever order they went in.

With a **required pace** set, a placement also has to have been reached at it: a piece that brings
the turn's rate under the figure fails it the way a misplacement would. Nothing is asked at zero,
which is the default.

The rate is counted from the first piece of the turn landing, not from the first key pressed.
Reading a board you have just been handed is not playing slowly, and a rate taken over one piece
is not a rate at all — half a second of hesitation would fail the turn outright, where four pieces
later the same half second is averaged away by the ones around it.

The demo's **speed** is set in the same place, in pieces a second. The three beats a piece is spent
on — outlined where the rotation began, outlined where it lands, then solid — keep their
proportions and the whole is stretched to the pace asked for. What reads well at a learner's speed
crawls for someone who plays at four.

With **finesse** on, a placement also has to have been reached in the fewest inputs it could have
been. The minimums are the client's own table, and so is the rule around them: a 180 counts as two
inputs, and a piece the player soft dropped is not judged at all. That last part is why the option
does not fight an all-spin run — on the replay this was built against, 262 of its 266 spins were soft
dropped, so all of them come through clean, while 8% of its plain placements would not.

After each matching placement the board is handed over as the *next* reference piece found it, which
carries both the garbage that lock tanked and anything that rose while that next piece was falling.
Zenith trickles garbage in a row at a time rather than in a lump, so a piece often comes down on a
well a row or two higher than the one it spawned over; without that, any target resting on such a row
would sit above anywhere the piece could reach.

## What loads

Anything whose queue the engine can regenerate: Tetra League and custom-room `.ttrm`, 40 Lines,
Blitz, and any mode on a `7-bag` / `14-bag` / `classic` / `pairs` / `total mayhem` / `7+1` / `7+2` /
`7+x` bag with an `SRS`, `SRS+`, `SRS-X`, `TETRA-X`, `NRS`, `ARS`, `ASC` or `none` kick table.
A round the engine cannot reproduce says so in the status bar instead of failing quietly. A `.ttrm`
holds both players of every game, so both are offered; they are named for the game they shared
rather than for where they sit in the file, and a capture pairs with whichever of the two it
recorded — the seed cannot tell them apart, how the round ended can.

**Anything played against a human is trimmed to its opening.** Confirmation tells the engine when
an attack lands, not where the hole in it is: that is the sender's own RNG, and the sender is not
simulated here. So a league round is played both with its garbage and with none, and kept only as
far as the two agree — which is up to the first row that lands, typically ten to forty placements.
Past that the holes fall in the wrong columns, clears stop completing, and the well fills with
garbage that cannot be cleared: on the match this was checked against, 51 lines where the player
really cleared 108, and the last third of the round spent stacking pieces into a thirty-eight-row
wall. A capture fixes it, exactly as it does for Zenith, and one visit to each round captures both
players at once — a thirteen-round match comes back whole:

```
                    placements   lines    segments   spins
without a capture      525        ~half       ~92       74
with one               3350       1948        651      450
really played          3365       1948
```

Every line, and every placement but fifteen — one per round, laid after the last state the capture
holds, since a state is ejected every ten frames and a round does not end on one.

What the opponent sent cannot be worked out from this side: the amounts are theirs and the holes
are their RNG's. But the rows that landed are sitting at the foot of the next anchor's board with
their holes in plain sight, and ten frames leave few moments for them to have risen in — so a
window that will not reproduce is retried with exactly those rows and those holes, laid down on
each frame it could have been, as a lump and as a trickle. One of them reproduces the anchor.

**Zenith loads, but only in part.** Its `zenith` bag is not in the engine's table; per TETR.IO's own
`PopulateBag` it is a shuffled 7-bag plus extra pieces that appear only once `cancelstreak` reaches
20, and since clearing any garbage resets that counter, ordinary play never leaves plain 7-bag.
Zenith attacks also never send the `interaction_confirm` the engine waits on, so they are delivered
on arrival instead.

What cannot be recovered is the board underneath. Zenith runs `garbageentry: "continuous"` (rows
rise one every `garbageare` frames rather than in a lump at lock), rewrites `messiness_inner`,
`messiness_change`, `garbagefavor` and `garbagephase` every frame from the current floor, and the
replay stores only the floor-1 snapshot of those. None of it is in the file, and the engine models
none of it. What *is* recoverable is when garbage first lands. Zenith's entry delay is `garbagephase`
(165 - 15*floor, or 66 - 6*floor on expert), not the 20-frame default, and a run records the time it
reached each floor — so the delay can be reconstructed exactly. It is most of a second per floor,
which is the difference between an attack landing and the player cancelling it first.

Zenith also scales each incoming attack by how far above its sender you have climbed, which is
reconstructed from the floors the run crossed and the altitude it finished at — on the run this was
checked against that predicts `garbage.received` to within 9%.

The run is then simulated twice, with and without that garbage, and only the placements both agree
on are kept — those provably cannot depend on what is still guessed. A recorded 2194-piece Zenith
run yields the 468 placements before its first garbage lands: 89 segments, 54 of them ending on a
spin. The status bar says how much was dropped. [ZENITH.md](ZENITH.md) has the full findings.

## Ground-truth anchors

A downloaded replay can only be reconstructed so far. But TETR.IO's own client re-simulates a replay
headlessly to build its seekbar, stepping every frame through the real engine and ejecting a complete
state every 300th — correct by construction. `public/tetrio-dump.user.js` captures those from your
browser, and rewrites that interval to 10 first, which is where a run reconstructs whole: `garbageare`
is 5, so ten frames hold at most one garbage row rising and at most one piece locking. It runs under
[Violentmonkey](https://violentmonkey.github.io/), and the trainer serves it at
`/tetrio-dump.user.js`, which Violentmonkey offers to install when opened. Reload tetr.io with the
script enabled *before* opening the replay.

**Open the replay and press SAVE REPLAY beside EXIT.** That is the whole
of it: one file holding the replay and the states together, named for the run it came from —
`5han-7146m-9d11094f20ef.json.gz`, being who climbed, how far, and the id it can be found under
again. Nothing has to be downloaded first.

The replay comes out of the response the client already made: `/api/games/<id>`, packed in
theorypack — msgpackr under two extensions of TETR.IO's own, wrapping the body in a success
envelope with strings bundled. Those settings are the client library's own, from `@haelp/teto`'s
`theorypack`, and a response packed by it comes back through the script identical. The decoder
lives in the script rather than in the trainer on purpose: in the trainer it costs the bundle 70%,
and it is a capture-time concern.

Nothing has to be watched. The states are not a product of playback but of the headless
re-simulation the client runs to build the seekbar, and that finishes the moment a round is
opened -- twice over, once per player, which is how a league match yields both boards of every
round from one visit each. `zstates()` says what has been captured so far without writing
anything, and a count that has stopped growing means that round is done.

The button sits in the replay view because that is the only screen where both halves exist — the
states are made by opening the replay, so a button on the results screen beside *download .ttr*
would have nothing to write. It is a copy of the way out with its label changed, inserted into
whichever ancestor actually lays its children out side by side: clients wrap each button in a box
of its own often enough that inserting next to the button lands underneath it rather than beside.
`zdumpWhere()` prints that layout when it still goes wrong. `zdump()` writes a file by hand if it cannot be found, and `zdumpOff()` stops the capture
altogether; a capture with no replay in it is `replay-states.json.gz`, loaded beside a `.ttr` as
before.

A capture is a few tens of megabytes of JSON that repeats itself, and gzip takes the pair to a
twenty-fourth of that: 23.8 MB of `.ttr` and states becomes 1.0 MB.

The dump also carries the hole column of every garbage row, which is the one thing a replay cannot
give up: Zenith enters garbage continuously, so each row is queued through an array the capture can
see.

Load the bundle — or the dump alongside the `.ttr`, selecting both files — and each window between
two anchors is restarted from ground truth instead of reconstructed, so a wrong guess cannot travel
past one window. Several runs can be loaded at once, and a dump picked by hand pairs with the replay
whose seed it was captured under. Files are told apart by what is in them rather than by their
names, so a plain `.json` dump taken before any of this still loads. A window is kept whole only when it reproduces the next anchor's *whole state* — board,
piece and line counts, combo, b2b, hold and queue — since a board alone will accept a window whose
garbage entered and was cleared again along a different path.

Getting there is a search. The replay says when each attack arrived but not when its rows rose, so a
failing window is retried over schedules pinned to the client's own clock: each anchor records the
frame its last row rose on, and the boards say how many rows arrived, which leaves only the spacing
to guess. A window that still will not reproduce keeps only the placements the player locked *before
any row could possibly rise*, which cannot depend on garbage whatever the window's real schedule was.

Nothing else is kept. Every placement is either from a window that reproduced the client's whole
state or from one of those provably garbage-free openings.

Nine runs, each with its own capture:

```
run                          placements   segments   spins   dropped
5han/0c5528e61f45                  1387        271     212         0
5han/169c0230b55f                  1871        383     302         0
5han/280cd031922e                  2487        490     335         0
5han/9d11094f20ef                  2863        568     389         0
5han/d637aef0c6df                  2122        401     277         0
icly/5bb427f78da4                  2194        417     266         0
itamuyu/0808e2d260b2               1752        345     273         0
itamuyu/0aff0c7dba49               1960        386     253         0
itamuyu/806deee11423               1935        359     239         0
                                  ─────       ────    ────       ───
combined                          18571       3620    2546         0
```

Nine runs across three players, every one reconstructed whole. Each placement comes from a window
that reproduced the client's board, piece and line counts, combo, b2b, hold and queue; a window that
does not reproduce contributes nothing at all, and none of them failed.

Anchor density is what moves this, not the reconstruction. Resampled to the spacings the client
would have ejected at, the same nine runs come to 59% of what their players placed at its stock 300
frames, 95% at 30, and all but six placements of 18575 at the ten the capture script asks for -- and
the spread across runs closes with the spacing, from 43-78% to 92-99%, because there is less
and less left between two anchors for garbage to go wrong in:

```
spacing       anchors   placements   segments   spins   of the run
300 frames        917        10974       2161    1710         59%
30 frames        9142        17643       3434    2455         95%
10 frames       27418        18569       3620    2546        100%
```

The six are the last piece or two of four of the runs, laid after the final state their captures
hold, since a state is ejected every tenth frame and a run does not end on one. Reconstruction
takes well under a second a run at that spacing, and ten to forty seconds at 300, where a window
spans sixty times as many frames for garbage to have risen in.
