/**
 * `@jonny-boi/cards` — the curated card pool as DATA + the effect-primitive
 * library that the pool's cards reference (DESIGN §3.2).
 *
 * A card is a `CardDefinition` data record (in `../data/pool`); an effect is a
 * small pure `EffectPrimitive` registered by id (`./primitives`). There is no
 * class-per-card. Other packages consume this through:
 *
 *   - `loadCardPool()` → a validated, indexed pool (lookup by Scryfall id/name).
 *   - `buildRegistry()` → an `EffectRegistry` with every primitive registered,
 *     ready for `createEngine(config, registry)` / `createGame({ …, registry })`.
 *   - `getCardWithRegistry(id)` → a `{ card, registry }` bundle ready to play.
 *
 * JOIN KEY to `data-tools`: a card's `id` is its Scryfall id (UUID) in
 * `packages/data-tools/data/card-index.json`; `name` is the secondary key.
 */

/** Stable package identity placeholder retained for the cross-workspace smoke test. */
export const PACKAGE_NAME = 'cards';

// Effect-primitive library (the §2 effect seam).
export {
  registerCoreEffects,
  CORE_PRIMITIVES,
  CORE_PRIMITIVE_IDS,
  dealDamage,
  drawCards,
  gainLife,
  loseLife,
  pumpUntilEndOfTurn,
  destroyTarget,
  exileTarget,
  destroyAll,
  addMana,
  counterSpell,
  discardCard,
  createToken,
  tapTarget,
  returnFromGraveyard,
} from './primitives.js';

// Pool loader + registry builder.
export type { CardPool, UnsupportedRef } from './pool.js';
export {
  loadCardPool,
  getCardDefinition,
  buildRegistry,
  getCardWithRegistry,
} from './pool.js';

// The raw data (read-only) for tooling/UI that wants the whole list.
export { CARD_POOL } from '../data/pool.js';

/**
 * Mechanics intentionally stubbed because the MVP engine (§3.1) lacks the system
 * to model them faithfully. Each listed card still LOADS and PLAYS (correct cost,
 * zone, P/T, keywords, mana production); only the listed sub-mechanic is omitted.
 * This is the honest record referenced by `../data/pool`'s header. When the
 * relevant engine system lands, wire these to the existing primitives (the
 * `createToken` / `tapTarget` primitives already exist for the trigger cases).
 */
export const STUBBED_MECHANICS: ReadonlyArray<{
  readonly card: string;
  readonly missingEngineSystem: string;
}> = Object.freeze([
  { card: 'Delver of Secrets', missingEngineSystem: 'transform (upkeep look + flip to 3/2 flyer)' },
  { card: 'Goblin Guide', missingEngineSystem: 'attack trigger (defender reveals top card)' },
  { card: 'Monastery Swiftspear', missingEngineSystem: 'prowess (cast-noncreature-spell trigger)' },
  { card: 'Young Pyromancer', missingEngineSystem: 'cast trigger (make a 1/1 token per instant/sorcery)' },
  { card: 'Snapcaster Mage', missingEngineSystem: 'flash timing + graveyard flashback recast' },
  { card: 'Sakura-Tribe Elder', missingEngineSystem: 'activated sacrifice ability + basic-land search' },
  { card: 'Kitchen Finks', missingEngineSystem: 'persist (death trigger returning it with a -1/-1 counter)' },
  { card: 'Tarmogoyf', missingEngineSystem: 'dynamic */*+1 P/T from graveyard card types' },
  { card: 'Liliana of the Veil', missingEngineSystem: 'planeswalker loyalty abilities' },
  { card: 'Fatal Push', missingEngineSystem: 'revolt (≤4 mode when a permanent left your battlefield)' },
  { card: 'Path to Exile', missingEngineSystem: 'controller may search for a basic land' },
  { card: 'Brainstorm', missingEngineSystem: 'put two cards back on top (hand ordering choice)' },
  { card: 'Ponder', missingEngineSystem: 'top-3 reorder / optional shuffle (selection)' },
  { card: 'Cryptic Command', missingEngineSystem: 'modal "choose two" (we author counter + draw)' },
  { card: 'Thoughtseize', missingEngineSystem: 'reveal hand + opponent-chosen nonland discard' },
  { card: 'Eternal Witness', missingEngineSystem: 'choose which graveyard card to return' },
]);
