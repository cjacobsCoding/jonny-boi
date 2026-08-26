# TMB-JB-0002 — At 390px the top nav is clipped after Play with no overflow cue, hiding four of eight destinations

**`major` · `fixed` · surface `deck_builder` · `ui-visual` · confidence `confirmed`**

| Field | Value |
|---|---|
| **Project** | `jonny-boi` |
| **Rubric** | `ui-visual` |
| **Persona** | `first-timer` |
| **Session** | `20260821_145226_jonny-boi_ui-visual` |
| **Created** | `2026-08-21T21:59:41Z` |
| **Updated** | `2026-08-26T14:55:14Z` |
| **Build** | `d56b27512665` (dirty) · `D:\Cool Stuff\Claude\jonny-boi\apps\web\dist\index.html` · sha `f821edd5950b` · built `2026-08-21T21:53:14.661613+00:00` |
| **Status note** | phone nav strip now marks a clipped edge: mask fade + chevron (.app__nav-wrap--more-* classes) driven by pure computeNavOverflow() in apps/web/src/lib/nav-overflow.ts; cues vanish when all tabs fit, so desktop renders unchanged. After-capture at 390x844 in evidence/TMB-JB-0002/after: chevron at the filed crop rect, fade over the cut tab mid-scroll, cues swap ends at full scroll; desktop 1280x800 identical. Tests: nav-overflow.test.ts + styles-regressions.test.ts (watched red pre-fix) |
| **Tags** | `responsive`, `navigation`, `mobile` |
| **Fingerprint** | `13cafbfc14ba140a` |

## What happened

On the phone capture (390x844) the top bar shows the wordmark and then Cards, Deck Builder, Play - and then it just stops. Lab, Watch a Game, Proxies and About are all present at 1280px and none of them are on screen at 390px. Cropped the right end of that bar at 6x: 'Play' ends around x=358 and the remaining 32px to the frame edge is flat background. There is no fade-out, no chevron, no ellipsis, no scrollbar track and no hamburger button anywhere in the bar. The same bar renders the same way on the about capture, so it is the shared component and not one page's layout.

## Why it matters

A first-time visitor on a phone concludes the app has three sections. The Lab is the entire point of this product - AI pilots, gauntlet runs, card-swap verdicts - and it is one of the four that fall off the edge. They never open it, and they judge the whole thing on a card browser and a deck list. The cost is not a cosmetic one: it is the feature the product is named for, invisible on the platform CLAUDE.md says it ships to.

## Repro

1. npm run build, then serve apps/web/dist
2. Open the deck builder at a 390x844 viewport
3. Look at the top nav: it ends after Play with no indication that Lab, Watch a Game, Proxies and About exist

## Expected

Either the whole nav is reachable at 390px - collapsed into a menu button - or the row shows that it continues: a gradient fade at the cut, a chevron, or a visible scroll track. Right now the row ends exactly where a complete row would end, so there is nothing to distinguish 'this is all of it' from 'there is more off-screen'.

## Evidence

**Durable copy** paths are relative to this file's own directory and are committed with it (`evidence/TMB-JB-0002/`). **Session path** paths are relative to `.testmebro/sessions/20260821_145226_jonny-boi_ui-visual/`, which is gitignored — that is where the evidence was captured, and it may already have been cleaned up.

| # | Kind | Durable copy | Session path | Region (1:1) | sha256 | What it shows |
|---|---|---|---|---|---|---|
| 1 | `crop` | `evidence/TMB-JB-0002/crops/mobile_x240y4w150h48_z6.png` | `crops/mobile_x240y4w150h48_z6.png` | `240,4,150,48` | `28d002bff16f` | The right end of the 390px nav bar at 6x. 'Play' is the last item and the strip to the frame edge is flat background - no fade, no chevron, no scroll track. |
| 2 | `screenshot` | `evidence/TMB-JB-0002/shots/deck_builder/mobile.png` | `shots/deck_builder/mobile.png` | `0,0,390,54` | `8818e8a2f21a` | Parent frame at 390x844. Compare the nav with shots/deck_builder/desktop.png, which shows all eight destinations. |
| 3 | `screenshot` | `evidence/TMB-JB-0002/shots/about/mobile.png` | `shots/about/mobile.png` | `0,0,390,54` | `4269855cfeec` | The same bar clipped identically on a different page, which is what makes this the shared component rather than one page's layout. |

## Suggested direction

Collapse the nav below a breakpoint into a menu button, or - if horizontal scrolling is the intent - make the scroll visible: a mask-image fade at the trailing edge plus a persistent scroll indicator, so the row reads as a window onto a longer list rather than as a complete one.

_A direction, not a patch. The project's Claude owns the how._

## References

- `CLAUDE.md`
- `DESIGN.md`

## Status history

| When | From | To | Actor | Note |
|---|---|---|---|---|
| `2026-08-21T21:59:41Z` | — | `open` | `20260821_145226_jonny-boi_ui-visual` | filed |
| `2026-08-26T04:14:11Z` | `open` | `in-progress` | — | cause hypothesis: at <=520px .app__nav is an overflow-x scroll strip with scrollbar-width:none and no fade/chevron - scrollable but indistinguishable from a complete row; fix = overflow cue on the shared header (fade + chevron), not a per-page change |
| `2026-08-26T14:55:14Z` | `in-progress` | `fixed` | — | phone nav strip now marks a clipped edge: mask fade + chevron (.app__nav-wrap--more-* classes) driven by pure computeNavOverflow() in apps/web/src/lib/nav-overflow.ts; cues vanish when all tabs fit, so desktop renders unchanged. After-capture at 390x844 in evidence/TMB-JB-0002/after: chevron at the filed crop rect, fade over the cut tab mid-scroll, cues swap ends at full scroll; desktop 1280x800 identical. Tests: nav-overflow.test.ts + styles-regressions.test.ts (watched red pre-fix) |

---

_Rendered from `TMB-JB-0002.json` by TestMeBro. The JSON is the source of truth: edit it and re-save, never edit this file._
