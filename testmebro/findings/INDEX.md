# Findings — jonny-boi

_Derived from the `TMB-*.json` files in this directory. Do not edit: regenerate with `tmb findings report`. The JSON files are the source of truth._

**4 finding(s) — 0 open, 4 closed, 0 open blocker(s), 0 verified.**

## By severity

| Severity | Open | Total |
|---|---|---|
| `blocker` | 0 | 0 |
| `major` | 0 | 1 |
| `minor` | 0 | 3 |
| `polish` | 0 | 0 |

## By status

| Status | Count |
|---|---|
| `open` | 0 |
| `acknowledged` | 0 |
| `in-progress` | 0 |
| `regressed` | 0 |
| `fixed` | 4 |
| `verified` | 0 |
| `wontfix` | 0 |
| `duplicate` | 0 |
| `not-reproducible` | 0 |

## By category

| Category | Open | Total |
|---|---|---|
| `ui-visual` | 0 | 3 |
| `accessibility` | 0 | 1 |

_Only categories with at least one finding are listed; there are fourteen in the schema._

## Open findings (0)

_Nothing open._

## Closed findings (4)

<details><summary>4 closed — expand</summary>

| ID | Severity | Status | Surface | Title | Note |
|---|---|---|---|---|---|
| [TMB-JB-0002](TMB-JB-0002.md) | `major` | `fixed` | `deck_builder` | At 390px the top nav is clipped after Play with no overflow cue, hiding four of eight destinations | phone nav strip now marks a clipped edge: mask fade + chevron (.app__nav-wrap--more-* classes) driven by pure computeNavOverflow() in apps/web/src/lib/nav-overflow.ts; cues vanish when all tabs fit, so desktop renders unchanged. After-capture at 390x844 in evidence/TMB-JB-0002/after: chevron at the filed crop rect, fade over the cut tab mid-scroll, cues swap ends at full scroll; desktop 1280x800 identical. Tests: nav-overflow.test.ts + styles-regressions.test.ts (watched red pre-fix) |
| [TMB-JB-0001](TMB-JB-0001.md) | `minor` | `fixed` | `about` | About stat row: the six numbers sit on two baselines because the value follows a variable-height label | about__stat is now a flex column and the dd bottom-pins with margin: auto 0 0 - all six values share one baseline at the filed rect 144,250,995,112 (evidence/TMB-JB-0001/after). CSS-only; structure pinned in styles-regressions.test.ts |
| [TMB-JB-0003](TMB-JB-0003.md) | `minor` | `fixed` | `deck_builder` | Card-pool count 560 cards measures 3.88:1 at about 9px, under the 4.5:1 body-text floor | .result-count moved from --color-fg-faint to --color-fg-muted (token swap, as the takeover note diagnosed). Re-measured on a fresh capture at the filed rect 800,136,56,14: glyph core #9aa6b2 on plate #121921 = 7.14:1, was 3.88:1 against the 4.5:1 body floor (evidence/TMB-JB-0003/after). Ratio + rule pinned in styles-regressions.test.ts |
| [TMB-JB-0004](TMB-JB-0004.md) | `minor` | `fixed` | `about` | The floating button on every screen is 1.09:1 against the page and its icon 2.27:1 against its own fill | removed the opacity:0.45 dimming (it composited surface-raised to the filed #161d25); the launcher keeps quiet via tokens at full opacity - ring var(--color-fg-faint), dots var(--color-fg-muted). Re-measured at the filed rect 1226,748,40,36: dots vs fill 6.07:1 (was 2.27:1), rendered ring vs page 4.00:1 and vs fill 3.25:1 - all clear the 3:1 non-text floor of WCAG 1.4.11 (evidence/TMB-JB-0004/after, incl. the Lab surface). Pinned in styles-regressions.test.ts |

</details>
