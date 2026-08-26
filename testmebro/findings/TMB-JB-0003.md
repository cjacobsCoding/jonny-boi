# TMB-JB-0003 — Card-pool count 560 cards measures 3.88:1 at about 9px, under the 4.5:1 body-text floor

**`minor` · `fixed` · surface `deck_builder` · `accessibility` · confidence `confirmed`**

| Field | Value |
|---|---|
| **Project** | `jonny-boi` |
| **Rubric** | `ui-visual` |
| **Persona** | `first-timer` |
| **Session** | `20260821_145226_jonny-boi_ui-visual` |
| **Created** | `2026-08-21T21:59:41Z` |
| **Updated** | `2026-08-26T14:55:26Z` |
| **Build** | `d56b27512665` (dirty) · `D:\Cool Stuff\Claude\jonny-boi\apps\web\dist\index.html` · sha `f821edd5950b` · built `2026-08-21T21:53:14.661613+00:00` |
| **Status note** | .result-count moved from --color-fg-faint to --color-fg-muted (token swap, as the takeover note diagnosed). Re-measured on a fresh capture at the filed rect 800,136,56,14: glyph core #9aa6b2 on plate #121921 = 7.14:1, was 3.88:1 against the 4.5:1 body floor (evidence/TMB-JB-0003/after). Ratio + rule pinned in styles-regressions.test.ts |
| **Tags** | `contrast`, `wcag`, `toolbar` |
| **Fingerprint** | `96661b145904bfe5` |

## What happened

The pool count at the right end of the toolbar is the dimmest text on the page. Sampled at 1:1 over rect 800,136,56,14: the glyph core is #6b7785 and the plate immediately behind it is #121921, which tmb contrast puts at 3.88:1. Cropped at 6x, the digits measure about 9px cap height, so this is body text and the applicable floor is 4.5:1, not the 3:1 large-text line. For comparison, the gauntlet warning eleven rows below it is #d6b94e on #171d26 = 8.80:1 on the same ground, so the interface is capable of much better here and this one label was set darker than the rest.

## Why it matters

This is the only number on the toolbar and it is the feedback for every filter the player touches: type a name, click a colour, and this is what tells you whether the pool went from 560 to 12 or to 0. At 3.88:1 it reads as disabled chrome, so a first-timer filtering to nothing sees an empty grid and no explanation, because the one label that would have explained it is the one they cannot read.

## Repro

1. npm run build, then serve apps/web/dist
2. Open the deck builder at 1280x800
3. Sample the pool count at rect 800,136,56,14 - glyph core #6b7785, plate #121921, 3.88:1 against a 4.5:1 floor at ~9px

## Expected

A live count that changes as filters are applied should clear the 4.5:1 body floor against its own background. The same grey family one or two steps lighter - the #a0aec0-ish tone the tile labels on About already use - would do it without changing the design.

## Evidence

**Durable copy** paths are relative to this file's own directory and are committed with it (`evidence/TMB-JB-0003/`). **Session path** paths are relative to `.testmebro/sessions/20260821_145226_jonny-boi_ui-visual/`, which is gitignored — that is where the evidence was captured, and it may already have been cleaned up.

| # | Kind | Durable copy | Session path | Region (1:1) | sha256 | What it shows |
|---|---|---|---|---|---|---|
| 1 | `crop` | `evidence/TMB-JB-0003/crops/desktop_x664y120w190h30_z6.png` | `crops/desktop_x664y120w190h30_z6.png` | `664,120,190,30` | `de5d4599cb64` | The count at 6x nearest-neighbour. Read the digit height off this crop before picking a floor: about 9px at 1:1, which is body text. |
| 2 | `crop` | `evidence/TMB-JB-0003/crops/desktop_x890y428w350h22_z4.png` | `crops/desktop_x890y428w350h22_z4.png` | `890,428,350,22` | `ada76fd5fa95` | The comparison case on the same ground: the gauntlet warning at #d6b94e on #171d26 = 8.80:1. Same page, same background family, more than twice the ratio. |
| 3 | `screenshot` | `evidence/TMB-JB-0003/shots/deck_builder/desktop.png` | `shots/deck_builder/desktop.png` | `800,136,56,14` | `f44627fc17a8` | Parent frame. The count sits at the right end of the toolbar row, beside the type filter pills. |

## Suggested direction

Lift the muted-text token used for this count by a step or two, or give the count the same treatment as the other live values on the page. It is a token change, not a layout one.

_A direction, not a patch. The project's Claude owns the how._

## References

- `CLAUDE.md`

## Status history

| When | From | To | Actor | Note |
|---|---|---|---|---|
| `2026-08-21T21:59:41Z` | — | `open` | `20260821_145226_jonny-boi_ui-visual` | filed |
| `2026-08-21T22:00:25Z` | `open` | `in-progress` | — | cause: the muted-text token on the pool count is set two steps darker than the rest |
| `2026-08-26T04:16:02Z` | `in-progress` | `in-progress` | `fix/tmb-ui-findings worker` | takeover of the stale 2026-08-21 claim (empty actor, no fix landed since) - appended by hand because tmb refuses same-state moves. Verified the recorded cause before trusting it: .result-count is set to --color-fg-faint #6b7785 (two steps below --color-fg), which matches the sampled glyph core exactly. The old note was right in substance, wrong in name: it is the FAINT token, not a darkened muted token. Fix = move the count to --color-fg-muted. |
| `2026-08-26T14:55:26Z` | `in-progress` | `fixed` | — | .result-count moved from --color-fg-faint to --color-fg-muted (token swap, as the takeover note diagnosed). Re-measured on a fresh capture at the filed rect 800,136,56,14: glyph core #9aa6b2 on plate #121921 = 7.14:1, was 3.88:1 against the 4.5:1 body floor (evidence/TMB-JB-0003/after). Ratio + rule pinned in styles-regressions.test.ts |

---

_Rendered from `TMB-JB-0003.json` by TestMeBro. The JSON is the source of truth: edit it and re-save, never edit this file._
