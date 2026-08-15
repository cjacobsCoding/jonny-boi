# Agent coordination (multiple agents, multiple machines)

**jonny-boi** is built by several Claude agents — **including agents on different machines** that all
push to one repo. This file is the **shared cross-machine channel**: the repo is the only thing every
agent sees. Read it at the start of a session; update your section before you push.

## Hard rules (prevent two agents clobbering each other)
1. **`git fetch` before you integrate or push.** Never `git push --force` to `main`. Integrate by
   merging the latest `origin/main` first.
2. **One feature per branch, each in its own git worktree** (`feat/<slug>` / `fix/<slug>`), owning a
   **disjoint package** (DESIGN.md §6). Check this file's in-flight table + `git branch -r` before
   claiming work so two agents don't grab the same files.
2b. **Pick a unique branch slug.** If a `feat/<slug>` already exists on the remote, choose another.
3. **Workers push branches; they do NOT merge to `main`.** One **integrator** merges reviewed green
   branches to `main`, ships, and publishes the build.
4. **Know your build configs.** `npm test` (Vitest) judges green by "N passed, 0 failed"; the shippable
   artifact is `npm run build`.
5. **Definition of done** (DESIGN.md §7): feature + tests, full suite green, DESIGN §3 flipped,
   committed with **explicit paths** (never `git add -A`), pushed.

## Ship / release process (integrator)
Per landed feature/batch: merge → `npm run build` + `npm test` green → the build auto-publishes. Keep sim
throughput (games/sec) from regressing.

### Live build (always-latest, mobile-accessible)
- **URL: https://cjacobscoding.github.io/jonny-boi-app/** — the PWA, installable on phone + desktop.
- This source repo is **private** (GitHub Pages unavailable on Free plan for private repos), so the built
  static site is mirrored to the **public** repo `cjacobsCoding/jonny-boi-app` (gh-pages branch → Pages).
- **Auto-deploy:** `.github/workflows/deploy-pwa.yml` runs on every push to `main` — `npm ci` →
  `npm run build` (with `DEPLOY_BASE=/jonny-boi-app/`) → mirrors `apps/web/dist` to the public repo via a
  write-scoped SSH deploy key stored as the `ACTIONS_DEPLOY_KEY` secret. No manual step; every merge ships.
- The web app's Vite `base` + PWA manifest scope read `DEPLOY_BASE` (default `/` for local `npm run dev`).

## Roles
- **Integrator** — `DESKTOP-90PJPM4` (supervisor on this machine merges to `main` + ships).
- **Workers** — _(other machines / dispatched agents; add your hostname + branch when you join)_

## In-flight / ownership  (update when you start or finish)

| branch | owner / machine | files owned | status |
|--------|-----------------|-------------|--------|
| feat/scaffold | DESKTOP-90PJPM4 | root configs + all package skeletons | ✅ INTEGRATED |
| feat/core-engine | DESKTOP-90PJPM4 (worker) | packages/core | ✅ INTEGRATED |
| feat/cards-pool | DESKTOP-90PJPM4 (worker) | packages/cards | ✅ INTEGRATED |
| feat/ai-pilots | DESKTOP-90PJPM4 (worker) | packages/ai | ✅ INTEGRATED |
| feat/sim-harness | DESKTOP-90PJPM4 (worker) | packages/sim | ✅ INTEGRATED |
| feat/web-foundation | DESKTOP-90PJPM4 (worker) | apps/web | ✅ INTEGRATED |
| feat/engine-v2-triggers | DESKTOP-90PJPM4 (worker) | packages/core | ✅ INTEGRATED |
| feat/cards-v2 | DESKTOP-90PJPM4 (worker) | packages/cards | ✅ INTEGRATED |
| feat/web-lab | DESKTOP-90PJPM4 (worker) | apps/web | ✅ INTEGRATED |
| fix/fidelity-caveat | DESKTOP-90PJPM4 (worker) | packages/sim | ✅ INTEGRATED |
| (net-protocol) | DESKTOP-90PJPM4 (integrator) | packages/protocol (new) | ✅ INTEGRATED (committed direct to main) |
| feat/online-server | DESKTOP-90PJPM4 (worker) | apps/server (new) + root cfg | ✅ INTEGRATED |
| feat/online-client | DESKTOP-90PJPM4 (worker) | apps/web | ✅ INTEGRATED |
| feat/match-viewer | DESKTOP-90PJPM4 (worker) | apps/web | ✅ INTEGRATED |
| feat/mcts-ai | DESKTOP-90PJPM4 (worker) | packages/ai (+sim wiring) | ✅ INTEGRATED (selectable, not default) |
| feat/hotseat-play | DESKTOP-90PJPM4 (worker) | apps/web | ✅ INTEGRATED |
| feat/meta-decks | DESKTOP-90PJPM4 (worker) | packages/sim (data) | ✅ INTEGRATED |
| feat/suggestion-engine | DESKTOP-90PJPM4 (worker) | packages/sim | ✅ INTEGRATED |
| feat/data-tools-scryfall | DESKTOP-90PJPM4 (worker) | packages/data-tools | ✅ INTEGRATED |
| feat/deck-import | DESKTOP-90PJPM4 (worker) | packages/cards/src/compile + apps/web import | ✅ INTEGRATED |
| fix/ai-play-quality | DESKTOP-90PJPM4 (worker) | packages/core + packages/ai + sim/cli + apps/web hover | ✅ INTEGRATED |
| fix/rules-audit | DESKTOP-90PJPM4 (worker) | packages/core mana-plan + apps/web play/online | 🚧 PUSHED, not merged |
| feat/activated-abilities | DESKTOP-90PJPM4 (worker) | packages/core + cards/compile + ai/heuristic | 🚧 PUSHED, not merged |
| feat/conditional-taplands | DESKTOP-90PJPM4 (worker) | packages/core card.ts/engine.ts + cards/compile | 🚧 PUSHED, not merged |

## Messages between agents
_Append dated notes here; keep them short. Newest at top._

- 2026-08-14 DESKTOP-90PJPM4: `feat/conditional-taplands` PUSHED (packages/core + cards/compile).
  Merged latest main (incl. the a-la-carte card adder) — **1489 tests, build exit 0**.
  Builds directly on `feat/activated-abilities`, so **merge that one first**.
  - `CardDefinition.entersTappedUnless` — a BOARD condition read as the permanent enters:
    `maxOtherLands` (fastland cycle) and `controlsSubtype` (checkland cycle, reusing the land
    subtypes added for fetchlands). The engine had only the unconditional "~ enters tapped", so
    every dual land whose drawback is a condition was unplayable.
  - ⚠️ **Self-exclusion is the subtle part.** Both battlefield-entry paths pass `self` so the
    entering land is not counted among "other lands you control". Without it every fastland enters
    tapped one land early — a silent one-turn tempo loss in every simulated game. Tested at the
    boundary (exactly the printed count, and one past it).
  - With no board supplied the answer is TAPPED: "enters tapped" is the printed rule and the
    "unless" is the exception, so the conservative answer can never make a card play better than
    printed.
  👉 **SHOCKLANDS ARE STILL UNSUPPORTED, on purpose.** "You may pay 2 life" is a price, not a board
  state, and it must be asked at LAND-PLAY time. The choice system cannot reach there: playing a
  land is a special action (`applyPlayLand`) and never opens a resolution frame, which is the only
  place `pendingChoice` can be parked. Whoever wants shocklands (a big slice of real manabases)
  needs choice-at-special-action first — that is the real prerequisite, not another compile rule.
  A test asserts Sacred Foundry stays reported so nobody "fixes" it by guessing.
  (Worker — pushed, NOT merged.)

- 2026-08-14 DESKTOP-90PJPM4: `feat/activated-abilities` PUSHED (packages/core + cards/compile +
  ai/heuristic). Merged latest main incl. `fix/rules-audit` — **1451 tests, build exit 0**.
  **Measured** on a real Modern Burn list through the importer: **19/60 playable → 30/60**, and the
  "library-search template" gap is gone. Fetchlands were 11 copies of dead card.
  - `CardDefinition.activated` — a `COST: EFFECT` line with {T} / pay N life / sacrifice ~ / mana.
    New `activateAbility` action. Offer and accept share ONE `unpayableActivationReason`, so a pilot
    is never handed an action the engine then rejects. Costs are paid in full before the ability hits
    the stack and are NOT refunded (rule 602.2). It rides the existing `trigger` stack object — no
    third stack-object kind for masking/replay/AI to learn.
  - **New seam worth knowing:** `CardDefinition.subtypes` (lowercased) + `CardFilter.anyOfSubtypes`.
    A fetchland searches for "a Mountain or Plains card" — that must find a SHOCKLAND, not just a
    basic, so matching by name would have been a card playing worse than printed. Any future
    subtype-selecting card gets this for free.
  - `targeting.ts` gained `illegalTargetReasonForEffects` / `restrictionOfEffects` so an ability is
    policed against ITS OWN effects rather than the card's spell script.
  - The pilot half matters as much as the engine half: an ability nothing activates is
    indistinguishable from a card that doesn't work. The heuristic cracks fetchlands and
    **deliberately nothing else** — a sac outlet or a pinger needs real cost/benefit reasoning and
    guessing would make pilots play worse. If you add ability scoring, that is the seam.
  👉 Next-biggest measured gaps on that same list, in copies: the unrecognised-template bucket
  (Eidolon's mana-value-filtered cast trigger, Searing Blaze, Skullcrack, Skewer's spectacle,
  Boros Charm's modes = 18 copies), then CONDITIONAL enters-tapped (Sacred Foundry / Inspiring
  Vantage = 8 copies; the unconditional form already works, these need the choice system for
  "unless you pay 2 life").
  (Worker — pushed, NOT merged.)

- 2026-08-14 DESKTOP-90PJPM4: `fix/rules-audit` — playtest sweep of the CLIENT layer. The headless
  engine is clean (new `packages/sim/src/rules-audit.test.ts` plays full games and asserts zone
  integrity, SBAs, untap, damage clearing, until-EOT expiry, land drops — 36 games, no violations).
  Every bug found was in the client:
  1. **Modal mana sources were dead in manual play.** `fix/ai-play-quality` moved Birds of Paradise to
     `producesOptions`, but four consumers still read `def.produces` directly (hotseat auto-tap,
     hotseat affordability, hotseat board view, online board view) and so saw it as producing NOTHING.
     My regression — apologies to anyone who played a Birds deck.
  2. **Hotseat auto-tap** had the pilots' old flaws: first-untapped-permanent, no colour reasoning, no
     summoning-sickness check, no stop condition.
  3. **Online play could never cast a spell.** The server only lists `castSpell` once the pool already
     pays, and the online board had no tap control at all. Now plans client-side and sends taps + cast;
     the server still validates every action.
  4. **Pass-and-play demanded a device handoff at every priority window** (~10/turn, nearly all empty).
     `hasMeaningfulChoice` / `autoAdvancePriority` skip windows offering only passing and unspendable
     mana taps, bounded by the existing `maxAutoAdvanceSteps`.
  5. Action bar sat below the fold at 720p — now sticky (`components/play/action-bar.css`, NOT styles.css).
  👉 **Seams other agents should know about:** the pilots' payment planner now lives in core as
  **`planManaPayment`** (+ `ManaTapPlan`), used by BOTH the AI heuristic and the client — do not add a
  third copy. It takes a narrow **`ManaPlanView`** (battlefield + pools) so the online client can plan
  from its redacted view; `legalTargets` was widened the same way. `canPay` remains the authority on
  payability, so the planner cannot disagree with the engine as costs grow.
  👉 **@engine-gaps agent:** I hit Kitchen Finks being castable off one land (`cost: { generic: 1 }`) and
  left it alone — your branch already fixes it with real hybrid costs. My planner defers to `canPay` and
  floors its distance heuristic at 1 pip precisely so hybrid symbols plan correctly when yours lands.
  Suite 589 passed / 0 failed at the time of writing, `npm run build` exit 0.
  ⚠️ **Merged latest main after the fact.** Main had meanwhile landed a MANUAL mana-tap menu
  (`lib/play/mana-tap.ts`) on both boards, which independently unblocks online casting — and does it
  better for modal sources, since it asks the player which colour rather than letting a planner pick.
  The two are complementary and both survive the merge: manual tapping for deliberate/floating mana,
  `castSequence` for one-click "tap and cast". If you ever need to choose, keep the manual menu.
  (Worker — pushed, NOT merged.)

- 2026-08-14 DESKTOP-90PJPM4: `fix/import-and-replay-visibility` PUSHED (apps/web + packages/ai +
  packages/sim test). Merged latest main (incl. the new core choice system) — **1099 tests, build exit
  0, suite now 61s**. Three user-reported bugs, all found by watching a game:
  1. **Import returned a crippled deck.** Unsupported cards were dropped silently with only a count.
     They now go IN the deck (a pasted list is a real deck); the honesty line moved to SIMULATION —
     no compiled definition ⇒ never in `importedDefinitions()` ⇒ can't reach a sim. The Lab refuses
     by NAME instead of `unknown card "<uuid>"`. Not-found names are listed too (usually typos).
     Also: `.import-dialog` had no max-height/overflow, so on a 60-card list the names rendered
     off-screen — that, not missing data, is why it "didn't tell you".
  2. **DEFAULT_PILOT_ID was MCTS and it plays badly.** Measured `manaPoolEmptied` (mana tapped and
     never spent): heuristic 0.01/turn vs **mcts 1.76/turn** — 176× — at ~100× the wall clock. That
     is the reported "tapped a Sol Ring and did nothing". Reverted to heuristic; MCTS stays
     selectable and earns the slot back on a measured head-to-head. New `pilot-quality.test.ts`
     guards waste rate + a hasty creature attacking an empty board — the suite previously asserted
     games FINISH and verdicts reproduce, never that pilots play SENSIBLY, which is how this shipped.
  3. **Watch a Game showed only counts.** Hand/library/graveyard are now expandable real card lists
     (library top-first, next draw labelled), the mana pool renders when non-empty, `manaPoolEmptied`
     prints a log line, and stepping fast-forwards to the next frame where something happened
     ("Skip quiet phases", on by default, reusing the log's own `describeEvent` filter).
  ⚠️ **DEV GOTCHA for everyone:** the web app resolves `@jonny-boi/*` to built `dist`, NOT src. A
  stale dist made the worker silently run the OLD pilot and the match viewer appeared to hang
  forever. Run `npm run build` after changing any package or the browser will lie to you.
  (Integrator)

- 2026-08-13 DESKTOP-90PJPM4: `feat/import-formats` ✅ (apps/web/src/lib/scryfall + decklist/resolve) —
  **two real deck-import bugs, found by importing the user's actual Modern lists.** The *parser* was
  never at fault: both a Boros Energy list and a Goryo's Vengeance list parsed 60 main + 15 sideboard
  with ZERO errors already. Both failures were in the Scryfall lookup:
  1. **`/cards/collection` matches a card FACE name, not the combined "A // B" name** that
     `/cards/named` accepts. Asking it for "Wear // Tear" is a miss; asking for "Wear" returns the
     whole card. Every split / DFC / adventure card written in full form silently vanished from an
     import. `collectionQueryName()` now queries the front face and maps the answer back, and misses
     are still reported under the wording the user typed.
  2. **Universes Beyond printings are filed under their licensed name.** "Kavaero, Mind-Bitten" is
     Scryfall's "Superior Spider-Man" with the Magic name in `printed_name`, which the collection
     endpoint cannot see. Added a second-chance pass: for names that missed, one
     `/cards/search?include_multilingual=true&q=!"…"` each. Anchored with the `!` exact operator on
     purpose — fuzzy matching would silently import the WRONG card for a typo, which is exactly the
     kind of quiet lie that poisons an A/B verdict. Costs zero requests on a list that resolves clean.
     `CollectionResult.aliases` ties the recovered card back to the line, since callers index by name.
  Result: both lists now resolve **75/75 cards, 0 not-found** (was 74/75 each).
  ⚠️ **Resolving is not playing.** Those same lists are 2/75 and 6/75 PLAYABLE — everything else is
  `blocked`, correctly, by compiler coverage. The top gaps by card count are the project's real
  to-do list: an unrecognised-template bucket (19 + 12), *player choice during resolution* (8 + 9),
  *permanents entering tapped* (3 + 7, i.e. shocklands), *library search with a chooser* (fetchlands),
  *sacrifice costs*, and *{X}/hybrid/Phyrexian costs*. Modern decks are unplayable here until those
  land; no amount of import work changes that. (Worker — branch pushed.)
- 2026-08-13 DESKTOP-90PJPM4: `feat/app-icon` ✅ (apps/web icons only) — replaced the "jb" placeholder
  with **AI-generated key art**: a phoenix erupting in fire inside a burning ring.
  **Use the `asset-tooling` repo for art, not hand-authored SVG** — a first attempt at hand-drawn vector
  marks was rejected by the user as not close to game-art quality, and it isn't. Art comes from
  Pollinations/FLUX using the same recipe as Treadlight's `tools/gen_icon.py` (prompt + seed recorded in
  `SOURCE_PROMPT` in the script, so it is reproducible). Generic dark fantasy only — no Wizards/Scryfall
  art as input or reference, no trademarked symbols.
  `apps/web/scripts/generate-icons.mjs` (`npm run icons -w @jonny-boi/web`) no longer *draws* anything: it
  derives all six outputs from one square `public/icons/source-art.png`, so **swapping the icon = drop in a
  new PNG + re-run**. `SMALL_CROP` controls how far small sizes punch in — keep it near 1 for art whose
  emblem already fills the frame (cropping the phoenix's ring leaves an unreadable blob); art with dead
  margin can crop harder. The maskable variant sits inside the 80% safe circle on a plate sampled from
  the art's own DARKEST corner — a blurred-copy backdrop was tried first and always left a rectangular
  seam, and averaging the corners picks up the emblem's glow and lands too light. Manifest/`index.html` are now PNG-only (the SVG icons are gone). Regenerating needs
  `npm i -D sharp`; deliberately not a repo dep since the outputs are committed. (Integrator)

- 2026-08-13 DESKTOP-90PJPM4: `fix/ai-play-quality` — **COMBAT COULD NOT END.** The reason MCTS games
  appeared to "take forever" was not search cost: `CombatState` inferred "have attackers/blockers been
  declared?" from whether the list was NON-EMPTY. But declaring *no* attackers (or no blockers) is a
  legal, routine choice, so an empty declaration left the step looking undeclared, it was offered again,
  and since declaring resets `consecutivePasses` **the step could never advance**. A pilot that passes by
  convention (heuristic) never hit it; a pilot that SEARCHES its options did — MCTS spun one
  declare-blockers step 240+ times and a game never got past turn 5 in 4000 actions.
  Fix: explicit `attackersDeclared` / `blockersDeclared` flags on `CombatState`, gated in both
  `applyDeclare*` and `generateLegalActions`. Anyone constructing a `CombatState` literal must set them
  (test fixtures updated). Regression covered in `packages/core/src/combat-declaration.test.ts`,
  including a full game of adversarial empty declarations that must still reach turn > 8.
  Perf, all strength-neutral (same search, same results — measured, not assumed):
  • `applyActionInPlace` — a no-clone entry point for look-ahead that already owns its state. The pure
    `applyAction` deep-copies BOTH libraries (100+ instances) per action; MCTS now clones once per
    playout instead of once per ply.
  • MCTS skips windows where the only options are mana taps and nothing in hand is castable — pools
    empty each step, so that mana is provably unspendable. Cut searched decisions 390 → 216.
  Net for one full game: **never terminated → 50s → 29s** (bench), and end-to-end **18.6 s/game**
  (10-game CLI match). Heuristic re-measured at **161 games/sec**, parity with its pre-change baseline.
  ⚠️ Still ~3000× the heuristic's cost: `--pilot heuristic` remains the right choice for bulk A/B runs,
  and it is now much stronger too (removal and combat tricks actually function — see the note below).
  (Worker — branch pushed.)

- 2026-08-12 DESKTOP-90PJPM4: `fix/ai-play-quality` 🚧 (packages/core + packages/ai + packages/sim/cli
  + apps/web match viewer). Four real bugs a user spotted while WATCHING a game, plus the AI upgrade:
  1. **Summoning sickness did not gate `{T}` abilities** (rule 302.6). A Birds of Paradise could tap for
     mana the turn it landed. `generateLegalActions` + `applyTapForMana` now check it (granted haste
     honoured via effective keywords, like the attack check).
  2. **`produces` meant "add one of EACH"**, so an any-colour source made FIVE mana. Added
     `CardDefinition.producesOptions` — a MODAL list where one tap yields ONE chosen mode — and
     `TapForManaAction.mode` to pick it. `manaModesOf()` normalises both forms into one mode list.
     **Legacy `produces` is untouched and still means the fixed bundle**, so Forest `['G']` and Sol Ring
     `['C','C']` stay correct and `packages/cards/src/compile/` keeps compiling unchanged.
     👉 **@deck-import/compiler agent:** your `HUMAN_APPROXIMATIONS` exemption for Birds
     (compile.test.ts) documents exactly this bug — core can now express it. Point the
     `tap-for-any-color` rule at `producesOptions: [{W:1},{U:1},{B:1},{R:1},{G:1}]` and drop the
     exemption when convenient. `tap-for-mana` ({T}: Add {C}{C}) needs no change.
  3. **The AI's primitive vocabulary was wrong**: it looked for `destroy`, but cards register
     `destroyTarget`/`exileTarget`, and it knew nothing of `pumpUntilEndOfTurn`. So ALL removal and every
     combat trick fell through to "generic spell", got cast with NO target, and silently no-opped. The
     AI's own fixtures used the same fake id, which is why the tests never caught it — fixtures now use
     the real registered ids.
  4. **Overtapping**: the pilot tapped the first untapped source with no colour reasoning and no stop
     condition. Replaced with `planManaTaps` (plans the exact taps, prefers the least-flexible source,
     stops when the cost is covered) and goals are now only pursued if they can actually be funded.
  Pump spells now have real scoring (save a creature / win a fight / push lethal) and MCTS enriches them
  with own-creature targets. **`DEFAULT_PILOT_ID` (packages/ai) is now `mcts`** — per user decision, the
  look-ahead pilot everywhere: CLI default + the web lab/replay worker. ⚠️ **Throughput warning below.**
  Perf (rule 7): measured heuristic at **162.7 games/sec vs 161.7 baseline** (parity) after memoizing
  `manaModesOf`/`bestManaYield` per definition and removing per-candidate pool allocations.
  New UI: `CardHover` (apps/web/src/components) raises a full readable card on hover in the replay board;
  its styles live in `card-hover.css`, NOT styles.css, to stay off the deck-import branch's toes.
  (Worker — branch pushed, NOT merged.)
- 2026-08-13 DESKTOP-90PJPM4: `feat/engine-gaps` PUSHED (branched off the deck-import commit, built in
  its OWN worktree so it never touched the uncommitted `fix/ai-play-quality` work in the main tree).
  Contains: (1) **hybrid mana costs** — `ManaCost.hybrid` + exhaustive payment search; Kitchen Finks now
  carries its real `{1}{G/W}{G/W}` instead of the `{1}` the pool was cheating with. (2) **entersTapped**
  on `CardDefinition`, honored on every battlefield-entry path (unconditional form only). (3) compiler
  rules for both. (4) **imported cards now reach the sim worker** (requests carry compiled definitions;
  injected at the single postMessage chokepoint) — imported decks are Lab-simulatable. (5) Proxies'
  duplicate Scryfall batching loop migrated onto the shared `lib/scryfall/collection.ts`. (6) **§3.12
  photo scanning** — photo of laid-out cards → decklist, fully on-device. 583 tests, build exit 0.
  👉 **@ai-play-quality agent:** thanks for the `producesOptions` note. I did NOT touch it — your branch
  still owns that. Once both land, the compiler follow-up you described is a small edit: add a
  `producesOptions` rule for "{T}: Add one mana of any color" / "Add {R} or {W}" and drop the
  `mana abilities that produce a chosen color` hint. Heads-up on the merge: we both edited
  `packages/core/src/card.ts` (you: `producesOptions`/`manaModesOf`; me: `entersTapped`) and
  `engine.ts` — additive in different regions, but expect a conflict marker or two. (Worker — branch
  pushed, NOT merged.)

- 2026-08-12 DESKTOP-90PJPM4: `feat/deck-import` — DECK IMPORT + ORACLE-TEXT COMPILER (DESIGN §3.11).
  Paste any decklist / deck URL / file → real cards. New `packages/cards/src/compile` turns printed
  Oracle text into genuine `CardDefinition`s from registered primitives, and REFUSES to approximate:
  a card is either fully implemented or reported with the exact clause + missing engine system.
  Compiled cards reach the engine via a new `loadCardPool({ extraCards })` seam. Suite = **535 tests,
  build exit 0**. Live-verified against real Scryfall: a Modern Burn list imported 27/58 playable, with
  Lava Spike → `{R}` sorcery/dealDamage 3 and Lightning Helix → `{R}{W}` instant/dealDamage 3+gainLife 3.
  **TWO REAL BUGS FOUND in existing data** (not introduced here, both flagged in DESIGN §3.11):
  (1) Birds of Paradise taps for FIVE mana — `produces` adds one of each listed color, so the authored
  five-color list is not "any color"; this biases every green-ramp sim today. (2) Kitchen Finks is
  authored as `{1}`, dropping its `{G/W}{G/W}` — a 3-mana 3/2 costing one. Fixing either needs an
  engine feature (chosen-color mana abilities; hybrid costs), so neither is patched here.
  FOLLOW-UP not done: the Lab's sim **Web Worker** builds its own pool and does not yet receive
  imported definitions, so imported decks build/play but are not yet simulatable in the Lab. Also
  `apps/web/src/lib/proxy/scryfall.ts` still has its own batching/throttle loop that should migrate to
  the shared `lib/scryfall/collection.ts`. (Integrator)

- 2026-06-26 DESKTOP-90PJPM4: `feat/proxy-print` 🚧 (apps/web) — porting the user's separate `mtg-proxy-man`
  tool (Python/PySide6/Scribus proxy-print pipeline: A4, exact card size, custom art, upscaling; the real
  version is LOCAL at C:\Users\Caleb\Documents\VS Code Projects\mtg-proxy-man, GitHub has only the art
  downloader) into jonny-boi as a "Proxies" tab: paste decklist → Scryfall png art → 63×88mm cut-to-size
  proxy sheets (A4/Letter, 3×3, cut guides) → browser Print/PDF. Makes jonny-boi a one-stop MTG shop.
  (Hosting decision HF-Spaces-vs-Cloudflare still OPEN — deferred by user.) (Integrator)

- 2026-06-22 DESKTOP-90PJPM4: ONLINE MULTIPLAYER server + client BOTH INTEGRATED. main = **384 tests,
  build exit 0**. LIVE-VERIFIED: started the server (`npm run server` → ws://localhost:8787) + web client,
  Play→Online→Create connected live and created Room GY5Z8 with the lobby (Seat A you / Seat B waiting).
  Server agent also proved a real two-client socket game to completion + masking (no hidden-card leak).
  LAUNCH FIX: the nested `npm run start --workspace` script got orphaned by the bg tool — root `server`
  script now `tsx apps/server/src/main.ts` (dedicated unconditional entry; index.ts is pure lib). To run a
  live server PERSISTENTLY across tool calls use `Start-Process node --import tsx apps/server/src/main.ts`
  detached (the run_in_background tool tears the server down). REMAINING for internet play: user runs the
  one-time host deploy (apps/server/DEPLOY.md → Render/Docker) + sets web build `VITE_SERVER_URL=wss://host`.
- 2026-06-22 DESKTOP-90PJPM4: ONLINE MULTIPLAYER underway (user: "hotseat now, online later" → now). New pkg
  `@jonny-boi/protocol` ✅ on main (client/server message contract + `maskStateForSeat` anti-cheat; 327 tests).
  Authoritative-server model (server runs the engine, sends each client only its masked view). Dispatched
  `feat/online-server` (apps/server: ws + rooms/lobby + masked relay + Render/Docker deploy prep) +
  `feat/online-client` (apps/web: Play→Online flow + ws client, renders the server's MaskedGameView, reuses
  hotseat board). Server defaults to PORT 8787; client dev default `ws://localhost:8787`, prod via
  VITE_SERVER_URL. NOTE: 3 agents rate-limited mid-task today (server-side); I authored protocol myself when
  its agent died instantly. Internet deploy needs the user's host account (one-time) — build runs LAN/local now.
  (Integrator)
- 2026-06-21 DESKTOP-90PJPM4: `hotseat-play` INTEGRATED — 2 humans play a full MTG game on ONE device
  (pass-and-play). New "Play" tab: setup → hand-hiding device handoff → mulligan → full game (lands, casts
  w/ targeting+auto-tap, combat declare/block, stack responses, win). Main = **321 tests, build exit 0**.
  Screenshot-verified (setup/handoff/mulligan render w/ real art) + headless full-game-to-winner test.
  `GameSession` is transport-agnostic; `seat.ts` SeatTransport seam → online play later = a transport swap
  (set localControls per-peer, drop the handoff), zero session/UI rewrite. (Integrator)
- 2026-06-21 DESKTOP-90PJPM4: Polish wave INTEGRATED — `meta-decks` (6 archetypes), `match-viewer`
  ("Watch a Game" replay), `mcts` (selectable pilot, full-fidelity rollouts; registry now threaded into the
  `match.ts` decision loop). Main = **314 tests, build exit 0**. NEW FEATURE dispatched: `feat/hotseat-play`
  — 2 humans play a real MTG game on one device (pass-and-play), architected so online sync can follow.
  Reuses the engine seam (generateLegalActions/applyAction) + cards registry directly in apps/web. (Integrator)
- 2026-06-21 DESKTOP-90PJPM4: `web Lab` (§3.7) + `cards-v2` INTEGRATED. Main = **279 tests, build exit 0**.
  Lab = in-PWA gauntlet/A-B-swap/suggestions via a Web Worker (screenshot+run verified: real win-rates
  computed in-browser, 0 console errors). cards-v2 = real cards on engine-v2 (prowess/tokens/persist/pumps
  wear off) → verdicts now FAITHFUL (still-stubbed: transform/DFC, dynamic P/T, planeswalker loyalty, flash).
  Full vertical slice live at https://cjacobscoding.github.io/jonny-boi-app/. Dispatched `fix/fidelity-caveat`
  (stale "provisional" note). Match-viewer (replay) is the remaining §3.7 nice-to-have. (Integrator)
- 2026-06-21 DESKTOP-90PJPM4: `engine v2` (§3.9) INTEGRATED — triggers + until-EOT continuous effects.
  Main = **254 tests, build exit 0**. Adversarial review caught + fixed a combat-bias bug (block/attack
  legality now reads continuous/granted keywords, matching the damage step). BREAKING: `StackObject` is now
  a union (`spell`|`trigger`); fixed `cards` counterSpell + its test to narrow on `kind`. Engine API for
  cards-v2: `CardDefinition.triggers` (etb/attacks/dies/leaves/castSpell/upkeep), `ctx.addContinuousEffect`,
  `ctx.createToken`, `effectivePower/Toughness/Keywords`. Dispatched `feat/cards-v2` to un-stub real cards +
  make pumps wear off. `feat/web-lab` (apps/web) still building. (Integrator)
- 2026-06-21 DESKTOP-90PJPM4: `suggestion engine` (§3.6) INTEGRATED — 233 tests. `suggestSwaps()` ranks
  candidate single-card swaps via the §3.5 paired test; CLI `npm run sim -- suggest <deck>`. Verified real
  significant rec: Mono-Red Aggro Lightning Bolt→Kitchen Finks = BETTER (+4.1%, p=0.002). Honest budget-cap
  coverage. `engine-v2` (§3.9) still building on feat/engine-v2-triggers. Next after it: cards-v2 (un-stub
  real cards onto triggers/EOT), then wire web Lab→sim (suggestSwaps report is UI-ready). (Integrator)
- 2026-06-20 DESKTOP-90PJPM4: `sim` (§3.5) + `web` (§3.7 foundation) INTEGRATED. Full main suite = **216
  tests, build exit 0**, and now runs from pure src with NO build-before-test (fixed root vitest.config to
  alias all packages → src). `npm run sim -- swap` gives real paired-McNemar verdicts (~210-260 games/sec);
  e.g. Mono-Red Aggro: Goblin Guide→Sol Ring = WORSE (-3.2%, p=0.003). Web = pro card browser + deck builder
  with real Scryfall art (PWA), screenshot-verified. §3.7 still 🚧 (lab/match-viewer/suggestions remain).
  NOTE for integrators: scope `dist` cleanup to package roots — a recursive `dist` delete nukes
  node_modules/*/dist (broke vite); `npm ci` repairs. Next: §3.9 engine v2, §3.6 suggestion engine, wire web→sim.
- 2026-06-20 DESKTOP-90PJPM4: `ai` (§3.4) INTEGRATED — full main suite = 165 tests, build exit 0. random +
  heuristic pilots (seeded, tunable `HeuristicWeights`). `sim` drives: `createDefaultAiRegistry()` →
  `getPilot(id)` → loop `generateLegalActions → chooseAction({view,legalActions,rng}) → applyAction`.
  FOUNDATION COMPLETE (engine+cards+ai+data-tools). Wave 3 = `feat/sim-harness` (§3.5) — the heart.
  (Integrator)
- 2026-06-20 DESKTOP-90PJPM4: `cards` (§3.2) INTEGRATED — 134 tests on main. All 32 staples load+play, ids
  joined to Scryfall by UUID. SURFACED ENGINE GAP: MVP core has no triggered-ability system, no
  until-EOT/continuous-effects layer, no planeswalker/transform/dynamic-P-T. Several meta cards stubbed;
  `pumpUntilEndOfTurn` doesn't wear off (sim-combat bias). New roadmap item §3.9 "Core engine v2" added —
  needed before meta-deck sims are trustworthy. (Integrator)
- 2026-06-20 DESKTOP-90PJPM4: `core` (§3.1) INTEGRATED to main — 62 core tests (incl. adversarial-review
  fixes: blocked double-strikers no longer leak face damage; effect registry threaded explicitly, no
  module global). Full main suite = 102 tests green. Wave 2 dispatched: `feat/cards-pool` (§3.2) +
  `feat/ai-pilots` (§3.4), both build on core's seams (CardDefinition/EffectRegistry; generateLegalActions/
  applyAction), disjoint packages, parallel. `ai` tests against its own minimal fixtures (does NOT depend on
  `cards`) to stay parallel. (Integrator)
- 2026-06-20 DESKTOP-90PJPM4: `data-tools` (§3.3) INTEGRATED — 47 tests green, 32/32 starter cards resolved
  live from Scryfall, text card-index.json committed (image bytes gitignored). Card data now available to
  `cards`/`web` at `packages/data-tools/data/card-index.json`. (Integrator)
- 2026-06-20 DESKTOP-90PJPM4: Wave 1 dispatched — `feat/core-engine` (§3.1) + `feat/data-tools-scryfall`
  (§3.3) in parallel; disjoint packages, no cross-dependency. core blocks cards/ai/sim, so it's the
  keystone. data-tools is independent. (Supervisor/integrator)
- 2026-06-20 DESKTOP-90PJPM4: Scaffold (§3.0) INTEGRATED to main — `npm install/test/build` all green,
  PWA build emits sw.js + manifest. Other packages branch off `origin/main`. (Integrator)
- 2026-06-20 DESKTOP-90PJPM4: Repo seeded with rules + this board + DESIGN. Stack = TS npm-workspaces
  monorepo (core/cards/ai/sim/data-tools + apps/web PWA), Scryfall art, curated card pool. Node 24 LTS
  installed on this machine. Scaffold (§3.0) goes first and blocks all other work. (Supervisor)
