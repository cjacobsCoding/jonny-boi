/**
 * THE SEED-BATTERY A/B PROTOCOL — one answer to "is this actually better?".
 *
 * ⚠️ WHY THIS EXISTS, TWICE OVER. Both lessons were learned by nearly shipping
 * noise, and both are cheap to repeat if this file is ignored.
 *
 * 1. A SINGLE SEED REPORTS FLUKES. Tuning `ownCreatureLossPerStat` from 1 to 1.5
 *    measured **285 ahead / 215 behind, p = 2.03e-3 — "stronger"** over 11,520
 *    games. On a different seed set the identical change measured **250 / 247,
 *    p = 0.93**. Three nearby values all looked "stronger" on the first seed,
 *    which felt like corroboration and was not: they were the same games.
 *
 * 2. TWO SEEDS ARE NOT ENOUGH IF YOU TUNED ON THEM. A defensive-reserve rule
 *    (§3.85) was developed against seeds 4242/90210 — including choosing between
 *    a one-swing and a two-swing horizon by which scored better on them. It then
 *    "confirmed" on those same two seeds at 94/67 and 95/64, both p < 0.05. On
 *    two seeds it had never seen: **77/78 and 68/68 — dead level**. The variant
 *    had been selected by the very seeds that then validated it, which is
 *    overfitting with extra steps.
 *
 * So an A/B runs a BATTERY of independent seeds, and the ones that decide are the
 * HELD-OUT ones. The contrast that shows what a real effect looks like: the alpha
 * strike (§3.74) on a fresh seed is **158 ahead / 0 behind**. A real improvement
 * is one-sided and does not care which seed you hand it.
 */

/** The default battery: two seeds to develop against, two to be judged by. */
export const DEV_SEEDS = [4242, 90210];
export const HELD_OUT_SEEDS = [555001, 777003];

/** Run one arm-pair over a battery of seeds and judge replication. */
export function confirmedAb(runOnce, { seeds = DEV_SEEDS, heldOut = HELD_OUT_SEEDS } = {}) {
  const dev = seeds.map((seed) => ({ seed, result: runOnce(seed) }));
  const held = heldOut.map((seed) => ({ seed, result: runOnce(seed) }));
  return { dev, held, ...judge(dev, held) };
}

/** Which way one run points, at the conventional threshold. */
export function direction(result, alpha = 0.05) {
  const decided = result.slots.aheadA + result.slots.aheadB;
  if (decided === 0) return 'no-effect';
  if (result.pValue >= alpha) return 'inconclusive';
  return result.slots.aheadA > result.slots.aheadB ? 'A' : 'B';
}

/** Pooled McNemar over independent runs — the games do not overlap, so slots add. */
function pooled(runs) {
  let aheadA = 0;
  let aheadB = 0;
  for (const { result } of runs) {
    aheadA += result.slots.aheadA;
    aheadB += result.slots.aheadB;
  }
  const n = aheadA + aheadB;
  if (n === 0) return { aheadA, aheadB, chi: 0, significant: false };
  // Continuity-corrected McNemar; 3.84 is the chi-square 5% point at 1 d.f.
  const chi = (Math.abs(aheadA - aheadB) - 1) ** 2 / n;
  return { aheadA, aheadB, chi, significant: chi > 3.84 };
}

function judge(dev, held) {
  const all = [...dev, ...held];
  if (all.every(({ result }) => result.slots.aheadA + result.slots.aheadB === 0)) {
    return { verdict: 'NO EFFECT', detail: 'the two arms never played a different game — the case did not arise.' };
  }
  const heldPool = pooled(held);
  const allPool = pooled(all);
  const heldLeansA = heldPool.aheadA > heldPool.aheadB;
  const contradicted = all.some(({ result }) => {
    const d = direction(result);
    return d === (heldLeansA ? 'B' : 'A');
  });

  // ⚠️ THE HELD-OUT SEEDS DECIDE. The development seeds are where the idea was
  // shaped, so their agreement is not evidence — it is the thing being tested.
  if (!heldPool.significant) {
    return {
      verdict: 'NOT REPLICATED',
      detail:
        `held-out seeds are ${heldPool.aheadA}/${heldPool.aheadB} (pooled chi2 ${heldPool.chi.toFixed(2)}, ` +
        `needs > 3.84). Whatever the development seeds said, this did not survive seeds it had not seen.`,
    };
  }
  if (contradicted) {
    return { verdict: 'CONTRADICTORY', detail: 'seeds disagree about the direction — treat as noise.' };
  }
  return {
    verdict: heldLeansA ? 'CONFIRMED STRONGER' : 'CONFIRMED WEAKER',
    detail:
      `held-out seeds ${heldPool.aheadA}/${heldPool.aheadB} (chi2 ${heldPool.chi.toFixed(2)}); ` +
      `all seeds pooled ${allPool.aheadA}/${allPool.aheadB}.`,
  };
}

/** Print every run and the replication verdict, in the house format. */
export function report(title, { dev, held, verdict, detail }) {
  const line = (label, { seed, result }) =>
    `  ${label} (seed ${seed}): ahead A ${result.slots.aheadA} · ahead B ${result.slots.aheadB} · ` +
    `level ${result.slots.level} · p ${result.pValue.toExponential(2)}`;
  console.log(title);
  for (const run of dev) console.log(line('dev     ', run));
  for (const run of held) console.log(line('HELD-OUT', run));
  console.log(`  VERDICT: ${verdict} — ${detail}`);
  if (verdict !== 'CONFIRMED STRONGER') {
    console.log('  (Only CONFIRMED STRONGER is grounds to ship. See ab-protocol.mjs for why.)');
  }
}
