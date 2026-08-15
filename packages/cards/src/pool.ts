/**
 * Pool loader + registry builder — the public runtime surface of
 * `@jonny-boi/cards`. Cards are DATA (`../data/pool`); this module indexes them
 * for lookup and validates that every effect ref resolves to a registered
 * primitive (robustness: a bad ref is *warned*, never a crash — DESIGN §1 robust).
 */

import type { CardDefinition, EffectRegistry } from '@jonny-boi/core';
import { attachmentProblem, createEffectRegistry } from '@jonny-boi/core';
import { CARD_POOL } from '../data/pool.js';
import { CORE_PRIMITIVE_IDS, registerCoreEffects } from './primitives.js';

/** A loaded, validated pool: the definitions plus by-id / by-name indexes. */
export interface CardPool {
  readonly cards: readonly CardDefinition[];
  /** Lookup by Scryfall id (the join key to data-tools' card-index.json). */
  get(id: string): CardDefinition | undefined;
  /** Lookup by exact card name (secondary join key). */
  getByName(name: string): CardDefinition | undefined;
  /** Effect refs that point at an unregistered primitive (empty when healthy). */
  readonly unsupportedRefs: readonly UnsupportedRef[];
  /**
   * Cards whose `attachment` data core cannot honour (empty when healthy). Kept
   * separate from {@link unsupportedRefs} because the failure is different in
   * kind: the primitive exists, the DECLARATION is unusable.
   */
  readonly attachmentProblems: readonly AttachmentProblem[];
}

/** A diagnostic for a card referencing a primitive id no registry provides. */
export interface UnsupportedRef {
  readonly cardId: string;
  readonly cardName: string;
  readonly primitive: string;
}

/** A diagnostic for a card whose attachment declaration core cannot honour. */
export interface AttachmentProblem {
  readonly cardId: string;
  readonly cardName: string;
  /** Plain-English explanation from core's `attachmentProblem`. */
  readonly problem: string;
}

/**
 * Load the curated pool, indexed for O(1) lookup. Pure and synchronous — the data
 * is a static module, never a network call (DESIGN §2.1). Validates effect refs
 * against the known primitive ids and surfaces any gaps in `unsupportedRefs`
 * (also logged via `onWarn`) rather than throwing — a card with an unknown ref
 * still loads and degrades to core's safe no-op at resolution time.
 */
export function loadCardPool(options?: {
  /** Sink for validation warnings; defaults to `console.warn`. Pass a no-op to silence. */
  readonly onWarn?: (message: string) => void;
  /** Known primitive ids to validate against; defaults to this package's set. */
  readonly knownPrimitiveIds?: readonly string[];
  /**
   * Extra definitions to load alongside the curated pool — the seam deck import
   * plugs into (DESIGN §2). The web app passes definitions produced by the
   * Oracle compiler (`./compile`) for cards the user imported, so an imported
   * deck resolves, validates and *plays* through exactly the same code path as
   * a curated one. Only definitions the compiler judged COMPLETE should be
   * passed: an id here is treated as fully playable.
   *
   * A card whose id is already in the curated pool does not override it — the
   * hand-authored definition wins, since it was written and reviewed for the
   * engine specifically.
   */
  readonly extraCards?: readonly CardDefinition[];
}): CardPool {
  const onWarn = options?.onWarn ?? ((m: string) => console.warn(m));
  const known = new Set(options?.knownPrimitiveIds ?? CORE_PRIMITIVE_IDS);

  const byId = new Map<string, CardDefinition>();
  const byName = new Map<string, CardDefinition>();
  const unsupportedRefs: UnsupportedRef[] = [];
  const attachmentProblems: AttachmentProblem[] = [];

  const curatedIds = new Set(CARD_POOL.map((card) => card.id));
  const extras = (options?.extraCards ?? []).filter((card) => !curatedIds.has(card.id));
  const allCards: readonly CardDefinition[] = extras.length > 0 ? [...CARD_POOL, ...extras] : CARD_POOL;

  for (const card of allCards) {
    if (byId.has(card.id)) onWarn(`[cards] duplicate card id '${card.id}' (${card.name})`);
    byId.set(card.id, card);
    byName.set(card.name, card);
    // Validate the resolution/ETB script refs AND every triggered-ability effect ref
    // (DESIGN §3.9): a card now carries effects via both `effects` and `triggers`.
    const refs = [
      ...(card.effects ?? []),
      ...(card.triggers ?? []).flatMap((t) => t.effects),
      ...(card.activated ?? []).flatMap((a) => a.effects),
    ];
    for (const ref of refs) {
      if (!known.has(ref.primitive)) {
        unsupportedRefs.push({ cardId: card.id, cardName: card.name, primitive: ref.primitive });
        onWarn(`[cards] '${card.name}' references unknown primitive '${ref.primitive}'`);
      }
    }
    // An attachment shape core cannot honour is the rule-6 case: report it here
    // rather than letting the card enter play and quietly do nothing.
    const attachmentIssue = attachmentProblem(card);
    if (attachmentIssue) {
      attachmentProblems.push({ cardId: card.id, cardName: card.name, problem: attachmentIssue });
      onWarn(`[cards] ${attachmentIssue}`);
    }
  }

  return {
    cards: allCards,
    get: (id) => byId.get(id),
    getByName: (name) => byName.get(name),
    unsupportedRefs,
    attachmentProblems,
  };
}

/** Direct by-id accessor without constructing a full pool (convenience). */
export function getCardDefinition(id: string): CardDefinition | undefined {
  return CARD_POOL.find((c) => c.id === id);
}

/**
 * Build a fresh `EffectRegistry` with every primitive this package provides
 * registered. Hand this to `createEngine(config, registry)` / `createGame({ …,
 * registry })` so the pool's cards resolve. Isolated per call — no shared global.
 */
export function buildRegistry(): EffectRegistry {
  const registry = createEffectRegistry();
  registerCoreEffects(registry);
  return registry;
}

/**
 * Convenience bundle for callers (sim/web/tests): a definition plus a ready
 * registry, the two things `createEngine` needs to actually play that card.
 * Returns `undefined` if the id isn't in the pool.
 */
export function getCardWithRegistry(
  id: string,
): { readonly card: CardDefinition; readonly registry: EffectRegistry } | undefined {
  const card = getCardDefinition(id);
  if (!card) return undefined;
  return { card, registry: buildRegistry() };
}
