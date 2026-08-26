# TMB-JB-0001 — About stat row: the six numbers sit on two baselines because the value follows a variable-height label

**`minor` · `fixed` · surface `about` · `ui-visual` · confidence `confirmed`**

| Field | Value |
|---|---|
| **Project** | `jonny-boi` |
| **Rubric** | `ui-visual` |
| **Persona** | `first-timer` |
| **Session** | `20260821_104815_jonny-boi` |
| **Created** | `2026-08-21T17:53:08Z` |
| **Updated** | `2026-08-26T14:55:15Z` |
| **Build** | `d56b27512665` (dirty) · `D:\Cool Stuff\Claude\jonny-boi\apps\web\dist\index.html` · sha `586b11c5546e` · built `2026-08-21T17:49:02.350256+00:00` |
| **Status note** | about__stat is now a flex column and the dd bottom-pins with margin: auto 0 0 - all six values share one baseline at the filed rect 144,250,995,112 (evidence/TMB-JB-0001/after). CSS-only; structure pinned in styles-regressions.test.ts |
| **Tags** | `about`, `stat-tiles`, `alignment` |
| **Fingerprint** | `43d9666d5e035dee` |

## What happened

The row of six stat tiles under the About intro shows its values at two different heights. CARDS PLAYABLE AS PRINTED (560), IMPORT TEMPLATES RECOGNIZED (188), KEYWORDS ENFORCED (15) and ENGINE SYSTEMS STILL MISSING (24) all have labels that wrap to two lines, and their numbers sit low in the tile. EFFECT PRIMITIVES (70) and TEMPLATE GAPS (34) have one-line labels, and their numbers sit roughly 18 px higher. Scanning the row left to right, the numbers step down, down, down, up, down, up.

## Why it matters

This row is the About page's headline evidence: it is the first thing that quantifies what the engine can and cannot do. A ragged baseline makes six numbers that are meant to be compared read as six unrelated boxes, and it is the one place on the four screens captured where the layout looks unconsidered rather than authored - which undercuts the page's own argument about rigour.

## Repro

1. Run npm run build and serve apps/web.
2. Open the app at desktop width (1280x800) and click About in the top nav.
3. Look at the row of six stat tiles directly beneath the intro paragraph.
4. Observe that the numbers 70 and 34 sit visibly higher than 560, 188, 15 and 24.

## Expected

Six equal-height tiles presenting one comparable statistic each should present their values on one shared baseline, so the eye can scan the row as a row. The tiles are already the same height, so the misalignment is not a sizing problem - only the value's vertical position inside the tile is wrong.

## Evidence

**Durable copy** paths are relative to this file's own directory and are committed with it (`evidence/TMB-JB-0001/`). **Session path** paths are relative to `.testmebro/sessions/20260821_104815_jonny-boi/`, which is gitignored — that is where the evidence was captured, and it may already have been cleaned up.

| # | Kind | Durable copy | Session path | Region (1:1) | sha256 | What it shows |
|---|---|---|---|---|---|---|
| 1 | `crop` | `evidence/TMB-JB-0001/crops/desktop_x144y250w995h112_z3.png` | `crops/desktop_x144y250w995h112_z3.png` | `144,250,995,112` | `d39089d9fa84` | The stat row at 3x. Lay a straightedge under 560 and carry it right: it passes through the middle of 70 and 34 rather than under them. |
| 2 | `screenshot` | `evidence/TMB-JB-0001/shots/about/desktop.png` | `shots/about/desktop.png` | `144,250,995,112` | `29d68ef8ea54` | The full 1280x800 About frame the crop was taken from, for context on where the row sits in the page. |

## Suggested direction

Give the tile a column layout that pushes the value to the bottom (e.g. flex-direction: column with margin-top:auto on the value, or a fixed min-height on the label block sized to two lines). Either pins every value to one baseline without changing the tile height.

_A direction, not a patch. The project's Claude owns the how._

## References

- `CLAUDE.md`

## Status history

| When | From | To | Actor | Note |
|---|---|---|---|---|
| `2026-08-21T17:53:08Z` | — | `open` | `20260821_104815_jonny-boi` | filed |
| `2026-08-26T04:14:13Z` | `open` | `in-progress` | — | cause hypothesis: .about__stat dd flows directly below a variable-height dt, so one-line labels float their values high; fix = flex-column tile with the value pinned to the tile bottom |
| `2026-08-26T14:55:15Z` | `in-progress` | `fixed` | — | about__stat is now a flex column and the dd bottom-pins with margin: auto 0 0 - all six values share one baseline at the filed rect 144,250,995,112 (evidence/TMB-JB-0001/after). CSS-only; structure pinned in styles-regressions.test.ts |

---

_Rendered from `TMB-JB-0001.json` by TestMeBro. The JSON is the source of truth: edit it and re-save, never edit this file._
