/**
 * WHO DIES IN A FIGHT — the rules' answer, not the printed boxes (DESIGN §3.43).
 *
 * `pickBlocker` decides every block by asking two questions — does my blocker
 * die, does theirs — and it used to answer them with two lines of arithmetic:
 *
 * ```ts
 * const blockerDies  = attackerPower >= blockerToughness;
 * const attackerDies = blockerPower  >= attackerToughness;
 * ```
 *
 * That is wrong about four things the rules care about, and each one is a card in
 * the shipped pool. **Deathtouch** (CR 702.2b) makes any single point lethal, so a
 * 1/2 Deadly Recluse eats a 5/3 Thragtusk — and the pilot, believing the Recluse
 * merely bounced off, would not block with it. **First strike** (CR 702.7b) means
 * a creature killed before it strikes deals nothing back, so an Attended Knight
 * blocking a 2/2 is not a trade at all. **Indestructible** (CR 702.12b) means
 * lethal damage does not kill. And damage **already marked** on a creature lowers
 * what it takes to finish it.
 *
 * Measured on the gauntlet at seed 99: the printed-box version made 946 attacks
 * per 100 games into an untapped Deadly Recluse it had priced as safe against
 * Mono-Green Ramp, 242 into Vampire Nighthawk against Orzhov Lifegain, and 146
 * first-strike misreads against Boros Aggro — and exactly ZERO against the five
 * gauntlet decks that print none of those keywords. The blind spot is real and it
 * lands precisely on the matchups it should.
 *
 * ⚠️ **This is used by the BLOCK decision only, and that is a measured choice,
 * not an oversight.** See the note on `attackIsProfitable` in `heuristic.ts`:
 * teaching the ATTACK decision the same truth is also correct, also easy, and
 * measured WORSE — it makes both pilots refuse every attack into a deathtoucher,
 * the board locks, and the gauntlet fills with timeout draws. Read that note
 * before "finishing the job".
 *
 * Everything is read through `board-stats.ts`, so an anthem, an Equipment, a
 * granted keyword and a `*` power box are all seen — see that file for why a bare
 * core accessor is a bug in this package.
 *
 * ⚠️ **Scope: combat damage between one attacker and one blocker.** It
 * deliberately does not model protection, prevention shields, or a gang block —
 * those have their own homes (`protection.ts`, `replacement.ts`, `tactical.ts`),
 * and a second opinion here would be one more thing to keep in step with the
 * rules engine.
 */

import type { CardInstance, KeywordFlags } from '@jonny-boi/core';
import type { ContinuousIndex } from './board-stats.js';
import { keywordsOf, power, toughnessLeft } from './board-stats.js';

/** What a one-attacker / one-blocker combat does to the two creatures in it. */
export interface FightOutcome {
  /** True when the attacker is dealt lethal damage it cannot shrug off. */
  readonly attackerDies: boolean;
  /** True when the blocker is dealt lethal damage it cannot shrug off. */
  readonly blockerDies: boolean;
  /**
   * Damage that reaches the defending player ANYWAY — trample overflow
   * (CR 702.19b), and zero for every attacker without trample.
   *
   * This is what makes "which body do I put in front of the 7/7 trampler" a real
   * question rather than a coin flip: a 1/1 chump lets six through, an 0/4 wall
   * lets three. Without it the pilot picks the cheapest chump, which against a
   * trampler is the worst body it owns.
   */
  readonly damageThrough: number;
}

/**
 * How much damage from `source` it takes to kill `victim` right now — CR 510.1a's
 * "lethal damage", which is also what a trampler must assign before anything
 * spills over. Deathtouch makes that one point (CR 702.2b), and damage already
 * marked on the victim counts toward it. Indestructible does NOT change it: the
 * rules still call that amount lethal, the creature simply survives it.
 */
function lethalDamageNeeded(
  source: KeywordFlags,
  victim: CardInstance,
  index: ContinuousIndex,
): number {
  if (source.deathtouch === true) return 1;
  return Math.max(1, toughnessLeft(victim, index));
}

/** Whether `damage` from `source` actually kills `victim`. */
function isKilledBy(
  damage: number,
  source: KeywordFlags,
  victim: CardInstance,
  victimKeywords: KeywordFlags,
  index: ContinuousIndex,
): boolean {
  if (damage <= 0) return false;
  if (victimKeywords.indestructible === true) return false;
  return damage >= lethalDamageNeeded(source, victim, index);
}

/** Does this creature deal its combat damage in the first-strike step? */
function strikesFirst(keywords: KeywordFlags): boolean {
  return keywords.firstStrike === true || keywords.doubleStrike === true;
}

/**
 * Resolve a one-attacker / one-blocker fight.
 *
 * The pilot assigns at most one blocker per attacker (see `pickBlocker`), so a
 * pair IS the whole combat as far as that decision is concerned; a gang block
 * needs the tactical solver, which is a different module with a different cost.
 */
export function resolveFight(
  attacker: CardInstance,
  blocker: CardInstance,
  index: ContinuousIndex,
): FightOutcome {
  const attackerKeywords = keywordsOf(attacker, index);
  const blockerKeywords = keywordsOf(blocker, index);
  const attackerPower = power(attacker, index);
  const blockerPower = power(blocker, index);

  const attackerKills = isKilledBy(attackerPower, attackerKeywords, blocker, blockerKeywords, index);
  const blockerKills = isKilledBy(blockerPower, blockerKeywords, attacker, attackerKeywords, index);

  // The first-strike step (CR 510.4): whichever side strikes first, if it kills
  // outright the other never deals its damage. Both striking first — or neither —
  // is simultaneous, which is the ordinary case and the one the two old lines
  // assumed for everything.
  const attackerFirst = strikesFirst(attackerKeywords);
  const blockerFirst = strikesFirst(blockerKeywords);
  const attackerSurvivesToStrike = !(blockerFirst && !attackerFirst && blockerKills);
  const blockerSurvivesToStrike = !(attackerFirst && !blockerFirst && attackerKills);

  // Trample overflow. The attacker assigns lethal damage to the blocker and the
  // rest to the player — so an 0/4 wall soaks four of a 7/7 and a 1/1 soaks one.
  // An attacker that dies before it strikes assigns nothing at all.
  let damageThrough = 0;
  if (attackerKeywords.trample === true && attackerSurvivesToStrike && attackerPower > 0) {
    damageThrough = Math.max(0, attackerPower - lethalDamageNeeded(attackerKeywords, blocker, index));
  }

  return {
    attackerDies: blockerSurvivesToStrike && blockerKills,
    blockerDies: attackerSurvivesToStrike && attackerKills,
    damageThrough,
  };
}
