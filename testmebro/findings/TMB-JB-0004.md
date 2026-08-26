# TMB-JB-0004 — The floating button on every screen is 1.09:1 against the page and its icon 2.27:1 against its own fill

**`minor` · `fixed` · surface `about` · `ui-visual` · confidence `confirmed`**

| Field | Value |
|---|---|
| **Project** | `jonny-boi` |
| **Rubric** | `ui-visual` |
| **Persona** | `accessibility-advocate` |
| **Session** | `20260821_211308_jonny-boi` |
| **Created** | `2026-08-22T04:22:25Z` |
| **Updated** | `2026-08-26T14:55:27Z` |
| **Build** | `d56b27512665` (dirty) · `D:\Cool Stuff\Claude\jonny-boi\apps\web\dist\index.html` · sha `2538f9f30431` · built `2026-08-22T04:14:07.720149+00:00` |
| **Status note** | removed the opacity:0.45 dimming (it composited surface-raised to the filed #161d25); the launcher keeps quiet via tokens at full opacity - ring var(--color-fg-faint), dots var(--color-fg-muted). Re-measured at the filed rect 1226,748,40,36: dots vs fill 6.07:1 (was 2.27:1), rendered ring vs page 4.00:1 and vs fill 3.25:1 - all clear the 3:1 non-text floor of WCAG 1.4.11 (evidence/TMB-JB-0004/after, incl. the Lab surface). Pinned in styles-regressions.test.ts |
| **Tags** | `contrast`, `affordance`, `cross-surface` |
| **Fingerprint** | `b2d383496cdab050` |

## What happened

A circular control sits in the bottom-right corner of all four captured surfaces. Sampled at 1:1: its fill is #161d25 and the page immediately around it is #0f1419, which tmb contrast puts at 1.09:1 - the button's edge is essentially not there. Its only content is three dots at #4d565e, which is 2.27:1 against that fill, under the 3:1 floor WCAG 1.4.11 sets for non-text UI components. It carries no visible label. At 8x it resolves into a three-dot triangle; at 1:1, scanning the page normally, I did not notice it on the first two screenshots I opened and found it only because I was sweeping the corners.

## Why it matters

This is the only control in the interface that a user has to already know about in order to use. Its position - fixed bottom-right on every screen - is the position apps reserve for help, feedback or a bug report, which is precisely the thing a confused or blocked user goes looking for, and it is the thing they will not find. It is also the one place where this otherwise disciplined interface breaks its own rule that actionable things look actionable.

## Repro

1. npm run build && serve apps/web, or run the capture: py -m testmebro capture jonny-boi --surface about
2. Open the About page at 1280x800.
3. Look at the bottom-right corner of the viewport at 1:1 without zooming.
4. Observe: the circular control at roughly (1246,766) is not distinguishable from the page ground. py -m testmebro sample shots/about/desktop.png --rect 1226,748,40,36 gives #161d25 for the button and #0f1419 for the ground; py -m testmebro contrast '#161d25' '#0f1419' gives 1.09:1, and '#4d565e' vs '#161d25' gives 2.27:1 for the dots.

## Expected

A persistent control that ships on every screen should be findable without knowing it is there. Either the circle gets a visible edge against the page - a border or a fill that clears 3:1 - or the icon clears 3:1 against the fill, and ideally both. Everything else on these pages that can be clicked already carries a border or a fill that does exactly this, so the pattern to copy is already in the app.

## Evidence

**Durable copy** paths are relative to this file's own directory and are committed with it (`evidence/TMB-JB-0004/`). **Session path** paths are relative to `.testmebro/sessions/20260821_211308_jonny-boi/`, which is gitignored — that is where the evidence was captured, and it may already have been cleaned up.

| # | Kind | Durable copy | Session path | Region (1:1) | sha256 | What it shows |
|---|---|---|---|---|---|---|
| 1 | `crop` | `evidence/TMB-JB-0004/crops/desktop_x1216y738w60h56_z8.png` | `crops/desktop_x1216y738w60h56_z8.png` | `1216,738,60,56` | `86c942f03e48` | The button at 1:1, magnified 8x, from the About page. This is what the three dots and the circle edge actually are; note that even at 8x the circle's edge is only just visible against the page. |
| 2 | `crop` | `evidence/TMB-JB-0004/crops/desktop_x1200y724w80h76_z6.png` | `crops/desktop_x1200y724w80h76_z6.png` | `1200,724,80,76` | `3bf266c0c81c` | The same control on the Lab page at 6x, cut from a different parent frame - it is the same control in the same place with the same values, so this is not a one-page artifact. |
| 3 | `screenshot` | `evidence/TMB-JB-0004/shots/about/desktop.png` | `shots/about/desktop.png` | `0,0,1280,800` | `29d68ef8ea54` | The parent frame at 1280x800. Scan the bottom-right corner at 1:1: this is the view a user actually gets, and it is why the finding is about findability rather than about the icon drawing. |
| 4 | `screenshot` | `evidence/TMB-JB-0004/shots/deck_builder/desktop.png` | `shots/deck_builder/desktop.png` | — | `21284362da1d` | Same control, same corner, third surface. |
| 5 | `screenshot` | `evidence/TMB-JB-0004/shots/lab/desktop.png` | `shots/lab/desktop.png` | — | `7d1d0a3aa73e` | Same control, same corner, fourth surface. It ships on every screen this session captured. |

## Suggested direction

Reuse the outlined-button treatment the deck panel already uses - a 1px border in the same grey family as the panel strokes, and lift the dot fill to the #9aa6b2 tone the body copy uses. Both values already exist in the palette, so this is a token swap rather than a new style. A visible label or an aria-label would also close the 'what is it for' half of the problem, which this finding deliberately does not claim to have measured.

_A direction, not a patch. The project's Claude owns the how._

## References

- `WCAG 2.1 SC 1.4.11 Non-text Contrast (3:1 for UI components)`
- `TMB-JB-0003 - the other contrast finding open on this project, a different element and a different token`

## Status history

| When | From | To | Actor | Note |
|---|---|---|---|---|
| `2026-08-22T04:22:25Z` | — | `open` | `20260821_211308_jonny-boi` | filed |
| `2026-08-26T04:14:24Z` | `open` | `in-progress` | — | cause hypothesis: .bugreport-launcher dims itself with opacity:0.45 - compositing surface-raised #1f2733 over page #0f1419 yields exactly the sampled #161d25, killing both its border and its dot contrast; fix = drop the opacity dimming, keep it quiet with tokens that clear 3:1 |
| `2026-08-26T14:55:27Z` | `in-progress` | `fixed` | — | removed the opacity:0.45 dimming (it composited surface-raised to the filed #161d25); the launcher keeps quiet via tokens at full opacity - ring var(--color-fg-faint), dots var(--color-fg-muted). Re-measured at the filed rect 1226,748,40,36: dots vs fill 6.07:1 (was 2.27:1), rendered ring vs page 4.00:1 and vs fill 3.25:1 - all clear the 3:1 non-text floor of WCAG 1.4.11 (evidence/TMB-JB-0004/after, incl. the Lab surface). Pinned in styles-regressions.test.ts |

---

_Rendered from `TMB-JB-0004.json` by TestMeBro. The JSON is the source of truth: edit it and re-save, never edit this file._
