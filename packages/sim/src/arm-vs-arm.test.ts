/**
 * COMPARING TWO CANDIDATES AGAINST EACH OTHER, FOR FREE (DESIGN §3.97).
 *
 * Every arm of a run plays the SAME slots from the SAME seeds, so "did A win slot
 * i?" and "did B win slot i?" are two answers about one game. Cross-tabulating
 * them is a proper paired comparison of A against B with no extra games — which is
 * the comparison §3.96 needed and did not have.
 *
 * These tests pin the three things that make it trustworthy: the per-slot record
 * agrees with the 2×2 the runner already reports, the comparison is over the
 * common prefix only, and a POOLED arm compares identically to a locally-played
 * one (otherwise the CLI's parallel `suggest` would rank differently from its
 * sequential one).
 */

import { describe, expect, it } from 'vitest';
import { buildRegistry, loadCardPool } from '@jonny-boi/cards';
import { createDefaultAiRegistry, HEURISTIC_PILOT_ID } from '@jonny-boi/ai';
import type { Pilot } from '@jonny-boi/ai';
import { SAMPLE_DECKS } from '../data/decks/index.js';
import { loadDeck } from './deck.js';
import type { MatchupPilots } from './matchup.js';
import { createPairedArmRunner, pairedBetweenArms } from './paired-arms.js';
import { mcNemarTest } from './stats.js';

const pool = loadCardPool({ onWarn: () => {} });
const registry = buildRegistry();
const ai = createDefaultAiRegistry();
const pilots = (): MatchupPilots => ({
  pilotA: ai.getPilot(HEURISTIC_PILOT_ID) as Pilot,
  pilotB: ai.getPilot(HEURISTIC_PILOT_ID) as Pilot,
});

const base = SAMPLE_DECKS[0]!;
const gauntlet = [SAMPLE_DECKS[1]!, SAMPLE_DECKS[2]!].map((d) => loadDeck(d, pool));
const SEED = 0xc0ffee;

function runner() {
  return createPairedArmRunner(base, { gauntletDecks: gauntlet, pilots: pilots(), pool, registry, seed: SEED });
}

/** Two legal swaps from the base deck, so both arms really play. */
const OUT = base.cards[0]!.cardId;
const INS = [
  ...new Set(SAMPLE_DECKS.slice(1).flatMap((d) => d.cards.map((c) => c.cardId))),
].filter((id) => !base.cards.some((c) => c.cardId === id));

describe('an arm remembers which slots it won', () => {
  it('the per-slot record reproduces the 2×2 the runner reports', () => {
    const r = runner();
    const handle = r.openArm({ out: OUT, in: INS[0]! }, OUT, INS[0]!);
    const arm = r.advance(handle, 12);

    // Cross-tabulating the arm against ITSELF must put every slot on the diagonal:
    // an arm never disagrees with itself, so the discordant cells are empty.
    const selfTable = pairedBetweenArms(arm, arm);
    expect(selfTable.baseOnly).toBe(0);
    expect(selfTable.variantOnly).toBe(0);
    // And the wins it records must match the wins its own paired table counts.
    const variantWins = arm.variantWonBySlot.filter(Boolean).length;
    expect(variantWins).toBe(arm.paired.bothWon + arm.paired.variantOnly);
    expect(selfTable.bothWon).toBe(variantWins);
    expect(arm.variantWonBySlot).toHaveLength(12);
  });

  it('compares two arms over the COMMON prefix, never inventing games', () => {
    const r = runner();
    const shallow = r.advance(r.openArm({ out: OUT, in: INS[0]! }, OUT, INS[0]!), 6);
    const deep = r.advance(r.openArm({ out: OUT, in: INS[1]! }, OUT, INS[1]!), 14);

    const table = pairedBetweenArms(shallow, deep);
    const total = table.bothWon + table.baseOnly + table.variantOnly + table.neither;
    // ⚠️ Six, not fourteen: slots past the shallower arm's depth have no outcome
    // for it, and counting them as losses would invent games nobody played.
    expect(total).toBe(6);
  });

  it('is symmetric — swapping the arguments swaps the advantage', () => {
    const r = runner();
    const a = r.advance(r.openArm({ out: OUT, in: INS[0]! }, OUT, INS[0]!), 10);
    const b = r.advance(r.openArm({ out: OUT, in: INS[1]! }, OUT, INS[1]!), 10);

    const ab = pairedBetweenArms(a, b);
    const ba = pairedBetweenArms(b, a);
    expect(ba.baseOnly).toBe(ab.variantOnly);
    expect(ba.variantOnly).toBe(ab.baseOnly);
    expect(ba.bothWon).toBe(ab.bothWon);
    // McNemar reads the discordant pairs, so the two orders must agree on p.
    expect(mcNemarTest(ba).pValue).toBeCloseTo(mcNemarTest(ab).pValue, 12);
  });

  it('⚠️ a SLICED arm compares identically to a locally-played one', () => {
    // The parallel `suggest` builds an arm from slices. If the spliced per-slot
    // record differed from the local one by even a slot, the pooled run would
    // RANK candidates differently from the sequential run — a divergence no
    // existing byte-identity test would catch, because the 2×2 totals still match.
    const local = runner();
    const whole = local.advance(local.openArm({ out: OUT, in: INS[0]! }, OUT, INS[0]!), 12);

    const sliced = runner();
    const first = sliced.playSlice({ out: OUT, in: INS[0]! }, OUT, INS[0]!, 0, 5);
    const second = sliced.playSlice({ out: OUT, in: INS[0]! }, OUT, INS[0]!, 5, 12);
    const spliced: boolean[] = [];
    first.variantWonBySlot.forEach((won, i) => (spliced[0 + i] = won));
    second.variantWonBySlot.forEach((won, i) => (spliced[5 + i] = won));

    expect(spliced).toEqual([...whole.variantWonBySlot]);
    // And therefore any comparison built on it is identical too.
    const rebuilt = { variantWonBySlot: spliced, gamesPlayed: 12 };
    expect(pairedBetweenArms(whole, rebuilt)).toEqual(pairedBetweenArms(whole, whole));
  });
});
