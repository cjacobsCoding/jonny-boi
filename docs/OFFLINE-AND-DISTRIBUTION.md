# Offline, distribution, and where bug reports actually go

> **Status: durable reference. NOT STARTED.** Raised by Caleb on **2026-09-14** as one request.
> This file is the single source of truth for the scope. **Do not re-scope from memory — re-read it.**
> Companion to [MTGA-UX-OVERHAUL.md](MTGA-UX-OVERHAUL.md), which covers the play surface; this one
> covers how the app is *delivered, updated, and reports back*.

## 0. The request, verbatim

Preserved word-for-word so that no later summary can quietly drop a clause.

> I want the Jonny Boi app to be able to run just fine offline with no internet access - on both PC
> and Mobile. And want mobile builds pushed to Claude Fleet whenever they come out. And each produced
> build should yield a new PC and android build. Also, I want an in-app 'update' type button thats
> super obvious and easy to click that shows up whenever there is an updated build, and when clicked,
> closes the app, shows a loading bar for the update, and when it finishes, it reopens the updated
> app, putting you right back to the view and state you were at when you hit update. Also, make it so
> you can report bugs on mobile somehow too. And make it so reported bugs go somewhere specific on the
> NAS instead of just downloading the bug report so its easy to find and address bugs reported from
> anywhere. And make it so the app works offline but bugs reported while offline are just stored
> locally, then uploaded to NAS and local copy deleted once successfully uploaded once internet comes
> back.

## 1. The work items

| ID | Item | One-line acceptance |
| --- | --- | --- |
| **DIST-1** | Runs fully offline on PC | Aeroplane mode, cold start: the app opens, a game is playable start to finish, nothing hangs waiting on a network call |
| **DIST-2** | Runs fully offline on mobile | Same, on the installed Android build |
| **DIST-3** | Every release produces BOTH a PC and an Android build | One build command/pipeline yields both artifacts; neither can ship without the other |
| **DIST-4** | Mobile builds are pushed to Claude Fleet on release | A new mobile build lands on Fleet automatically, not by hand |
| **DIST-5** | An obvious in-app Update button | Impossible to miss when a new build exists — not a subtle pill |
| **DIST-6** | Update is a full restart with state restoration | Click → app closes → progress bar → reopens on the **same view and same state** the user left |
| **DIST-7** | Bug reporting works on mobile | The reporter is reachable and usable on a phone, not PC-only |
| **DIST-8** | Reports go to a known place on the NAS | A specific NAS path, so reports from any device are findable — not a per-device download |
| **DIST-9** | Offline reports queue, then drain | Stored locally while offline; uploaded when connectivity returns; **local copy deleted only after a confirmed successful upload** |

## 2. What already exists — the foundation, and what it is NOT

Do not start from zero, and do not assume any of this already satisfies an item.

- **The app is already a PWA with a precaching service worker.** `apps/web/vite.config.ts` uses
  `VitePWA` with `registerType: 'prompt'` and precaches the offline shell. So DIST-1 has real
  groundwork — but "has a service worker" is not "verified offline". **The card art is fetched from
  Scryfall at runtime over the network** (this is documented in the harness notes: the landing view
  pulls hundreds of cross-origin images, and time-to-shell measured 7.8 s warm vs 38.9 s cold). An
  offline app that renders every card as a broken image has not met DIST-1. The card *index* is
  bundled; the *art* is not. **That gap is the substance of DIST-1/DIST-2, and it must be measured
  before it is designed** (rule 11): how many megabytes is the art for the real pool, and what is the
  honest policy — bundle a subset, cache-on-first-view, or ship a lower-resolution pack?
- **Update machinery exists**: `apps/web/src/lib/update/updater.ts` + `update-decision.ts`, surfaced
  by `UpdatePill.tsx`. It defers an update while a game is live and applies it on leaving — which is
  good behaviour and is *not* what DIST-5/DIST-6 ask for. What is missing is the loud affordance, the
  progress bar, and above all **state restoration across the restart**.
- **A bug reporter exists** and is well covered (`verify-bug-reporter.mjs`, contract 31/31). But
  `lib/bugreport/report.ts` builds a **downloaded bundle** — its own comment calls the download one
  of its side effects. DIST-8 replaces that destination; DIST-9 adds a queue in front of it.
- **Game state is already serializable and replayable.** `PlayRecord` + `rebuildFromRecord` reconstruct
  a game from (seed, decklists, actions), and `lib/play/history.ts` already persists it. **DIST-6
  should ride that, not invent a second snapshot format** (rule 12) — the hard part is the *view* and
  the non-game UI state, not the game.

## 3. Open questions that block implementation, not recording

These must be answered by Caleb before the affected items can be built. They are listed so the work
is not started on a guess.

1. **The NAS: address, protocol, credentials, and path.** SMB share? WebDAV? An HTTP endpoint? A
   phone on mobile data cannot reach a LAN SMB share at all, which decides the whole design of
   DIST-8. **Credentials must not be embedded in a client build** — if reports are to arrive from
   anywhere, something has to accept them, and that is a small service, not a share.
2. **"Pushed to Claude Fleet"** — what the concrete mechanism is for a mobile build.
3. **The Android build itself does not exist yet.** There is a PWA; DIST-2/3/4 need a decision on
   what an "Android build" is — an installed PWA/TWA, or a packaged native shell. This is the
   largest single unknown in the section and it gates DIST-3 and DIST-4 entirely.

## 4. The traps, stated in advance

- **DIST-9's deletion rule is the whole feature.** "Delete the local copy once successfully uploaded"
  means the delete is conditional on a **confirmed** upload — not on the request being sent, and not
  on the app believing it is online. A report deleted after a request that silently failed is a bug
  report the user wrote and lost. Ship the guard with the fix: a test that a failed or partial upload
  **keeps** the local copy, and that a re-drain does not duplicate it.
- **"Works offline" must be verified offline.** The whole §3.146 lesson applies: a test that mocks
  `fetch` proves nothing about a cold start in aeroplane mode. This needs a harness that actually
  denies the network (the browser harnesses already drive a real Chrome; blocking requests is
  available there) and then asserts a game is playable.
- **DIST-6 restores state across a process restart.** Anything held only in React state is gone by
  definition. What is restored has to be persisted *before* the update begins, and the restore path
  has to survive the new build having changed the shape of that data — so it needs a version and a
  documented fallback (open on the default view rather than crash).
