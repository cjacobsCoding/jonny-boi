/**
 * Effect-primitive library for `@jonny-boi/cards`.
 *
 * Composition over inheritance (DESIGN §1.2): a card is *data* that references
 * these small, pure primitives by id. There is NO class-per-card. Each primitive
 * is a tiny `EffectPrimitive` (from `@jonny-boi/core`) that mutates the draft
 * `GameState` through its `EffectContext`, emits typed events, and reads every
 * tunable (damage amount, P/T delta, card count, …) from `ctx.params` — never an
 * inline literal (DESIGN §1.3, no magic numbers).
 *
 * Robustness (DESIGN §1 robust): a primitive must be safe on a missing/invalid
 * target — it degrades to a no-op rather than throwing, so a malformed cast can
 * never crash the engine. (Core already guarantees an *unknown* primitive id is a
 * safe no-op + `effectUnsupported`; these implementations guarantee the same for
 * bad targets.)
 *
 * Targeting model: core resolves targets at cast time and passes them as
 * `ctx.targets` — an array of `InstanceId` (a battlefield permanent) and/or
 * `PlayerId` (`'A'`/`'B'`). Primitives that target read `ctx.targets[i]` and
 * classify it with the helpers in `./effect-helpers`.
 *
 * This module holds the primitives that decide everything themselves. The ones
 * that must ASK a player something mid-resolution (discard *which* card, put these
 * back in *what* order, do you *want* to search) live in `./choice-primitives`
 * and are merged into the same {@link CORE_PRIMITIVES} registry below.
 */

import type {
  CardDefinition,
  CardFilter,
  CardInstance,
  CardType,
  EffectContext,
  EffectPrimitive,
  EffectRef,
  EffectRegistry,
  GameEvent,
  InstanceId,
  PlayerId,
  ReplacementIndex,
  StaticAbility,
  TokenEntryOptions,
  TriggeredAbility,
} from '@jonny-boi/core';
import {
  MANA_COLORS,
  addCardGrant,
  // §3.150 — the one-shot half of the does-not-untap family; the untap step is
  // the only thing that spends what this adds.
  addUntapSkips,
  MINUS_ONE_COUNTER,
  PLUS_ONE_COUNTER,
  aggregateFor,
  colorsOfDefinition,
  effectiveKeywords,
  effectivePower,
  turnFactHolds,
  isCreature,
  // §3.149 — "if it WAS a creature card", asked of the definition by type word.
  hasType,
  isLegalTarget,
  matchesCardFilter,
  isPlaneswalker,
  type ManaColor,
  type ManaCost,
  protectionPreventsDamage,
  drawCardForPlayer,
  indexReplacements,
  consumeRegenerationShield,
  interveningIfHolds,
  loseGame,
  winGame,
  replaceCounters,
  replaceDamage,
  // poison family (§3.105): the CR 120.3 result funnel every damage site here
  // applies, the continuous index it reads keywords through, and the one
  // poison reader/writer proliferate's player half uses.
  applyDamageResult,
  indexContinuous,
  addPoisonCounters,
  isPoisoned,
  PLAYER_IDS,
} from '@jonny-boi/core';
import {
  boolParam,
  changeLife,
  counterSpellOnStack,
  moveOwnedCard,
  restrictionParam,
  firstPermanentTarget,
  // §3.149 — the graveyard-card target is looked up wherever it is, not on the
  // battlefield, so the exile reads the same instance the aim named.
  firstTargetInstance,
  firstPlayerTarget,
  playersForParam,
  intParam,
  isEmptyKeywords,
  isPlayerTarget,
  keywordsParam,
  manaValueOf,
  millTopCards,
  movePermanentTo,
  otherPlayer,
  permanentById,
  selfIfCreature,
  strArrayParam,
  strParam,
  subjectCreatures,
  targetedSpellOnStack,
} from './effect-helpers.js';
import { CHOICE_PRIMITIVES } from './choice-primitives.js';
import { PREDEFINED_TOKEN_DEFS } from './predefined-tokens.js';
import { COPY_PRIMITIVES } from './copy-primitives.js';
import { UPKEEP_COST_PRIMITIVES } from './upkeep-cost-primitives.js';
import { CAST_ALTERNATIVE_PRIMITIVES } from './cast-alternative-primitives.js';
import { GRAVEYARD_CAST_PRIMITIVES } from './graveyard-cast-primitives.js';
import { EXILE_UNTIL_LEAVES_PRIMITIVES } from './exile-until-leaves.js';
import { TRIGGER_COPY_PRIMITIVES } from './trigger-copy-primitives.js';
import { BLINK_PRIMITIVES } from './blink-primitives.js';
import { COUNTER_KEYWORD_PRIMITIVES } from './counter-keyword-primitives.js';
import { SPELL_COUNT_PRIMITIVES } from './spell-count-primitives.js';
import { ITERATIVE_PRIMITIVES } from './iterative-primitives.js';
import { WALKER_RESIDUE_PRIMITIVES } from './walker-residue-primitives.js';

// --- the primitives ------------------------------------------------------------

/**
 * The ONE question every NONCOMBAT damage site in this package asks: how much
 * damage is actually dealt, after the replacement and prevention layer
 * (CR 614/615)? Combat asks the same question through the same engine —
 * `internal/replacement.ts` — from `internal/combat.ts`.
 *
 * Returns the amount to deal, and emits the `damagePrevented` half itself so
 * every caller reports a prevented hit identically. Inert when nothing in the
 * game replaces anything: `index.length === 0` and an immediate return.
 */
function damageAfterReplacement(
  ctx: EffectContext,
  index: ReplacementIndex,
  emit: (e: GameEvent) => void,
  source: CardInstance,
  recipient: CardInstance | undefined,
  affectedPlayer: PlayerId,
  amount: number,
): number {
  if (index.length === 0) return amount;
  const result = replaceDamage(
    ctx.state,
    index,
    source,
    source.controller,
    recipient,
    affectedPlayer,
    amount,
    false,
    emit,
  );
  if (result.prevented > 0) {
    emit({
      type: 'damagePrevented',
      source: source.instanceId,
      target: recipient === undefined ? affectedPlayer : recipient.instanceId,
      amount: result.prevented,
      combat: false,
    });
  }
  return result.amount;
}

/**
 * `dealDamage` — deal `amount` damage to the chosen target. Reads `params.amount`
 * and `params.targets`, the {@link TargetRestriction} naming what the printed card
 * may point at:
 *
 *   - `'any'` (the default) — "any target": a creature or a player. Lightning Bolt.
 *   - `'creature'` — "target creature" only. Flame Slash, which must NEVER be able
 *     to point four damage at a face for one mana.
 *   - `'player'` — "target player or planeswalker" only. Lava Spike, which must
 *     never kill a creature.
 *
 * With NO target at all it reads `params.whichPlayer` instead — the UNTARGETED
 * player form a trigger prints ("~ deals 1 damage to that player"), resolved
 * through the shared `playersForParam` vocabulary. That form asks nobody to aim
 * anything, which is the printed card: the trigger already knows who it means.
 *
 * A creature target gets marked damage (SBAs destroy it if lethal); a player target
 * loses life — or, from an infect/wither source, -1/-1 counters and poison instead:
 * the CR 120.3 result funnel (`applyDamageResult`, §3.105) decides, not this
 * primitive. The restriction is already enforced when the cast is offered and when
 * it is applied (core's targeting.ts); it is re-checked HERE because a target can
 * stop being legal between cast and resolution — and because a primitive that
 * quietly ignores its own restriction would make the whole guarantee depend on
 * every caller remembering it. No valid target → safe no-op.
 */
export const dealDamage: EffectPrimitive = (ctx) => {
  const amount = intParam(ctx, 'amount', 0);
  if (amount <= 0) return;
  const target = ctx.targets[0];
  const replacements = indexReplacements(ctx.state);
  // ONE continuous index per resolution, threaded into the CR 120.3 result
  // funnel so the SOURCE's effective keywords (a granted infect, a lifelink
  // Aura) are read exactly as combat reads them — `applyDamageResult` is the
  // one place the results of damage are decided (§3.105).
  const index = indexContinuous(ctx.state);
  // `ctx.emit` is a plain function property on the context (see core's
  // `createEffectContext`), never a `this`-bound method, so it is passed by
  // reference rather than wrapped — a wrapper here would be one closure
  // allocated per damage event on the engine's hottest path.
  const emit = ctx.emit;
  if (target === undefined) {
    // The UNTARGETED player form — "~ deals 1 damage to that player" / "to
    // them", printed by a trigger that already knows who it means. No targeting
    // question is asked and no target restriction applies, because the printed
    // line names no target: it names the player the trigger was about. With no
    // `whichPlayer` either, there is genuinely nothing to damage — a safe no-op,
    // exactly as before. It IS damage, so the replacement layer and the result
    // funnel both apply — a fog stops it and an infect source poisons with it.
    const whichPlayer = strParam(ctx, 'whichPlayer');
    if (whichPlayer === undefined) return;
    for (const victim of playersForParam(ctx, whichPlayer)) {
      const dealt = damageAfterReplacement(ctx, replacements, emit, ctx.source, undefined, victim, amount);
      applyDamageResult(ctx.state, ctx.source, victim, dealt, false, index, emit);
    }
    return;
  }
  // `ctx.controller` is passed so an "opponent-only" restriction can be judged —
  // without it the check cannot tell the caster apart from their opponent.
  // The source definition rides along so protection's "can't be targeted" half
  // re-fizzles a target that gained protection between cast and resolution.
  if (!isLegalTarget(ctx.state, restrictionParam(ctx), target, ctx.controller, ctx.source.def)) return; // illegal → fizzle

  if (isPlayerTarget(target)) {
    const dealt = damageAfterReplacement(ctx, replacements, emit, ctx.source, undefined, target, amount);
    applyDamageResult(ctx.state, ctx.source, target, dealt, false, index, emit);
    return;
  }
  const perm = permanentById(ctx.state, target);
  if (!perm) return; // target fizzled (already gone) — safe no-op
  const dealt = damageAfterReplacement(ctx, replacements, emit, ctx.source, perm, perm.controller, amount);
  // Walker loyalty (CR 120.3c), battle defense (120.3h), marked damage or
  // -1/-1 counters (120.3d/e): all rows of the one result table.
  applyDamageResult(ctx.state, ctx.source, perm, dealt, false, index, emit);
};

/**
 * `drawCards` — `params.count` cards are drawn by whoever `params.whichPlayer`
 * names, through the shared {@link playersForParam} vocabulary: the controller
 * by default, `'opponent'` (Goblin Guide's attack trigger), `'targetPlayer'`
 * (Sign in Blood), `'triggering'` — the player whose step/draw set the trigger
 * off, which is Howling Mine's "that player" — or `'each'`, both seats in APNAP
 * order ("each player draws a card").
 *
 * Drawing from an empty library flags a loss via SBA on the next check (we move
 * the top card or stop). An empty library ends THAT PLAYER's draws and nobody
 * else's — in "each player draws a card" the other player still draws, which is
 * what the card says.
 * Used by Brainstorm (3), Ponder (1), Cryptic Command (1).
 */
export const drawCards: EffectPrimitive = (ctx) => {
  const count = intParam(ctx, 'count', 1);
  for (const drawer of playersForParam(ctx, strParam(ctx, 'whichPlayer'))) {
    const player = ctx.state.players[drawer];
    for (let i = 0; i < count; i++) {
      // Decking: leave the empty library; core's SBA will register the loss when
      // a *draw step* draw fails. A spell-driven empty draw is rare in the pool;
      // stop rather than fabricate a loss event here. Checked BEFORE the draw
      // (rather than by a failed `shift()`) because the draw itself now goes
      // through core, and an empty library ends THIS player's draws and nobody
      // else's — in "each player draws a card" the other player still draws.
      if (player.library.length === 0) break;
      // Core's draw, not a second copy of it: "if you would draw a card, draw
      // two instead" and "…you win the game instead" (the CR 614 replacement
      // layer) have to mean the same thing for a Divination as for a draw step,
      // and one implementation is how that is guaranteed rather than remembered.
      drawCardForPlayer(ctx.state, drawer, ctx.emit);
      if (ctx.state.gameOver) return;
    }
  }
};

/**
 * `gainLife` — the controller (or a target player) gains `params.amount` life.
 * Used by Kitchen Finks ETB (2). If `params.targetPlayer` is true, the first
 * player target gains the life instead of the controller.
 */
export const gainLife: EffectPrimitive = (ctx) => {
  const amount = intParam(ctx, 'amount', 0);
  if (amount <= 0) return;
  const useTarget = ctx.params.targetPlayer === true;
  const player = useTarget ? firstPlayerTarget(ctx) ?? ctx.controller : ctx.controller;
  // The AMOUNT the player really gained, not the amount printed: a life-gain
  // replacement may have doubled it (Rhox Faithmender) or zeroed it (Sulfuric
  // Vortex), and "whenever you gain life" must see the true number or no event
  // at all (CR 118.5).
  const gained = changeLife(ctx, player, amount);
  if (gained > 0) ctx.emit({ type: 'gainLife', player, amount: gained });
};

/**
 * `winTheGame` — the printed sentence "You win the game" (Revel in Riches,
 * Hellkite Tyrant, Chimil). Core's own `winGame` verb, so an alt-win and the
 * SBA pass can never disagree about what winning means; the pass that follows
 * the resolution is what settles `gameOver`, exactly as a lethal SBA does.
 */
export const winTheGame: EffectPrimitive = (ctx) => {
  winGame(ctx.state, ctx.controller, `${ctx.source.def.name}: you win the game`, ctx.emit);
};

/**
 * `loseTheGame` — the printed sentence "You lose the game" (Pact of Negation's
 * unpaid upkeep). The controller's own loss, through the same one `loseGame`
 * verb every other loss uses.
 */
export const loseTheGame: EffectPrimitive = (ctx) => {
  loseGame(ctx.state, ctx.controller, `${ctx.source.def.name}: you lose the game`, ctx.emit);
};

/**
 * `loseLife` — a player loses `params.amount` life. Defaults to the controller;
 * with `params.targetPlayer` true the first player target loses it instead, and
 * otherwise `params.whichPlayer` picks the loser from the shared
 * {@link playersForParam} vocabulary — `'opponent'` ("each opponent loses 1
 * life"), `'triggering'` ("that player loses 1 life"), or `'each'` ("each player
 * … loses 1 life"). Used by Thoughtseize (controller loses 2).
 */
export const loseLife: EffectPrimitive = (ctx) => {
  const amount = intParam(ctx, 'amount', 0);
  if (amount <= 0) return;
  const useTarget = ctx.params.targetPlayer === true;
  // `whichPlayer: 'opponent'` is the same vocabulary `drawCards` uses, and it is
  // what an UNTARGETED "each opponent loses 1 life" needs: a trigger body has no
  // chosen target to read, so `targetPlayer` cannot express it. In this engine a
  // game is always exactly two seats (`PLAYER_IDS`), so "each opponent" and "the
  // opponent" name the same player — the printed plural has no other referent.
  const victims = useTarget
    ? [firstPlayerTarget(ctx) ?? ctx.controller]
    : playersForParam(ctx, strParam(ctx, 'whichPlayer'));
  for (const player of victims) changeLife(ctx, player, -amount);
};

/**
 * `pumpUntilEndOfTurn` — give a creature +X/+Y *until end of turn* (DESIGN §3.9).
 * Reads `params.power` / `params.toughness`. With engine-v2's continuous-effects
 * layer this registers a real "until end of turn" modification via
 * `ctx.addContinuousEffect`, so the buff changes effective P/T (and combat math)
 * immediately AND genuinely wears off in the cleanup step — no more persistent
 * +1/+1-counter hack that biased combat sims (DESIGN §3.9 / §3.2 revisit).
 *
 * Target resolution: the first creature target among `ctx.targets` (a combat trick
 * like Giant Growth), or — when no target was chosen — the source itself (a
 * cast-trigger pumping its own permanent, e.g. prowess). A pump with no valid
 * creature anywhere → safe no-op. Asymmetric pumps (+X/+Y, X≠Y) are now fully
 * faithful since power and toughness are independent deltas.
 */
export const pumpUntilEndOfTurn: EffectPrimitive = (ctx) => {
  const power = intParam(ctx, 'power', 0);
  const toughness = intParam(ctx, 'toughness', 0);
  if (power === 0 && toughness === 0) return;
  // The creature(s) pumped: the chosen target, else the source — or, with
  // `subject: 'triggering'`, the object(s) the trigger's event was about
  // (exalted's lone attacker, flanking's blocker — DESIGN §3.107). One reader
  // for the question, so the default path resolves exactly as it always has.
  for (const target of subjectCreatures(ctx)) {
    ctx.addContinuousEffect({ target: target.instanceId, power, toughness, duration: 'endOfTurn' });
  }
};

/**
 * `grantKeywordUntilEndOfTurn` — grant the target creature (or, with no target, the
 * source) one or more keywords *until end of turn* (DESIGN §3.9): e.g. trample,
 * flying, or haste for the turn. Reads `params.keywords` (a `{ flying: true, … }`
 * flag object). Registered through the continuous layer so combat/legality read the
 * effective keyword set and the grant expires at cleanup. No valid creature → no-op.
 */
export const grantKeywordUntilEndOfTurn: EffectPrimitive = (ctx) => {
  const keywords = keywordsParam(ctx);
  if (isEmptyKeywords(keywords)) return;
  const target = firstPermanentTarget(ctx) ?? selfIfCreature(ctx);
  if (!target || !isCreature(target.def)) return;
  ctx.addContinuousEffect({ target: target.instanceId, keywords, duration: 'endOfTurn' });
};

/**
 * `grantKeywordToYoursUntilEndOfTurn` — the MASS form of the grant above:
 * "Creatures you control gain indestructible until end of turn" (Selfless
 * Spirit), "Permanents you control gain hexproof and indestructible until end of
 * turn" (Heroic Intervention).
 *
 * It is a separate primitive rather than a flag on the single-target one because
 * it targets NOTHING: there is no chosen creature, no legality question, and the
 * set it reaches is decided at RESOLUTION from the board as it then stands. That
 * is also why it must not be modelled as a static — the grant outlives the spell
 * that made it (until cleanup) and reaches only the permanents that were there.
 *
 * `params.anyOfTypes` narrows the set the way the printed noun does; omitting it
 * is the printed word "permanents", which narrows nothing. `params.scope` is
 * `'you'` (the default) or `'opponent'`.
 */
export const grantKeywordToYoursUntilEndOfTurn: EffectPrimitive = (ctx) => {
  const keywords = keywordsParam(ctx);
  if (isEmptyKeywords(keywords)) return;
  const types = strArrayParam(ctx, 'anyOfTypes');
  const opponents = strParam(ctx, 'scope') === 'opponent';
  for (const perm of ctx.state.battlefield) {
    const theirs = perm.controller !== ctx.controller;
    if (theirs !== opponents) continue;
    if (types.length > 0 && !types.some((type) => perm.def.types.includes(type as CardType))) continue;
    ctx.addContinuousEffect({ target: perm.instanceId, keywords, duration: 'endOfTurn' });
  }
};

/**
 * The five colours a printed token may declare, in canonical order. Used to keep
 * a `colors` param honest: anything outside this set is not a colour and is
 * dropped, so a malformed param degrades to "colorless" rather than to a
 * definition core's colour reader has to defend against.
 */
const TOKEN_COLORS: readonly string[] = ['W', 'U', 'B', 'R', 'G'];

/**
 * The card types a token may declare. Closed on purpose: a token's type line is
 * printed text ("artifact creature token", "enchantment creature token"), and a
 * type outside this set would be either meaningless (a token is never an instant)
 * or a permanent kind with entry rules of its own (a planeswalker or battle token
 * needs printed loyalty/defense, which the token rule does not read).
 */
const TOKEN_TYPES: readonly CardType[] = ['artifact', 'creature', 'enchantment', 'land'];

/**
 * `makeToken` — create `params.count` (default 1) tokens under the controller via
 * engine-v2's `ctx.createToken`, so each enters the battlefield properly
 * (summoning-sick unless it has haste) and fires ETB triggers like any permanent.
 *
 * **EVERY characteristic the printed token has is DATA from params**, and that is
 * not a style point — it is the fix for a real infidelity. A token is printed as
 * a whole card face ("a 1/1 **black** **Faerie Rogue** creature token **with
 * flying**"), and for a long time this primitive built a definition with a name,
 * a P/T and nothing else. Every token in the game therefore entered COLOURLESS
 * and with NO CREATURE TYPE, which made it invisible to a coloured anthem, to
 * protection from a colour, to "destroy target nonblack creature" and to every
 * typal lord — while the card still compiled `'complete'`.
 *
 *   - `power` / `toughness` — the printed box.
 *   - `name`               — the token's name; also its default creature type,
 *                            because a "Goblin" token IS a Goblin. Pass
 *                            `subtypes` explicitly for a multi-type token
 *                            ("Faerie Rogue") or one whose name is not a type.
 *   - `subtypes`           — the printed subtype line.
 *   - `colors`             — the printed colour WORDS, `[]` for the printed word
 *                            "colorless". A token has no mana cost, so this is
 *                            the only place its colour can come from.
 *   - `types`             — the printed type line; defaults to `['creature']`,
 *                            and "artifact creature" passes `['artifact',
 *                            'creature']`.
 *   - `keywords`           — "with flying", "with deathtouch".
 *
 * The definition `id` carries the whole face rather than just the name, so two
 * genuinely different tokens with the same name (a 1/1 white Soldier and a 1/1
 * colourless Soldier artifact creature) are not conflated by anything keying on
 * id — the UI's art lookup, a log line, an AI's card memo.
 */
/**
 * `createPredefinedToken` — "Create a Treasure token" / "…a Clue token" /
 * "…a Food token" (CR 111.10).
 *
 * The rules define these faces once, globally, so the primitive looks the
 * definition up in {@link PREDEFINED_TOKEN_DEFS} rather than assembling one
 * from params — every card that names a Treasure means exactly that object,
 * abilities included. A `token` value outside the table is a safe no-op (the
 * compiler never emits one; this guards hand-authored data).
 *
 * Params: `token` ('treasure' | 'clue' | 'food'), `count` (default 1),
 * `tapped` (the printed word "tapped").
 */
export const createPredefinedToken: EffectPrimitive = (ctx) => {
  const kind = strParam(ctx, 'token');
  const def = kind === undefined ? undefined : PREDEFINED_TOKEN_DEFS[kind];
  if (def === undefined) return;
  const count = intParam(ctx, 'count', 1);
  // ONE call with the count — a single CR 614 event, exactly as `makeToken`.
  ctx.createTokens(def, count, undefined, ctx.params.tapped === true ? { tapped: true } : undefined);
};

/**
 * The token DEFINITION a params bag describes — extracted from {@link makeToken}
 * so every primitive that creates a printed token reads the descriptor the same
 * way (rule 12). `makeToken` creates it; `livingWeaponGerm` creates it and then
 * attaches its source to it. A second copy of this reader would eventually
 * disagree about a colour or a subtype line and the bug would belong to neither.
 */
function tokenDefFromParams(ctx: EffectContext): CardDefinition {
  const power = intParam(ctx, 'power', 1);
  const toughness = intParam(ctx, 'toughness', 1);
  const name = strParam(ctx, 'name') ?? 'Token';
  const keywords = keywordsParam(ctx);
  // A token's colour is printed in words and it has no mana cost, so an ABSENT
  // param and an EMPTY one must stay distinguishable: absent means the caller
  // said nothing (core falls back to the — nonexistent — pips and reads
  // colourless), `[]` means the printed word "colorless". `ctx.params.colors`
  // is therefore tested for presence before `strArrayParam` flattens it.
  const colors =
    ctx.params.colors === undefined
      ? undefined
      : strArrayParam(ctx, 'colors').filter((c) => TOKEN_COLORS.includes(c));
  const declaredTypes = strArrayParam(ctx, 'types').filter((t): t is CardType =>
    TOKEN_TYPES.includes(t as CardType),
  );
  const types: readonly CardType[] = declaredTypes.length > 0 ? declaredTypes : ['creature'];
  // The printed subtype line, defaulting to the token's own name: "create a 1/1
  // red Goblin creature token" makes an object that IS a Goblin, which is what a
  // typal lord and a "sacrifice a Goblin" cost both select on.
  const declaredSubtypes = strArrayParam(ctx, 'subtypes');
  const subtypes = declaredSubtypes.length > 0 ? declaredSubtypes : [name];
  return {
    id: `token:${[...types].join('-')}:${(colors ?? []).join('') || 'c'}:${subtypes.join('-')}:${power}/${toughness}`,
    name,
    types,
    subtypes,
    // No `isToken` here on purpose: core stamps it in `createTokenInState`, so
    // token-ness is a property of HOW the object was created and is true of
    // every token the engine makes, including ones built from a definition that
    // came from elsewhere (a token COPY). One place, not two.
    power,
    toughness,
    ...(colors === undefined ? {} : { colors: colors as CardDefinition['colors'] }),
    ...(isEmptyKeywords(keywords) ? {} : { keywords }),
  };
}

/**
 * LIVING WEAPON (CR 702.92a) — "When this Equipment enters, create a 0/0 black
 * Phyrexian Germ creature token, then attach this to it."
 *
 * Composition, not a new system: the token comes from the same descriptor reader
 * every printed token uses, and the attach is core's one attachment funnel
 * (`ctx.attach` → `attachTo`), the same one an Equip ability and an Aura's
 * resolution go through. So the Germ is a real object that dies to the 0/0
 * state-based action the moment the Equipment stops buffing it, and the
 * Equipment's own `whenIllegal: detach` rule applies to it unchanged.
 *
 * ⚠️ ORDER MATTERS, and the printed word is "then". The token must EXIST before
 * the attach, because a 0/0 Germ with nothing attached is lethal to itself: if
 * the attach ran first (or failed silently) the card would read as working while
 * the Germ died immediately. `createTokens` returns the new ids for exactly this,
 * and a run that made no token attaches nothing rather than attaching to a guess.
 */
export const livingWeaponGerm: EffectPrimitive = (ctx) => {
  const made = ctx.createTokens(tokenDefFromParams(ctx), 1, undefined, tokenEntryParam(ctx));
  const germ = made[0];
  if (germ === undefined) return;
  ctx.attach(germ);
};

export const makeToken: EffectPrimitive = (ctx) => {
  const count = intParam(ctx, 'count', 1);
  const def = tokenDefFromParams(ctx);
  // ONE call with the count, not a loop of ones: "create **two** 1/1 tokens" is
  // a single CR 614 event, so a doubler must see the 2 and replace it once (see
  // `EffectContext.createTokens`).
  ctx.createTokens(def, count, undefined, tokenEntryParam(ctx));
};

/**
 * How the printed instruction says the token ARRIVES — "create a **tapped**
 * Treasure token" (Skyclave Relic, Kambal), "**tapped and attacking**" (Delina,
 * Mobilize).
 *
 * `undefined` when it says neither, so a token-maker that prints nothing extra
 * passes nothing extra and the entry path is byte-for-byte what it always was.
 */
function tokenEntryParam(ctx: EffectContext): TokenEntryOptions | undefined {
  const tapped = ctx.params.tapped === true;
  const attacking = ctx.params.attacking === true;
  if (!tapped && !attacking) return undefined;
  return { ...(tapped ? { tapped } : {}), ...(attacking ? { attacking } : {}) };
}

/**
 * `createEmblem` — put an EMBLEM into the controller's command zone (CR 114), the
 * thing a planeswalker ultimate leaves behind. Everything about it is DATA from
 * params, so there is no emblem-per-card and no magic anything:
 *   - `name`     — what the emblem is called in the log and the UI. The printed
 *                  wording is "an emblem with '<ability>'", so the default names
 *                  it after the source, which is how a real emblem is referred to.
 *   - `statics`  — static abilities it radiates ("creatures you control get
 *                  +1/+1"), in core's `StaticAbility` shape.
 *   - `triggers` — triggered abilities it fires ("at the beginning of your
 *                  upkeep, …"), in core's `TriggeredAbility` shape.
 *
 * An emblem with NEITHER is refused rather than created: it would be an object
 * that provably does nothing, which is exactly the "looks implemented, isn't"
 * outcome the compiler contract exists to prevent. The compiler never emits one,
 * so this is a guard against hand-authored data, not a live branch.
 *
 * Nothing here has to make the emblem unremovable — it never touches the
 * battlefield, and every removal path in the engine reaches only there.
 */
export const createEmblem: EffectPrimitive = (ctx) => {
  const statics = staticsParam(ctx);
  const triggers = triggersParam(ctx);
  // §3.150 — the THIRD channel: an emblem ability that is a flag on the
  // definition rather than a static or a trigger ("You have no maximum hand
  // size", the case `player-statics.ts` reads from the command zone). Filtered
  // against a CLOSED allow-list here as well as at compile time, because this
  // primitive's params can also arrive from generated pool data.
  const definitionFields = emblemDefinitionFieldsParam(ctx);
  const fieldCount = Object.keys(definitionFields).length;
  if (statics.length === 0 && triggers.length === 0 && fieldCount === 0) return;
  const name = strParam(ctx, 'name') ?? `${ctx.source.def.name} emblem`;
  const def: CardDefinition = {
    id: `emblem:${name}`,
    name,
    // An emblem has no card types at all (CR 114.1) — it is not a permanent, and
    // an empty type line is what keeps every type-filtered effect from seeing it.
    types: [],
    isEmblem: true,
    ...(statics.length > 0 ? { statics } : {}),
    ...(triggers.length > 0 ? { triggers } : {}),
    ...definitionFields,
  };
  ctx.createEmblem(def);
};

/**
 * The CLOSED set of `CardDefinition` flags an emblem may carry directly. The
 * runtime twin of the compiler's `EMBLEM_DEFINITION_FIELDS`, and it is a second
 * copy on purpose: params reaching this primitive are DATA (generated pool
 * modules, a saved game) and a permissive spread here would let a field the
 * compiler would have refused arrive anyway, on an object nothing can remove.
 * `compile/loyalty-emblem-family.test.ts` fails if the two lists diverge — the
 * only thing holding a deliberate second copy honest.
 */
export const EMBLEM_DEFINITION_FIELD_NAMES: readonly string[] = Object.freeze(['noMaximumHandSize']);

/** The `definitionFields` param, narrowed to the allow-list and to `true` values. */
function emblemDefinitionFieldsParam(ctx: EffectContext): Record<string, true> {
  const raw = ctx.params.definitionFields;
  if (typeof raw !== 'object' || raw === null) return {};
  const out: Record<string, true> = {};
  for (const key of EMBLEM_DEFINITION_FIELD_NAMES) {
    if ((raw as Record<string, unknown>)[key] === true) out[key] = true;
  }
  return out;
}

/**
 * The `statics` param as a `StaticAbility` list, validated shallowly: an entry
 * must at least be an object carrying an `affects` filter, or the continuous
 * layer would read `undefined` as "applies to everything". A malformed entry is
 * dropped rather than thrown on (DESIGN §1 robust).
 */
function staticsParam(ctx: EffectContext): readonly StaticAbility[] {
  const raw = ctx.params.statics;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (entry): entry is StaticAbility =>
      typeof entry === 'object' && entry !== null && typeof (entry as { affects?: unknown }).affects === 'object',
  );
}

/**
 * The `triggers` param as a `TriggeredAbility` list, validated the same way: an
 * entry must carry a condition naming an event and an effects array, or core's
 * matcher would never fire it and the emblem would silently do nothing.
 */
function triggersParam(ctx: EffectContext): readonly TriggeredAbility[] {
  const raw = ctx.params.triggers;
  if (!Array.isArray(raw)) return [];
  return raw.filter((entry): entry is TriggeredAbility => {
    if (typeof entry !== 'object' || entry === null) return false;
    const condition = (entry as { condition?: unknown }).condition;
    const effects = (entry as { effects?: unknown }).effects;
    return (
      typeof condition === 'object' &&
      condition !== null &&
      typeof (condition as { on?: unknown }).on === 'string' &&
      Array.isArray(effects)
    );
  });
}

/**
 * `persistReturn` — the death-return half of *persist* (DESIGN §3.9). Authored as a
 * `dies` trigger's effect: when the creature dies, return it to the battlefield
 * under its owner with a -1/-1 counter (modelled as a negative `+1/+1` counter, the
 * one counter the stat layer reads — so a 3/2 returns as a 2/1). Reads
 * `params.minusCounters` (default 1) for the magnitude.
 *
 * "Dies for good the second time": the returned body comes back as a copy whose
 * definition has had *this* persist trigger stripped (identified by the
 * `persistReturn` primitive in its effects). So when it dies again it no longer has
 * a persist trigger to fire — exactly mirroring real persist's "only if it had no
 * -1/-1 counter" guard, without relying on counter state that the engine wipes when
 * a permanent leaves the battlefield. The ETB half (e.g. Kitchen Finks' lifegain)
 * is authored as a separate `etb` trigger so it re-fires on the persist return.
 *
 * At resolution the source sits in its owner's graveyard (last-known information);
 * if it isn't there (already moved/exiled) this is a safe no-op.
 */
export const persistReturn: EffectPrimitive = (ctx) => {
  const minus = intParam(ctx, 'minusCounters', 1);
  const source = ctx.source;
  const owner = ctx.state.players[source.owner];
  const idx = owner.graveyard.findIndex((c) => c.instanceId === source.instanceId);
  if (idx < 0) return; // not in the graveyard (already left) — safe no-op
  const dead = owner.graveyard[idx]!;
  owner.graveyard.splice(idx, 1);

  // Return a copy whose definition no longer carries this persist trigger, so a
  // second death cannot re-persist (it now "has a -1/-1 counter").
  const returnedDef: CardDefinition = stripPersistTriggers(dead.def);
  const returned: CardInstance = {
    instanceId: dead.instanceId,
    def: returnedDef,
    controller: source.owner,
    owner: source.owner,
    zone: 'battlefield',
    tapped: false,
    summoningSick: isCreature(returnedDef),
    damageMarked: 0,
    markedByDeathtouch: false,
    attachedTo: null,
    // A REAL -1/-1 counter (CR 702.79a), not a negative +1/+1. The two read the
    // same through `counterShift`, which is why this survived as a negative
    // tally — but persist's own printed condition is "if it had no -1/-1
    // counters on it", and the CR 704.5q annihilation in `internal/sba.ts` looks
    // for a counter of this KIND. Written as a negative +1/+1 the returning
    // creature was invisible to both.
    counters: { [MINUS_ONE_COUNTER]: Math.max(minus, 0) },
  };
  ctx.state.battlefield.push(returned);
  ctx.emit({
    type: 'counterAdded',
    instanceId: returned.instanceId,
    kind: MINUS_ONE_COUNTER,
    amount: Math.max(minus, 0),
  });
  // A battlefield entry: emit the zoneChange so ETB triggers (e.g. the lifegain
  // half of persist) observe the return through the one "enters" mechanism.
  ctx.emit({ type: 'zoneChange', instanceId: returned.instanceId, from: 'graveyard', to: 'battlefield' });
};

/**
 * `destroyTarget` — destroy the target creature (move it to its owner's
 * graveyard), optionally restricted by `params.notColor` (e.g. Doom Blade:
 * nonblack) or `params.maxManaValue` (e.g. Fatal Push: mana value ≤ N). A
 * target failing the restriction → safe no-op (the spell "fizzles" on it).
 *
 * `maxManaValue` accepts either a plain number or a REVOLT SWITCH
 * `{ base, revolt }` — Fatal Push's "2 or less, or 4 or less instead if a
 * permanent left the battlefield under your control this turn". Which bound
 * applies is read from the turn's fact memory AT RESOLUTION (core's
 * `turnFactHolds`), which is when the printed card checks it.
 */
export const destroyTarget: EffectPrimitive = (ctx) => {
  const target = firstPermanentTarget(ctx);
  if (!target) return;
  // Which permanents this may destroy comes from the DECLARED restriction, not a
  // hard-coded creature check — otherwise "destroy target artifact" would find a
  // legal artifact target and then silently do nothing to it.
  if (!isLegalTarget(ctx.state, restrictionParam(ctx), target.instanceId, ctx.controller, ctx.source.def)) return;
  if (!passesDestroyFilter(ctx, target)) return;
  destroyPermanent(ctx, target);
};

/**
 * `exileTarget` — exile the target creature. Used by removal that exiles rather
 * than destroys (Path to Exile, Swords to Plowshares). `params.gainLifeEqualPower`
 * true → the creature's controller gains life equal to its power first (Swords).
 */
export const exileTarget: EffectPrimitive = (ctx) => {
  const target = firstPermanentTarget(ctx);
  if (!target || !isCreature(target.def)) return;
  if (ctx.params.gainLifeEqualPower === true) {
    // The aggregate, not a bare read: a characteristic-defining creature
    // (Tarmogoyf) has no printed power, so "life equal to its power" would gain
    // zero without the layer-7a value the aggregation supplies.
    const power = effectivePower(target, aggregateFor(ctx.state, target.instanceId));
    if (power > 0) {
      // As in `gainLife`: the emitted amount is what was actually gained after
      // replacement, and a gain of zero emits nothing (CR 118.5).
      const gained = changeLife(ctx, target.controller, power);
      if (gained > 0) ctx.emit({ type: 'gainLife', player: target.controller, amount: gained });
    }
  }
  movePermanentTo(ctx, target, 'exile');
};

/**
 * `destroyAll` — destroy every creature on the battlefield (a board wipe). Used
 * by Wrath of God. No params required. Iterates a snapshot so mutation while
 * looping is safe.
 */
export const destroyAll: EffectPrimitive = (ctx) => {
  const creatures = ctx.state.battlefield.filter((c) => isCreature(c.def));
  for (const creature of creatures) destroyPermanent(ctx, creature);
};

/**
 * `addMana` — add mana to the controller's pool. `params.mana` is an array of
 * color symbols, e.g. `['B','B','B']` for Dark Ritual. Each symbol emits a
 * `manaAdded` event. Colors not in the engine's palette are ignored.
 */
export const addMana: EffectPrimitive = (ctx) => {
  const symbols = strArrayParam(ctx, 'mana');
  const pool = ctx.state.players[ctx.controller].manaPool;
  for (const sym of symbols) {
    // Membership is tested against the COLOUR PALETTE, not against the pool
    // object. A pool carrying spend restrictions also carries a `restricted`
    // key, so `sym in pool` would answer true for it — turning a malformed card
    // param into a write over the restriction list. The palette is the authority
    // on what a colour is; the pool is merely where they are counted.
    if ((MANA_COLORS as readonly string[]).includes(sym)) {
      const color = sym as ManaColor;
      pool[color] += 1;
      ctx.emit({ type: 'manaAdded', player: ctx.controller, color, amount: 1 });
    }
  }
};

/**
 * `counterSpell` — counter the target spell on the stack (remove it; it goes to
 * its owner's graveyard without resolving). Used by Counterspell and (one mode
 * of) Cryptic Command. The target instance id must currently be on the stack;
 * otherwise safe no-op (the spell already left the stack). Since the engine
 * resolves the stack LIFO and this primitive runs during *this* spell's
 * resolution, a real counter would need stack targeting at cast time; we counter
 * by instance id if present.
 *
 * The conditional form — "counter target spell **unless** its controller pays
 * {3}" — is `counterUnlessPaid` in `./choice-primitives`, because it has to ask a
 * question. Both share the counter itself (`counterSpellOnStack`).
 */
export const counterSpell: EffectPrimitive = (ctx) => {
  const spell = targetedSpellOnStack(ctx);
  if (!spell) return; // already gone, or not a spell — safe no-op
  counterSpellOnStack(ctx, spell);
};

/**
 * `createToken` — put `params.count` (default 1) creature tokens onto the
 * battlefield under the controller. Token P/T/name/keywords come from params so
 * there are no magic numbers. Used by token-makers (when a trigger system lands;
 * also usable as an ETB token script). Each token is a fresh instance with a
 * minimal generated `CardDefinition`.
 */
export const createToken: EffectPrimitive = (ctx) => {
  const count = intParam(ctx, 'count', 1);
  const power = intParam(ctx, 'power', 1);
  const toughness = intParam(ctx, 'toughness', 1);
  const name = strParam(ctx, 'name') ?? 'Token';
  // ⚠️ Routed through `ctx.createTokens` rather than hand-building an instance,
  // which is what this used to do. THREE things were silently missing from the
  // hand-built object, and all three are properties of BEING a token rather than
  // of this particular card: CR 111.1's token-ness stamp (so the object never
  // ceased to exist when it left the battlefield — a phantom in a graveyard that
  // delirium and Tarmogoyf both count), the `tokenCreated` event every watcher
  // of "a token entered" reads, and now the CR 614 token-count replacement
  // (Doubling Season did not double it). One funnel, or the funnel is not one.
  ctx.createTokens({ id: `token:${name}`, name, types: ['creature'], power, toughness }, count);
};

// --- the bodies a DELAYED triggered ability runs (CR 603.7) --------------------
//
// "Sacrifice **it** at the beginning of the next end step" (Kiki-Jiki),
// "Exile **those tokens** at the beginning of the next end step" (Twinflame).
//
// The "it" is an object the compiler could not name: it did not exist when the
// card was compiled. So these two read their subject from `params.instanceIds`,
// which the primitive that CREATED the object baked in as it created the delayed
// ability (see `createTokenCopy`). That is why no field on the stack object, the
// resolution frame or the `EffectContext` names a delayed ability's subject —
// the body already carries it, in the one place that survives the stack push,
// the per-action clone and a serialize by construction.
//
// TWO primitives rather than one with a flag, because they are two outcomes and
// not two spellings: a sacrifice is a DEATH (dies-triggers see it, it lands in a
// graveyard), an exile is not. A permanent that has already gone is skipped —
// the delayed ability still resolved, it simply found nothing, which is exactly
// what the printed card does.

/**
 * `sacrificeNamed` — sacrifice each permanent named by `params.instanceIds`.
 * The delayed body behind "Sacrifice it at the beginning of the next end step".
 */
export const sacrificeNamed: EffectPrimitive = (ctx) => {
  for (const id of namedInstanceIds(ctx)) {
    const perm = permanentById(ctx.state, id);
    if (!perm) continue;
    if (isCreature(perm.def)) {
      ctx.emit({ type: 'creatureDied', instanceId: perm.instanceId, name: perm.def.name });
    } else if (isPlaneswalker(perm.def)) {
      ctx.emit({ type: 'planeswalkerDied', instanceId: perm.instanceId, name: perm.def.name });
    }
    movePermanentTo(ctx, perm, 'graveyard');
  }
};

/**
 * `exileNamed` — exile each permanent named by `params.instanceIds`. The delayed
 * body behind "Exile those tokens at the beginning of the next end step".
 */
export const exileNamed: EffectPrimitive = (ctx) => {
  for (const id of namedInstanceIds(ctx)) {
    const perm = permanentById(ctx.state, id);
    if (perm) movePermanentTo(ctx, perm, 'exile');
  }
};

/**
 * The instance ids a delayed body was created ABOUT, validated shallowly.
 *
 * A malformed param yields nothing rather than throwing (DESIGN §1.6 robust):
 * the ids are written by a primitive, never by hand-authored card data, so this
 * guards a future authoring mistake rather than a live branch.
 */
function namedInstanceIds(ctx: EffectContext): readonly InstanceId[] {
  const raw = ctx.params.instanceIds;
  if (!Array.isArray(raw)) return [];
  return raw.filter((id): id is InstanceId => typeof id === 'number' && Number.isFinite(id));
}

/**
 * `tapTarget` — tap the target permanent (used by tap-down effects; one mode of
 * Cryptic Command in spirit). No valid target → safe no-op.
 */
export const tapTarget: EffectPrimitive = (ctx) => {
  const target = firstPermanentTarget(ctx);
  if (!target || target.tapped) return;
  target.tapped = true;
  ctx.emit({ type: 'tapped', instanceId: target.instanceId });
};

/**
 * `untapTarget` — untap the target permanent. The mirror of {@link tapTarget},
 * and the body of every printed "Untap target …" line (Arbor Elf, Voltaic Key,
 * Kiora's Follower).
 *
 * WHICH permanents may be aimed at is NOT decided here: it is the ability's
 * `targets` restriction, so "untap target Forest" and "untap target creature"
 * are the same primitive with different data — and a noun the restriction
 * vocabulary cannot say reports at compile time rather than being widened here.
 * An already-untapped or illegal target is a safe no-op, exactly as tapping is.
 */
export const untapTarget: EffectPrimitive = (ctx) => {
  const target = firstPermanentTarget(ctx);
  if (!target || !target.tapped) return;
  target.tapped = false;
  ctx.emit({ type: 'untapped', instanceId: target.instanceId, player: target.controller });
};

/**
 * §3.150 — `freezeTarget`: the target permanent "doesn't untap during its
 * controller's NEXT untap step" (Frost Trickster, Tamiyo's +1), or its next
 * `count` untap steps (Telekinesis prints two).
 *
 * Its own primitive rather than a rider on {@link tapTarget}, because the two
 * are printed independently and really are independent: "Tap target creature. It
 * doesn't untap…" taps AND freezes, while Skyline Cascade's "target creature an
 * opponent controls doesn't untap during its controller's next untap step" only
 * freezes — and a creature that was already tapped is frozen just the same. A
 * rider would have made the freeze conditional on the tap succeeding, which is
 * not what any of these cards say.
 *
 * An ALREADY-TAPPED or already-frozen target is not a no-op the way tapping is:
 * skips ACCUMULATE (see `addUntapSkips`). No valid target → safe no-op.
 */
export const freezeTarget: EffectPrimitive = (ctx) => {
  const target = firstPermanentTarget(ctx);
  if (!target) return;
  const raw = ctx.params.count;
  addUntapSkips(target, typeof raw === 'number' && Number.isFinite(raw) ? raw : 1);
};

/**
 * `untapSelf` — untap the ability's own source ("{1}: Untap Morphling").
 *
 * Its own primitive rather than `untapTarget` with a self-target: the printed
 * line names no target at all, so it cannot fizzle and it is not subject to
 * hexproof/shroud/protection. Routing it through the targeted primitive would
 * have given it a targeting gate the printed ability does not have.
 */
export const untapSelf: EffectPrimitive = (ctx) => {
  const source = permanentById(ctx.state, ctx.source.instanceId);
  if (!source || !source.tapped) return;
  source.tapped = false;
  ctx.emit({ type: 'untapped', instanceId: source.instanceId, player: source.controller });
};

// --- shared internals ----------------------------------------------------------

/**
 * A copy of `def` with every triggered ability whose effects invoke `persistReturn`
 * removed — the returned persist body must not persist again. Other triggers (e.g.
 * an ETB lifegain) are preserved so they still fire on the return.
 */
function stripPersistTriggers(def: CardDefinition): CardDefinition {
  const triggers = def.triggers;
  if (!triggers || triggers.length === 0) return def;
  const kept = triggers.filter((t: TriggeredAbility) => !abilityHasPersist(t));
  if (kept.length === triggers.length) return def;
  return { ...def, triggers: kept };
}

/** Whether a triggered ability's effects include the persist-return primitive. */
function abilityHasPersist(ability: TriggeredAbility): boolean {
  return ability.effects.some((e) => e.primitive === PERSIST_RETURN_PRIMITIVE);
}

/** The stable id under which `persistReturn` registers (also referenced by data). */
const PERSIST_RETURN_PRIMITIVE = 'persistReturn';

/** Whether `target` passes this destroy/removal's optional filter params. */
function passesDestroyFilter(ctx: EffectContext, target: CardInstance): boolean {
  const notColor = strParam(ctx, 'notColor');
  if (notColor) {
    // Asked through core's ONE colour reader, never off the cost record here.
    // This used to walk `def.cost` directly, and that second opinion about what
    // "black" means was wrong twice over: it could not see a HYBRID pip, and it
    // could not see a printed colour with no cost behind it - so Doom Blade
    // happily destroyed a "1/1 black Faerie Rogue creature token", which the
    // printed card cannot target at all.
    if (colorsOfDefinition(target.def).includes(notColor as ManaColor)) return false;
  }
  const maxMv = maxManaValueBound(ctx);
  if (maxMv !== undefined && manaValueOf(target.def) > maxMv) return false;
  return true;
}

/**
 * The mana-value ceiling this removal enforces, or `undefined` for none.
 *
 * Two authored shapes: a plain number, and the revolt switch
 * `{ base, revolt }`. The switch is read here rather than at cast time because
 * that is when the printed card reads it — a permanent that leaves the
 * battlefield in RESPONSE to Fatal Push turns revolt on before it resolves, and
 * a cast-time read would miss exactly that line of play.
 */
function maxManaValueBound(ctx: EffectContext): number | undefined {
  const raw = ctx.params.maxManaValue;
  if (typeof raw === 'number') return raw;
  if (typeof raw !== 'object' || raw === null) return undefined;
  const bounds = raw as { readonly base?: unknown; readonly revolt?: unknown };
  if (typeof bounds.base !== 'number') return undefined;
  const revolted =
    typeof bounds.revolt === 'number' &&
    turnFactHolds(ctx.state, 'permanentLeftBattlefield', ctx.controller);
  return revolted ? (bounds.revolt as number) : bounds.base;
}

/**
 * "Target player mills N cards" — move the top N of a library to its graveyard.
 *
 * Milling is a real clock (a decked player loses), so this moves cards through
 * the same owned-zone path a draw does rather than deleting them: a milled card
 * is in the graveyard, where graveyard effects can still see it.
 *
 * Params: `amount` (cards to mill), `self` (mill the controller instead of a
 * target — the self-mill template).
 */
export const mill: EffectPrimitive = (ctx) => {
  const amount = intParam(ctx, 'amount', 0);
  if (amount <= 0) return;
  const who = boolParam(ctx, 'self', false)
    ? ctx.controller
    : (firstPlayerTarget(ctx) ?? otherPlayer(ctx.controller));
  // §3.113 — through the one mill funnel `millThenReturn` also uses.
  millTopCards(ctx, who, amount);
};

/**
 * "~ fights target creature" — each deals damage equal to its power to the other,
 * simultaneously.
 *
 * Simultaneity matters: a fight where the first death cancelled the second
 * creature's damage would let a 3/3 kill a 4/4 and survive. Both damage amounts
 * are read BEFORE either is applied, so a mutual kill kills both — which is what
 * the printed card does.
 */
export const fight: EffectPrimitive = (ctx) => {
  const self = selfIfCreature(ctx);
  const other = firstPermanentTarget(ctx);
  if (!self || !other || !isCreature(other.def)) return;
  if (self.instanceId === other.instanceId) return; // a creature cannot fight itself

  // Aggregates, not bare reads — a fight between a Tarmogoyf and anything must
  // use its layer-7a size, and an anthem'd creature must fight at its real one.
  const selfPower = effectivePower(self, aggregateFor(ctx.state, self.instanceId));
  const otherPower = effectivePower(other, aggregateFor(ctx.state, other.instanceId));

  // Protection prevents the damage a protected fighter would take, in either
  // direction, without stopping the other half of the fight (CR 702.16e). It is
  // asked BEFORE the replacement layer for the reason `internal/combat.ts` gives
  // at the same seam: it is an absolute prevention, so nothing a replacement
  // could do changes the outcome, and asking first means a prevention SHIELD is
  // not spent on damage that was never going to land.
  const replacements = indexReplacements(ctx.state);
  // The CR 120.3 result funnel (§3.105) decides what each half's damage DOES —
  // marked damage, or -1/-1 counters from an infect/wither fighter, plus
  // deathtouch and lifelink, which CR 702.2b/702.15b apply to any damage.
  const index = indexContinuous(ctx.state);
  const emit = ctx.emit;
  if (otherPower > 0) {
    if (protectionPreventsDamage(ctx.state, self, other.def)) {
      ctx.emit({
        type: 'damagePrevented',
        source: other.instanceId,
        target: self.instanceId,
        amount: otherPower,
        combat: false,
      });
    } else {
      const dealt = damageAfterReplacement(ctx, replacements, emit, other, self, self.controller, otherPower);
      applyDamageResult(ctx.state, other, self, dealt, false, index, emit);
    }
  }
  if (selfPower > 0) {
    if (protectionPreventsDamage(ctx.state, other, self.def)) {
      ctx.emit({
        type: 'damagePrevented',
        source: self.instanceId,
        target: other.instanceId,
        amount: selfPower,
        combat: false,
      });
    } else {
      const dealt = damageAfterReplacement(ctx, replacements, emit, self, other, other.controller, selfPower);
      applyDamageResult(ctx.state, self, other, dealt, false, index, emit);
    }
  }
  // Death is the engine's state-based check, exactly as with combat damage.
};

/**
 * Damage split across a whole group at once — "deals N damage to each creature",
 * "to each opponent", "to each creature and each player".
 *
 * One primitive rather than three because the printed templates differ only in
 * WHO is hit, and that is data: `creatures` and `opponents`/`players` flags.
 */
export const dealDamageToEach: EffectPrimitive = (ctx) => {
  const amount = intParam(ctx, 'amount', 0);
  if (amount <= 0) return;

  // ONE index for the whole sweep: every hit in it is dealt simultaneously, so
  // an effect that was live when the sweeper resolved is live for all of them —
  // the same argument `assignAndDealCombatDamage` makes for a damage step.
  const replacements = indexReplacements(ctx.state);
  const emit = ctx.emit;
  // ONE continuous index for the sweep too, for the result funnel's keyword read.
  const index = indexContinuous(ctx.state);

  if (boolParam(ctx, 'creatures', false)) {
    // Snapshot first: damage is dealt simultaneously, so a creature dying to it
    // must not change who else gets hit.
    for (const creature of [...ctx.state.battlefield].filter((c) => isCreature(c.def))) {
      // An untargeted sweep is still DAMAGE FROM THIS SOURCE, so protection's
      // "can't be dealt damage" half prevents it per creature (CR 702.16e).
      if (protectionPreventsDamage(ctx.state, creature, ctx.source.def)) {
        ctx.emit({
          type: 'damagePrevented',
          source: ctx.source.instanceId,
          target: creature.instanceId,
          amount,
          combat: false,
        });
        continue;
      }
      const dealt = damageAfterReplacement(
        ctx,
        replacements,
        emit,
        ctx.source,
        creature,
        creature.controller,
        amount,
      );
      applyDamageResult(ctx.state, ctx.source, creature, dealt, false, index, emit);
    }
  }

  const hitOpponents = boolParam(ctx, 'opponents', false);
  const hitEveryPlayer = boolParam(ctx, 'players', false);
  if (hitOpponents || hitEveryPlayer) {
    const victims: PlayerId[] = hitEveryPlayer
      ? [ctx.controller, otherPlayer(ctx.controller)]
      : [otherPlayer(ctx.controller)];
    for (const victim of victims) {
      const dealt = damageAfterReplacement(ctx, replacements, emit, ctx.source, undefined, victim, amount);
      // Through the one result funnel (§3.105), which also closes the log gap
      // this half used to carry: its player damage now emits `damageDealt` like
      // every other damage site, so a "deals damage to a player" trigger sees it.
      applyDamageResult(ctx.state, ctx.source, victim, dealt, false, index, emit);
    }
  }
};

/**
 * Whose creatures a group counter effect reaches when the printed text does not
 * say. Every printed "put a counter on each creature …" template this compiler
 * accepts either says "you control" or names a scope explicitly, so the default
 * is the common one and is stated here rather than as a bare string literal.
 */
const COUNTER_SCOPE_DEFAULT = 'you';

/**
 * "Put N +1/+1 counters on target creature" — a PERMANENT stat change, unlike
 * `pumpUntilEndOfTurn`, which wears off at cleanup.
 *
 * Restricted to +1/+1 (and its negative, -1/-1) on purpose. Those are the two
 * the stat layer genuinely reads, so they really change power and toughness. A
 * charge or loyalty counter would be *stored* and read by nothing, producing a
 * card that looks implemented and does nothing — so those keep reporting as
 * unsupported instead.
 *
 * Params: `amount` (may be negative for -1/-1), `self` (counter the source
 * rather than a target — the "enters with counters on it" template), and the
 * group form `each` + `scope` + `filter` ("put a +1/+1 counter on each creature
 * you control"), which counts every matching creature instead of one target.
 */
/**
 * `exileGraveyard` — the graveyard-hate family: "exile target player's
 * graveyard" (Bojuka Bog, Tormod's Crypt, Boggart Trawler, Rakdos Charm's
 * mode) and "exile all graveyards" (Scavenger Grounds, Rest in Peace's entry).
 *
 * WHOSE graveyards is the only thing that varies, so it is read from the shared
 * {@link playersForParam} vocabulary rather than a second one: `'targetPlayer'`
 * is the printed "target player's", `'each'` is "all graveyards", `'opponent'`
 * is "each opponent's". A card that prints a new scope is a param value, not a
 * new primitive.
 *
 * Every card leaves through `moveOwnedCard` — the one graveyard→exile funnel —
 * so a card exiled this way emits its `zoneChange` and is seen by everything
 * that watches zone changes, exactly like any other exile.
 *
 * Iterated over a SNAPSHOT of each graveyard: the funnel splices the list it is
 * reading, and walking a list while removing from it is how half a graveyard
 * silently survives.
 */
export const exileGraveyard: EffectPrimitive = (ctx) => {
  for (const player of playersForParam(ctx, strParam(ctx, 'whichPlayer'))) {
    const ids = ctx.state.players[player].graveyard.map((card) => card.instanceId);
    for (const id of ids) moveOwnedCard(ctx, player, id, 'graveyard', 'exile');
  }
};

/**
 * §3.149 — `exileTargetCardFromGraveyard`: "**Exile target card from a
 * graveyard**" (62 cards print it), with the optional printed rider "**If it
 * was a creature card, …**" (6 more).
 *
 * The rider is the whole reason this is one primitive rather than two chained
 * effects. "If it **was**" is past tense on purpose: by the time the condition
 * is asked the card is already in exile, and CR 608.2 resolves the sentence in
 * printed order — so the type has to be read BEFORE the move and remembered.
 * Splitting it into "exile" then "if the target was a creature" would ask the
 * question of a card that has already left, which is the shape of a rule that
 * quietly never fires.
 *
 * Params:
 *  - `ifWasType`    — the printed card type the rider tests ('creature'). Absent
 *                     ⇒ no rider, and the plain exile is the whole effect.
 *  - `effects`      — what the rider runs, as ordinary refs compiled by the
 *                     ordinary effect rules, so the rider can only ever do
 *                     things the engine already implements.
 *
 * A target that has left the graveyard between announcement and resolution
 * exiles nothing AND runs no rider — the card fizzles as CR 608.2b says, rather
 * than paying out for a card it never exiled.
 */
export const exileTargetCardFromGraveyard: EffectPrimitive = (ctx) => {
  const card = firstTargetInstance(ctx);
  if (!card) return;
  // Which graveyard it is actually in right now — the owner's, which is the
  // only zone `moveOwnedCard` can splice it out of.
  const owner = PLAYER_IDS.find((player) =>
    ctx.state.players[player].graveyard.some((c) => c.instanceId === card.instanceId),
  );
  if (owner === undefined) return;
  // Read the type BEFORE the move; see the doc comment.
  const wasType = strParam(ctx, 'ifWasType');
  const matched = wasType !== undefined && hasType(card.def, wasType as CardType);
  const moved = moveOwnedCard(ctx, owner, card.instanceId, 'graveyard', 'exile');
  if (!moved) return;
  if (!matched) return;
  const refs = nestedEffectRefs(ctx);
  if (refs.length > 0) ctx.enqueueEffects(refs);
};

/**
 * `regenerate` — CR 701.15: "The next time this permanent would be destroyed
 * this turn, instead tap it, remove it from combat, and remove all damage from
 * it." ("{B}: Regenerate this creature", "{1}{G}: Regenerate ~".)
 *
 * The ability puts a SHIELD up; the shield is spent by whatever tries to
 * destroy the permanent later, wherever that destruction comes from — which is
 * why the replacement itself lives in core beside the death checks
 * (`consumeRegenerationShield`) and this primitive only raises the shield.
 *
 * Shields STACK, because the printed ability can be activated more than once:
 * two activations survive two destructions, which is exactly how a regenerator
 * blocks and survives a wrath in the same turn.
 *
 * Targets the SOURCE unless the ref names a target (a few cards regenerate
 * something else), and a permanent that has already left is a safe no-op.
 */
export const regenerate: EffectPrimitive = (ctx) => {
  const target = firstPermanentTarget(ctx) ?? ctx.state.battlefield.find((c) => c.instanceId === ctx.source.instanceId);
  if (!target) return;
  target.regenerationShields = (target.regenerationShields ?? 0) + 1;
  ctx.emit({ type: 'effectApplied', primitive: 'regenerate', sourceInstanceId: ctx.source.instanceId });
};

/**
 * `proliferate` — CR 701.34a: "choose any number of permanents and/or players
 * that have a counter, then give each one additional counter of each kind that
 * permanent or player already has."
 *
 * Two questions, because the printed word covers two kinds of thing and the
 * choice seam asks about one kind at a time: the permanents with counters, then
 * the players with POISON — the one counter a player carries in this engine
 * (§3.105; energy and experience still report). Both are asked BEFORE anything
 * is written, which is the choice seam's contract ("ask everything first, then
 * mutate"): a parked second question re-runs the primitive from the top, and
 * a counter added before it would be added twice. A question with no candidate
 * is not asked at all, so a board with no poisoned player asks exactly what it
 * asked before players could carry counters.
 *
 * Each added counter goes through {@link addCountersOfKind} — the one CR 614
 * counter site — so a Hardened Scales scales a proliferated +1/+1 exactly as
 * it scales a placed one; each poison counter goes through core's one poison
 * writer, so the `poisonChanged` log is complete.
 */
export const proliferate: EffectPrimitive = (ctx) => {
  const candidates = ctx.state.battlefield.filter((permanent) =>
    Object.values(permanent.counters).some((count) => count > 0),
  );
  const poisoned = PLAYER_IDS.filter((player) => isPoisoned(ctx.state.players[player]));
  if (candidates.length === 0 && poisoned.length === 0) return;
  const chosen =
    candidates.length === 0
      ? []
      : ctx.chooseCards({
          chooser: ctx.controller,
          prompt: 'Proliferate: choose any number of permanents with counters',
          candidates: candidates.map((permanent) => ({
            instanceId: permanent.instanceId,
            cardId: permanent.def.id,
            name: permanent.def.name,
            zone: 'battlefield' as const,
            controller: permanent.controller,
          })),
          min: 0,
          max: candidates.length,
          // "Any number" cuts both ways — your +1/+1s grow, their -1/-1s deepen —
          // and the pilot's card scoring is what sorts good picks from bad; the
          // valence only steers a pilot with no opinion.
          valence: 'gain',
          fromZone: 'battlefield',
        });
  if (!chosen) return; // parked
  const chosenPlayers =
    poisoned.length === 0
      ? []
      : ctx.choosePlayers({
          chooser: ctx.controller,
          prompt: 'Proliferate: choose any number of players with poison counters',
          candidates: poisoned,
          min: 0,
          max: poisoned.length,
          // Being chosen is BAD for the chosen player — one step closer to
          // CR 704.5c — so the steer is the "point it at the opponent" one.
          valence: 'loss',
        });
  if (!chosenPlayers) return; // parked
  for (const id of chosen) {
    const permanent = ctx.state.battlefield.find((c) => c.instanceId === id);
    if (!permanent) continue;
    // Snapshot the kinds BEFORE adding: the counter this step adds must not
    // count itself (CR 701.34a reads the state as proliferate resolves).
    const kinds = Object.entries(permanent.counters)
      .filter(([, count]) => count > 0)
      .map(([kind]) => kind);
    for (const kind of kinds) addCountersOfKind(ctx, permanent, kind, 1);
  }
  for (const player of chosenPlayers) addPoisonCounters(ctx.state, player, 1, ctx.emit);
};

export const addCounters: EffectPrimitive = (ctx) => {
  const amount = intParam(ctx, 'amount', 0);
  if (amount === 0) return;

  // A NAMED counter kind — "put a charge counter on ~", "put a quest counter on
  // ~" (§3.149). The kind rides as a param rather than as a second primitive
  // because the game action is identical: `addCountersOfKind` is already the one
  // CR 614 site and already takes the kind, which is how proliferate scales a
  // charge counter. Only two things differ from the +1/+1 path, and both follow
  // from what the kind MEANS:
  //   - the sign is not a kind selector (a named counter is never negative), so
  //     the amount is used as printed;
  //   - the target need not be a CREATURE. Charge counters go on artifacts,
  //     storage counters on lands, quest counters on enchantments; the
  //     creature gate below exists only because a +1/+1 counter on a
  //     non-creature changes nothing, which is not true of these.
  const kind = strParam(ctx, 'kind');
  if (kind !== undefined) {
    if (boolParam(ctx, 'each', false)) {
      for (const permanent of eachCounterTarget(ctx)) addCountersOfKind(ctx, permanent, kind, amount);
      return;
    }
    const named = boolParam(ctx, 'self', false)
      ? enteringOrResidentSelfPermanent(ctx)
      : (firstPermanentTarget(ctx) ?? enteringOrResidentSelfPermanent(ctx));
    if (!named) return;
    addCountersOfKind(ctx, named, kind, amount);
    return;
  }

  // The GROUP form — "put a +1/+1 counter on **each** creature you control".
  // One primitive rather than a second one because the printed templates differ
  // only in WHICH creatures are counted, and that is data: a controller scope
  // plus the shared `CardFilter` the statics layer already speaks.
  if (boolParam(ctx, 'each', false)) {
    for (const permanent of eachCounterTarget(ctx)) putCountersOn(ctx, permanent, amount);
    return;
  }

  const target = boolParam(ctx, 'self', false)
    ? enteringOrResidentSelf(ctx)
    : (firstPermanentTarget(ctx) ?? enteringOrResidentSelf(ctx));
  if (!target || !isCreature(target.def)) return;
  putCountersOn(ctx, target, amount);
};

/**
 * The source as a counter target — the permanent on the battlefield if it is
 * already there, otherwise the card CURRENTLY RESOLVING into play.
 *
 * The second half is what makes "~ enters with N +1/+1 counters on it" real. It
 * is a replacement effect (CR 614.1c): the counters are put on as the permanent
 * enters, which in this engine means while its own spell is resolving and before
 * `finishSpellResolution` pushes that very instance onto the battlefield. Reading
 * only the battlefield found nothing at that moment, so every "enters with
 * counters" card compiled `'complete'` and then entered with none — a 0/0 body
 * (Stonecoil Serpent, Walking Ballista) died to a state-based action on arrival.
 */
function enteringOrResidentSelf(ctx: EffectContext): CardInstance | undefined {
  const resident = selfIfCreature(ctx);
  if (resident) return resident;
  const source = ctx.source;
  return isCreature(source.def) ? source : undefined;
}

/**
 * {@link enteringOrResidentSelf} without the creature test — the source as ANY
 * permanent, for the named-counter kinds (§3.149).
 *
 * The same two-step for the same reason: "~ enters with three charge counters on
 * it" (Trigon of Corruption, Blast Zone) is CR 614.1c and resolves while the
 * permanent's own spell is still resolving, so the battlefield lookup finds
 * nothing and the resolving instance is the right answer. Written as a sibling
 * rather than a `creatureOnly` flag on the original so neither caller can pass
 * the wrong one by leaving an argument off.
 */
function enteringOrResidentSelfPermanent(ctx: EffectContext): CardInstance | undefined {
  return permanentById(ctx.state, ctx.source.instanceId) ?? ctx.source;
}

/**
 * The creatures a group counter effect ("each creature you control", "each
 * artifact creature you control", "each Vampire you control") reaches.
 *
 * Snapshotted into a list before any counter is put on, for the same reason
 * `dealDamageToEach` snapshots: the counters go on simultaneously, so a creature
 * that dies to a -1/-1 counter must not change who else is counted.
 *
 * `scope` is the controller relation ('you' — the default — / 'opponent' /
 * 'any'), and `filter` is the shared {@link CardFilter} vocabulary, so a
 * qualifier the compiler cannot express in that vocabulary is never emitted at
 * all rather than being silently widened to "every creature".
 */
function eachCounterTarget(ctx: EffectContext): CardInstance[] {
  const scope = strParam(ctx, 'scope') ?? COUNTER_SCOPE_DEFAULT;
  const filter = ctx.params.filter as CardFilter | undefined;
  const chosen: CardInstance[] = [];
  for (const permanent of ctx.state.battlefield) {
    if (!isCreature(permanent.def)) continue;
    if (scope === 'you' && permanent.controller !== ctx.controller) continue;
    if (scope === 'opponent' && permanent.controller === ctx.controller) continue;
    if (filter && !matchesCardFilter(permanent, filter)) continue;
    chosen.push(permanent);
  }
  return chosen;
}

/**
 * Put `amount` +1/+1 counters (or, when negative, that many -1/-1 counters) on
 * one permanent.
 *
 * Factored out of {@link addCounters} so the single-target and the "each
 * creature" forms cannot drift apart.
 *
 * ⚠️ It does NOT annihilate +1/+1 against -1/-1 any more. That is CR 704.5q, a
 * STATE-BASED ACTION, and it now lives where the other state-based actions do
 * (`internal/sba.ts`'s `annihilateCounters`) — so every route a counter can
 * arrive by gets it, not just this one. Doing it here as well would be a second
 * implementation of one rule; doing it ONLY here is what left persist's returning
 * creature, and any future counter producer, outside the rule.
 */
function putCountersOn(ctx: EffectContext, target: CardInstance, amount: number): void {
  // A negative amount is a -1/-1 counter, stored as its own kind rather than as
  // a negative +1/+1. The arithmetic is the same either way; the difference is
  // that the counters now genuinely EXIST as the card says they do, so state can
  // be inspected ("does it have a -1/-1 counter?") and the two kinds annihilate.
  const kind = amount < 0 ? MINUS_ONE_COUNTER : PLUS_ONE_COUNTER;
  addCountersOfKind(ctx, target, kind, Math.abs(amount));
}

/**
 * Put `amount` counters of an ARBITRARY kind on a permanent, through the one
 * CR 614 counter site (`replaceCounters`) and the one `counterAdded` event.
 * Split out of {@link putCountersOn} so proliferate can add a charge, night or
 * loyalty counter through exactly the funnel a +1/+1 uses — a second write
 * site is how a Hardened Scales stops applying to one of them.
 */
function addCountersOfKind(ctx: EffectContext, target: CardInstance, kind: string, amount: number): void {
  // THE REPLACEMENT LAYER (CR 614) — "that many PLUS ONE are put on it instead"
  // (Hardened Scales), "TWICE that many" (Corpsejack Menace). This is the ONE
  // counter site in the engine, which is what makes those cards apply to a spell,
  // to a triggered ability and to "~ enters with N +1/+1 counters on it" alike:
  // CR 614.1c puts those on as the permanent enters, and they come through here.
  // The KIND is passed, so a `+1/+1` doubler correctly ignores a `-1/-1` counter.
  const magnitude = replaceCounters(
    ctx.state,
    indexReplacements(ctx.state),
    ctx.source,
    target,
    kind,
    amount,
    ctx.emit,
  );
  if (magnitude <= 0) return;
  // REPLACE the record, never write into it — `CardInstance.counters` is shared
  // and FROZEN while a permanent has no counters (`NO_COUNTERS`), so an in-place
  // write threw "object is not extensible" for the very first counter put on any
  // permanent that entered the battlefield through the normal cast path. Only
  // hand-built test instances (which carry their own `{}`) survived it, which is
  // why a suite full of counter tests never saw it: the pool had no card that
  // put a counter on a permanent the ENGINE created.
  target.counters = {
    ...target.counters,
    [kind]: (target.counters[kind] ?? 0) + magnitude,
  };
  ctx.emit({ type: 'counterAdded', instanceId: target.instanceId, kind, amount: magnitude });
};

/**
 * Whether this permanent shrugs off an effect that says **destroy** (CR 702.12b).
 *
 * Asked through the continuous layer rather than off `def.keywords`, so a GRANTED
 * indestructible — an until-end-of-turn "creatures you control gain
 * indestructible", an anthem-style static — saves the permanent exactly as a
 * printed one does. Reading the printed set here is the bug that makes a
 * fog-the-wrath trick do nothing.
 */
function isIndestructible(ctx: EffectContext, permanent: CardInstance): boolean {
  return Boolean(
    effectiveKeywords(permanent, aggregateFor(ctx.state, permanent.instanceId)).indestructible,
  );
}

/**
 * Destroy a permanent: move it to its owner's graveyard.
 *
 * An INDESTRUCTIBLE permanent is not destroyed and nothing else happens to it —
 * no zone change, and no `creatureDied`, because it did not die. This is the one
 * place every printed "destroy" in the pool passes through (single target, board
 * wipe, and the destroy modes of modal spells alike), which is why the exemption
 * lives here and not in each caller.
 *
 * Note what this does NOT cover, deliberately: SACRIFICE is a cost rather than
 * destruction and goes through `sacrificePermanent` untouched, exile moves the
 * permanent by a different path, and lethal damage is a state-based action
 * (`internal/sba.ts`) rather than an effect.
 *
 * `creatureDied` is emitted only for an actual creature — it is what death
 * triggers key off, and firing it for a destroyed artifact would make a "when a
 * creature dies" ability trigger on something that never was one.
 */
function destroyPermanent(ctx: EffectContext, permanent: CardInstance): void {
  if (isIndestructible(ctx, permanent)) return;
  // CR 701.15 — a regeneration shield REPLACES this destruction (tap, remove
  // from combat, clear damage) and is spent. Core's one helper, so a shield
  // covers a targeted Murder exactly as it covers a state-based death.
  if (consumeRegenerationShield(ctx.state, permanent, ctx.emit)) return;
  // §3.110 — the death event goes out BEFORE the zone move, as the other two
  // death funnels (`internal/sba.ts`, `sacrificePermanent`) already do. The
  // order is load-bearing: a `dies` trigger that reads how many counters the
  // creature HAD (undying, modular — CR 603.10a last-known information) takes
  // its snapshot as this event is emitted, and `movePermanentTo` wipes the
  // counters. Three funnels, one ordering — a Murdered Young Wolf must read
  // its counters exactly as a Young Wolf that died in combat does.
  if (isCreature(permanent.def)) {
    ctx.emit({ type: 'creatureDied', instanceId: permanent.instanceId, name: permanent.def.name });
  }
  movePermanentTo(ctx, permanent, 'graveyard');
}

/**
 * Attach the SOURCE to the permanent it targets — the one primitive that BOTH
 * printed attachment forms are built from:
 *
 *   - an **Aura** carries it as its whole spell script, so "Enchant creature"
 *     compiles to a spell that targets a creature and, on resolution, enters the
 *     battlefield already attached to it (CR 303.4f);
 *   - an **Equipment** carries it inside an activated ability, which is exactly
 *     what "Equip {2}" abbreviates ("{2}: Attach to target creature you control.
 *     Activate only as a sorcery.").
 *
 * There is nothing aura- or equipment-specific in here, and deliberately so: what
 * the attachment then DOES to its host, and what happens when the attachment stops
 * being legal, are declared as data on the card (`CardDefinition.attachment`) and
 * handled by core's layering pass and state-based actions.
 *
 * Robustness: a target that is gone, or that the card may not legally be attached
 * to, leaves the board untouched and logs `attachmentFailed` via `ctx.attach`. For
 * an Aura that is exactly right — it then enters attached to nothing and the SBA
 * puts it in the graveyard, which is the same end state as the printed rule
 * (the spell is countered on resolution for having no legal target).
 *
 * Params: `targets` (the reserved target restriction — `'creature'` for an Aura's
 * "Enchant creature", `'creatureYouControl'` for an Equip ability).
 */
export const attachToTarget: EffectPrimitive = (ctx) => {
  const target = firstPermanentTarget(ctx);
  if (!target) return;
  if (!isLegalTarget(ctx.state, restrictionParam(ctx), target.instanceId, ctx.controller, ctx.source.def)) return;
  ctx.attach(target.instanceId);
};

// --- the canonical primitive id registry ---------------------------------------

/**
 * Every primitive keyed by its stable id (the `EffectRef.primitive` value cards
 * reference) — the primitives above plus the choice-driven half from
 * `./choice-primitives`. Adding a primitive = adding one entry to one of those two
 * maps + the data that uses it; there is still exactly ONE registry to register.
 */
/**
 * "Gain control of target creature until end of turn" — the Act of Treason /
 * Threaten template.
 *
 * The control change itself belongs to core: it is registered through the
 * continuous layer so it reverts at end of turn, and reverts SAFELY if the
 * creature dies, is exiled, or someone else takes it first. This primitive only
 * decides what gets stolen and applies the two riders the printed cards carry.
 *
 * `untap` and `haste` are not decoration. A creature that just changed hands is
 * summoning-sick for its new controller, so without haste it cannot attack —
 * which is exactly why every card of this kind prints "Untap it. It gains haste."
 * Omitting them would make the card look like it worked while doing nothing.
 */
export const gainControl: EffectPrimitive = (ctx) => {
  const target = firstPermanentTarget(ctx);
  if (!target || !isCreature(target.def)) return;

  ctx.addContinuousEffect({
    target: target.instanceId,
    duration: 'endOfTurn',
    takeControl: true,
    ...(boolParam(ctx, 'haste', false) ? { keywords: { haste: true } } : {}),
  });

  if (boolParam(ctx, 'untap', false) && target.tapped) {
    target.tapped = false;
    ctx.emit({ type: 'untapped', instanceId: target.instanceId, player: target.controller });
  }
};

/**
 * "If this spell was kicked, [effects]" — the branch half of kicker. Reads the
 * cast-time kicked flag off the resolution (`EffectContext.kicked`, charged and
 * recorded by the ENGINE when the spell was cast) and, when true, enqueues the
 * nested effects into THIS resolution — so they run in printed order, may ask
 * their own questions, and read the same targets and X the spell was cast with.
 *
 * Params: `effects` — the effect refs of the kicked clause. Malformed or absent
 * refs are a safe no-op (the unkicked outcome, never a stronger card).
 */
export const ifKicked: EffectPrimitive = (ctx) => {
  if (ctx.kicked !== true) return;
  const refs = nestedEffectRefs(ctx);
  if (refs.length > 0) ctx.enqueueEffects(refs);
};

/**
 * The `effects` param of a wrapper primitive, filtered down to well-formed refs.
 *
 * Shared by {@link ifKicked} and {@link mayEffects}: both carry a nested clause
 * in their params, and both must treat a malformed blob as "run nothing" rather
 * than throwing — a card whose data is wrong plays as the weaker card, never as
 * a crash and never as a stronger one.
 */
function nestedEffectRefs(ctx: EffectContext): readonly EffectRef[] {
  const raw = ctx.params.effects;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (entry): entry is EffectRef =>
      typeof entry === 'object' &&
      entry !== null &&
      typeof (entry as { primitive?: unknown }).primitive === 'string',
  );
}

/**
 * `mayCostEffects` — the printed shape **"You may <cost>. If you do,
 * <payoff>."** (Springbloom Druid, Formidable Speaker.)
 *
 * One wrapper, all-or-nothing: a YES pays the cost and takes the payoff, a NO
 * does neither — "If you do" means exactly "the may was taken", the same
 * reading Mask of Memory's test pins. What makes this a separate primitive
 * from `mayEffects` is the PAYABILITY gate: "you may sacrifice a land" with no
 * land is not an option in paper, and running the payoff after a cost that
 * silently no-opped would be a strictly better card than printed.
 *
 * The gate is a CLOSED check over the cost shapes the compiler emits
 * (`sacrificeChosen` — a matching permanent exists; `discardCard` — the hand
 * has a card). A cost ref outside that vocabulary makes the whole thing a safe
 * no-op: the card plays as its weaker half, never its stronger one.
 *
 * Params: `cost` (the cost clause's refs), `effects` (the payoff), `prompt`.
 */
export const mayCostEffects: EffectPrimitive = (ctx) => {
  const cost = nestedEffectRefsIn(ctx, 'cost');
  const payoff = nestedEffectRefs(ctx);
  if (cost.length === 0 || payoff.length === 0) return;
  if (!costIsPayable(ctx, cost)) return;
  const yes = ctx.confirm({
    chooser: ctx.controller,
    prompt: strParam(ctx, 'prompt') ?? 'You may pay this cost',
    // Always a price: the printed sentence charges the controller something.
    valence: 'loss',
  });
  if (yes === undefined) return; // parked — nothing mutated
  if (!yes) return;
  ctx.enqueueEffects([...cost, ...payoff]);
};

/** Whether every cost ref could actually be paid RIGHT NOW — closed vocabulary. */
function costIsPayable(ctx: EffectContext, cost: readonly EffectRef[]): boolean {
  for (const ref of cost) {
    const filter = ref.params?.filter as CardFilter | undefined;
    if (ref.primitive === 'sacrificeChosen') {
      const hasCandidate = ctx.state.battlefield.some(
        (perm) => perm.controller === ctx.controller && matchesCardFilter(perm, filter),
      );
      if (!hasCandidate) return false;
    } else if (ref.primitive === 'discardCard') {
      if (ctx.state.players[ctx.controller].hand.length === 0) return false;
    } else {
      // An unknown cost shape cannot be checked — refuse the option entirely.
      return false;
    }
  }
  return true;
}

/**
 * `substituteIf` — the printed word **"instead"** on a board condition:
 * "Create a 1/1 green Insect creature token. If you control six or more lands,
 * create a token that's a copy of this creature **instead**." (Scute Swarm.)
 *
 * ONE wrapper carrying BOTH printed instructions, because "instead" is a
 * substitution, not an addition: exactly one branch runs, decided at RESOLUTION
 * (CR 608.2) — a seventh land played in response to the trigger upgrades the
 * Insect to a Swarm copy, exactly as in paper.
 *
 * The condition is core's own {@link InterveningIf} vocabulary evaluated by the
 * same `interveningIfHolds` a trigger's printed intervening "if" uses — one
 * reader, so "you control six or more lands" cannot mean two things. It is NOT
 * a trigger intervening "if" (CR 603.4), though: a false condition here still
 * runs the base branch; it never stops the ability.
 *
 * Params:
 *   - `condition` — the InterveningIf deciding which branch runs.
 *   - `effects`   — the "instead" branch, run when the condition HOLDS.
 *   - `otherwise` — the base printed instruction, run when it does not.
 *
 * A malformed condition runs the BASE branch — the card plays as its weaker
 * half, never its stronger one and never a crash.
 */
export const substituteIf: EffectPrimitive = (ctx) => {
  const condition = ctx.params.condition;
  const holds =
    condition !== null &&
    typeof condition === 'object' &&
    !Array.isArray(condition) &&
    interveningIfHolds(
      ctx.state,
      condition as Parameters<typeof interveningIfHolds>[1],
      ctx.source.instanceId,
      ctx.controller,
    );
  const refs = holds ? nestedEffectRefs(ctx) : nestedEffectRefsIn(ctx, 'otherwise');
  if (refs.length > 0) ctx.enqueueEffects(refs);
};

/** {@link nestedEffectRefs} for a wrapper param other than `effects`. */
function nestedEffectRefsIn(ctx: EffectContext, key: string): readonly EffectRef[] {
  const raw = ctx.params[key];
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (entry): entry is EffectRef =>
      typeof entry === 'object' &&
      entry !== null &&
      typeof (entry as { primitive?: unknown }).primitive === 'string',
  );
}

/**
 * `mayEffects` — the printed word **"you may"**, as one composable wrapper: ask
 * the controller yes/no, and run the nested clause only on a yes.
 *
 * This is what lets "When this creature enters, you may destroy target artifact
 * or enchantment" be the ETB trigger the rule table already knew plus one real
 * question, instead of a new primitive per optional card (DESIGN §1 —
 * composition over inheritance).
 *
 * **The choice is genuine, and that is the whole point.** Compiling a "you may"
 * as its yes-half would be a DIFFERENT card: Reclamation Sage that must blow up
 * your own artifact when nothing else is legal, Springbloom Druid that must
 * sacrifice a land. Both would silently bias every A/B verdict the lab reports,
 * which is exactly the failure the compiler contract exists to prevent. So the
 * question is parked like any other, both answers are legal, and the sim's
 * pilots answer it from `valence` the way they answer every other confirm.
 *
 * Params:
 *   - `effects` — the nested clause's refs. They run inside THIS resolution
 *     (`enqueueEffects`), so they see the same targets, the same `xValue`, and
 *     may park questions of their own.
 *   - `prompt` — what the player is asked; defaults to the printed-ish
 *     "You may…" so a card with no prompt is still answerable.
 *   - `valence` — the AI's steer, `'gain'` by default because an ETB "you may"
 *     is overwhelmingly an upside the controller wants. A clause that charges
 *     the controller something (sacrifice, discard, life) says `'loss'`. Valence
 *     never changes legality — both answers stand whatever it says.
 *
 * Ask-then-mutate: the confirm is the FIRST thing this does, so a parked
 * question re-runs it from the top with nothing to undo.
 */
export const mayEffects: EffectPrimitive = (ctx) => {
  const refs = nestedEffectRefs(ctx);
  // Nothing to offer is not a question: asking "may I do nothing?" would stop
  // the game for an answer that cannot matter.
  if (refs.length === 0) return;
  const valence = strParam(ctx, 'valence') === 'loss' ? 'loss' : 'gain';
  const yes = ctx.confirm({
    chooser: ctx.controller,
    prompt: strParam(ctx, 'prompt') ?? 'You may do this',
    valence,
  });
  if (yes === undefined) return; // parked — nothing mutated
  if (!yes) return; // declined, and declining is a real, complete outcome
  ctx.enqueueEffects(refs);
};

/**
 * `preventDamage` — the ONE-SHOT half of the prevention family: "Prevent all
 * combat damage that would be dealt this turn" (Fog, Darkness, Spore Frog's
 * sacrifice ability, Dawn Charm's first mode), "Prevent all damage that would be
 * dealt to you this turn" (Riot Control), "Prevent the next N damage that would
 * be dealt to target creature".
 *
 * It registers a FLOATING replacement effect (core's `addReplacementEffect`) and
 * mutates nothing else. The prevention itself happens in the one place every
 * damage site already asks — `internal/replacement.ts` — so a fog covers combat
 * damage, a Lightning Bolt, a sweeper and a fight through exactly one rule.
 *
 * The PRINTED prevention statics ("Prevent all combat damage that would be dealt
 * to attacking creatures you control" — Dolmen Gate) are NOT this primitive:
 * they are `CardDefinition.replacements` data, whose lifetime is derived from
 * the source being on the battlefield and needs no record at all.
 *
 * Params (each a printed word, none inferred):
 *   - `combat` — `true` for "all COMBAT damage", `false` for "all NONCOMBAT
 *     damage", omitted for a clause that prints neither.
 *   - `scope` — whose objects it guards, relative to the caster (`'you'` /
 *     `'opponent'` / `'any'`). Omitted ⇒ everyone's, which is what a fog says.
 *   - `recipientKind` — `'player'` for "…dealt to you", `'permanent'` for
 *     "…dealt to creatures you control". Omitted ⇒ either.
 *   - `attacking` — `true` for "…to ATTACKING creatures you control".
 *   - `amount` — a SHIELD ceiling ("prevent the next N damage"). Omitted ⇒ a
 *     blanket prevention with no ceiling.
 *   - `targeted` — bind the shield to `ctx.targets[0]`, the chosen creature or
 *     player. Without it the effect guards every object the rest of the filter
 *     admits.
 *   - `selfShield` — bind the shield to the ability's OWN SOURCE ("…dealt to ~
 *     this turn"). Distinct from `targeted`: the printed line names no target,
 *     so it neither aims nor fizzles.
 *   - `label` — the printed line, for the log.
 */
export const preventDamage: EffectPrimitive = (ctx) => {
  const shield = intParam(ctx, 'amount', 0);
  const scope = strParam(ctx, 'scope');
  const recipientKind = strParam(ctx, 'recipientKind');
  const targeted = boolParam(ctx, 'targeted', false);
  // "…that would be dealt to ~ this turn" (Rock Hydra, Opal-Eye) — the shield
  // guards the ability's OWN SOURCE and names no target, so it cannot fizzle.
  // A separate param from `targeted` because the two answer different printed
  // words, and collapsing them would give the self form a targeting gate (and a
  // fizzle) the printed line does not have.
  const selfShield = boolParam(ctx, 'selfShield', false);
  const target = selfShield ? ctx.source.instanceId : targeted ? ctx.targets[0] : undefined;
  // "prevent the next N damage that would be dealt to TARGET creature" with no
  // legal target left is a fizzle, not a blanket fog — refusing here is the
  // direction that can never play better than printed.
  if (targeted && target === undefined) return;
  const combat = ctx.params.combat;
  ctx.addReplacementEffect({
    event: 'damage',
    applies: {
      ...(typeof combat === 'boolean' ? { combat } : {}),
      ...(scope === 'you' || scope === 'opponent' || scope === 'any' ? { recipientController: scope } : {}),
      ...(recipientKind === 'player' || recipientKind === 'permanent' ? { recipientKind } : {}),
      ...(boolParam(ctx, 'attacking', false) ? { recipientAttacking: true } : {}),
      ...(target !== undefined ? { recipientIs: target } : {}),
    },
    outcome: shield > 0 ? { preventUpTo: shield } : { preventAll: true },
    ...(strParam(ctx, 'label') !== undefined ? { label: strParam(ctx, 'label') as string } : {}),
  });
};

/**
 * `grantFlashback` — "target instant or sorcery card in your graveyard gains
 * flashback until end of turn" (Snapcaster Mage).
 *
 * The grant lives in core's `card-grants.ts`, not in the continuous layer: the
 * card it modifies is not a permanent, so the layer that indexes the
 * battlefield has nowhere to put it. It is INSTANCE-SCOPED (this copy in this
 * graveyard, not "cards named X"), expires in cleanup like any until-end-of-turn
 * effect, and stops applying the instant the card changes zones (CR 400.7) —
 * all three enforced by the grant layer rather than restated here.
 *
 * Params:
 *   - `targets` — the {@link TargetRestriction} the printed line names
 *     (`'instantOrSorceryInYourGraveyard'`). Re-checked HERE at resolution, so
 *     a card that left the graveyard between the trigger going on the stack and
 *     its resolution makes the ability do nothing, exactly as it fizzles for
 *     every other targeted effect.
 *   - `cost` — the granted flashback cost: omitted (or `'itsManaCost'`) means
 *     the target's own printed mana cost, which is what Snapcaster prints; an
 *     explicit `ManaCost` object covers a card that names a fixed cost.
 *
 * A card with no printed mana cost is refused rather than granted a FREE
 * flashback — an unpriced recast is strictly better than any printed card, and
 * refusing is the direction that can never be.
 */
export const grantFlashback: EffectPrimitive = (ctx) => {
  const target = ctx.targets[0];
  if (target === undefined || isPlayerTarget(target)) return;
  // The same legality question the offer and the accept asked, asked once more
  // at resolution — the fizzle path (see the header).
  if (!isLegalTarget(ctx.state, restrictionParam(ctx), target, ctx.controller, ctx.source.def)) return;
  const card = ctx.state.players[ctx.controller].graveyard.find((c) => c.instanceId === target);
  if (!card) return;
  const declared = ctx.params.cost;
  const cost: ManaCost | undefined =
    declared !== undefined && declared !== ITS_MANA_COST && typeof declared === 'object' && declared !== null
      ? (declared as ManaCost)
      : card.def.cost;
  if (cost === undefined) return; // no printed price ⇒ no free recast (see above)
  addCardGrant(
    ctx.state,
    {
      targetInstanceId: card.instanceId,
      sourceInstanceId: ctx.source.instanceId,
      zone: card.zone,
      duration: 'endOfTurn',
      flashback: cost,
    },
    ctx.emit,
  );
};

/**
 * The `cost` param value meaning "equal to its mana cost" — the printed
 * Snapcaster wording. Named rather than written as a bare string at both the
 * primitive and the compiler rule that emits it.
 */
export const ITS_MANA_COST = 'itsManaCost';

export const CORE_PRIMITIVES: Readonly<Record<string, EffectPrimitive>> = Object.freeze({
  gainControl,
  ifKicked,
  mayEffects,
  mayCostEffects,
  substituteIf,
  dealDamage,
  drawCards,
  gainLife,
  winTheGame,
  loseTheGame,
  loseLife,
  pumpUntilEndOfTurn,
  grantKeywordUntilEndOfTurn,
  grantKeywordToYoursUntilEndOfTurn,
  createPredefinedToken,
  makeToken,
  livingWeaponGerm,
  createEmblem,
  persistReturn,
  destroyTarget,
  exileTarget,
  destroyAll,
  addMana,
  counterSpell,
  createToken,
  // The bodies a DELAYED triggered ability runs (CR 603.7) — see their comment
  // block for why the subject rides in their params rather than on the context.
  sacrificeNamed,
  exileNamed,
  tapTarget,
  untapTarget,
  untapSelf,
  // §3.150 — the does-not-untap family's ONE-SHOT half.
  freezeTarget,
  mill,
  fight,
  dealDamageToEach,
  preventDamage,
  addCounters,
  exileGraveyard,
  // §3.149 — "Exile target card from a graveyard[. If it was a creature card, …]"
  exileTargetCardFromGraveyard,
  regenerate,
  proliferate,
  attachToTarget,
  grantFlashback,
  ...CHOICE_PRIMITIVES,
  // The copy family (`./copy-primitives`): a copy of a spell on the stack and a
  // token copy of a permanent. Kept in their own module because both create an
  // object that is NOT A CARD, and both read what a copy IS from core's single
  // `copiableDefOf` answer rather than deciding it here.
  ...COPY_PRIMITIVES,
  // §3.106 — upkeep costs and time counters (`./upkeep-cost-primitives`): the
  // bodies of echo, cumulative upkeep, vanishing, fading, suspend's tick and
  // the "sacrifice ~ unless you pay" template.
  ...UPKEEP_COST_PRIMITIVES,
  // §3.112 — the cast-alternative family (`./cast-alternative-primitives`):
  // the delayed riders of dash ("return it to hand") and warp ("exile it, and
  // let its owner cast it later"). Evoke and blitz reuse `sacrificeSelf` and
  // `drawCards`.
  ...CAST_ALTERNATIVE_PRIMITIVES,
  // §3.111 — the graveyard-casting family's bodies.
  ...GRAVEYARD_CAST_PRIMITIVES,
  // §3.110 — the counter keyword family (`./counter-keyword-primitives`): the
  // bodies of undying, modular, renown, bloodthirst, riot, unleash, devour,
  // fabricate's Servos, amass, bolster, backup and explore.
  ...COUNTER_KEYWORD_PRIMITIVES,
  // "Exile until this leaves the battlefield" (`./exile-until-leaves`) — the
  // O-Ring pair. Its own module because the LINK between exiler and exiled is
  // the whole mechanic: two of these on the battlefield must each return their
  // own card, not each other's.
  ...EXILE_UNTIL_LEAVES_PRIMITIVES,
  // Copying a TRIGGERED ABILITY (`./trigger-copy-primitives`) — the other kind of
  // stack object. Separate from the spell copier because the two share no field
  // beyond an id and a controller: a trigger has no card, no face and no cast.
  ...TRIGGER_COPY_PRIMITIVES,
  // The blink family (`./blink-primitives`): exile a permanent you control and
  // return it immediately. Its own module because the mechanic is one CR rule —
  // 400.7's "a new object" — and every consequence players care about (the ETB
  // fires again, counters and Auras fall off, it comes back summoning-sick) is
  // that rule rather than anything the cards say.
  ...BLINK_PRIMITIVES,
  // The spell-count family (`./spell-count-primitives`, DESIGN §3.113): the
  // bodies of storm, cascade and ripple's cast triggers, learn, "mill, then put
  // a card from among them into your hand", doubling power, and the
  // reveal-the-top-card draw.
  ...SPELL_COUNT_PRIMITIVES,
  // §3.154 — the walker-residue bodies (`./walker-residue-primitives`): the
  // card a graveyard trigger was about, and the pile split an OPPONENT makes
  // over a revealed set. Its own module because both act on an object the
  // resolution never targeted.
  ...WALKER_RESIDUE_PRIMITIVES,
  // §3.156 — the iterative-effects family (`./iterative-primitives`): `repeat
  // this process`. Its own module because the mechanic is a RE-ENTRY into the
  // same resolution rather than an effect — the body is split across two refs so
  // the question it asks comes before the mutation it asks about, and the loop's
  // bound is core's `MAX_EFFECT_STEPS_PER_RESOLUTION`, deliberately not a second
  // budget of its own.
  ...ITERATIVE_PRIMITIVES,
});

/** The set of primitive ids this package provides (for validation). */
export const CORE_PRIMITIVE_IDS: readonly string[] = Object.keys(CORE_PRIMITIVES);

/**
 * Register every core primitive on `registry` (self-registration into the §2
 * effect seam). Idempotent — re-registering overwrites with the same function.
 */
export function registerCoreEffects(registry: EffectRegistry): void {
  for (const [id, primitive] of Object.entries(CORE_PRIMITIVES)) {
    registry.register(id, primitive);
  }
}

