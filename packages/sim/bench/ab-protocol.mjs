/**
 * THE TWO-SEED A/B PROTOCOL — one answer to "is this actually better?".
 *
 * ⚠️ WHY THIS EXISTS. A single-seed A/B at p < 0.05 reports a fluke as a finding,
 * and this repo nearly shipped one. Tuning `ownCreatureLossPerStat` from 1 to 1.5
 * measured **285 ahead / 215 behind, p = 2.03e-3 — "stronger"** on 11,520 games.
 * Re-run on a different seed set, the same change measured **250 / 247, p = 0.93**.
 * Nothing about the change was real; the first run was noise that cleared a
 * threshold. Three nearby values (1.25, 1.5, 2.0) all looked "stronger" on that
 * seed, which felt like corroboration and was not: they were the same games.
 *
 * The contrast that makes the rule obvious — the alpha strike (§3.74, shipped) on
 * an independent seed: **158 ahead / 0 behind**. A real improvement is ONE-SIDED.
 * A 285/215 split with a good p-value is what a coin looks like when you test it
 * enough ways.
 *
 * So every A/B here runs TWICE, on independent seeds, and a change is CONFIRMED
 * only when both runs agree. It costs one more run and it is the difference
 * between a measurement and a story.
 */

/** Run one arm-pair on two independent seeds and judge replication. */
export function confirmedAb(runOnce, { seed, confirmSeed }) {
  const primary = runOnce(seed);
  const confirm = runOnce(confirmSeed);
  return { primary, confirm, ...judge(primary, confirm) };
}

/** Which way one run points, at the conventional threshold. */
export function direction(result, alpha = 0.05) {
  const decided = result.slots.aheadA + result.slots.aheadB;
  if (decided === 0) return 'no-effect';
  if (result.pValue >= alpha) return 'inconclusive';
  return result.slots.aheadA > result.slots.aheadB ? 'A' : 'B';
}

function judge(primary, confirm) {
  const a = direction(primary);
  const b = direction(confirm);
  const decided = (d) => d === 'A' || d === 'B';
  // Every combination is named. An unnamed case here would print a confident
  // sentence about a run that did not happen — the first draft of this function
  // said "only the second seed set showed an effect" when NEITHER had.
  if (a === 'no-effect' && b === 'no-effect') {
    return { verdict: 'NO EFFECT', detail: 'the two arms never played a different game — the case did not arise.' };
  }
  if (decided(a) && a === b) {
    return {
      verdict: a === 'A' ? 'CONFIRMED STRONGER' : 'CONFIRMED WEAKER',
      detail: 'both seed sets agree.',
    };
  }
  if (decided(a) && decided(b)) {
    return { verdict: 'CONTRADICTORY', detail: `the seeds disagree (${a} then ${b}) — treat as noise.` };
  }
  if (decided(a) || decided(b)) {
    const which = decided(a) ? 'the first' : 'the second';
    return {
      verdict: 'NOT REPLICATED',
      detail: `only ${which} seed set showed an effect — this is what a fluke looks like, not a small true effect.`,
    };
  }
  return {
    verdict: 'INCONCLUSIVE',
    detail: 'neither seed set showed an effect; the arms did play different games, so this is "no evidence", not "no difference".',
  };
}

/** Print both runs and the replication verdict, in the house format. */
export function report(title, { primary, confirm, verdict, detail }, seeds) {
  const line = (label, r, seed) =>
    `  ${label} (seed ${seed}): ahead A ${r.slots.aheadA} · ahead B ${r.slots.aheadB} · ` +
    `level ${r.slots.level} · p ${r.pValue.toExponential(2)}`;
  console.log(title);
  console.log(line('run 1', primary, seeds.seed));
  console.log(line('run 2', confirm, seeds.confirmSeed));
  console.log(`  VERDICT: ${verdict} — ${detail}`);
  if (verdict !== 'CONFIRMED STRONGER') {
    console.log('  (Only CONFIRMED STRONGER is grounds to ship. See ab-protocol.mjs for why.)');
  }
}
