/**
 * Tunable weights for the `heuristic` pilot (DESIGN §1 "data-driven, no magic
 * numbers"). Every threshold and score the heuristic uses is a *named* field
 * here, so a designer can re-tune the AI from one data object without touching
 * decision code. The defaults below are chosen to make a competent, non-random
 * pilot — not an optimal one — and are all justified in comments.
 *
 * Scoring model: the heuristic scores each candidate main-phase action with a
 * single number and picks the highest. The scores are deliberately on a shared,
 * coarse scale (tens) so the ordering between *categories* of play (kill a
 * threat vs. develop the board vs. burn the face) is what matters, not fine
 * tuning. Ties break on the seeded RNG, so behaviour stays reproducible.
 */

/** The complete, tunable weight set the heuristic reads. Pure data. */
export interface HeuristicWeights {
  // --- land / tempo --------------------------------------------------------
  /** Score for playing a land when one is available. Lands come first: developing
   *  mana is almost always correct, so this outranks most spells on a given turn.
   *  This is the score of the BEST land drop; the three weights below only order
   *  the land drops against EACH OTHER, so land-vs-spell ordering is unaffected. */
  readonly playLandScore: number;
  /** How much a land is worth for the spell it UNLOCKS — a multiplier on the
   *  `cardValue` of the best spell in hand that this land makes castable and that
   *  is not castable without it. At 1 the ordering is "play the land that casts the
   *  best thing you are holding", which is the whole point: a Mountain and a Swamp
   *  are the same card until one of them is the one your removal spell needs. */
  readonly landUnlocksSpellWeight: number;
  /** Worth of a land adding a colour our HAND is asking for that none of our
   *  permanents can make yet — the future-turn half of sequencing ("don't strand a
   *  colour"). Below unlocking a real spell now, above a pure tempo preference. */
  readonly landFixesNeededColorScore: number;
  /** Worth of spending a land that arrives TAPPED on a turn where no land drop
   *  unlocks anything anyway. A tapland costs a mana on the turn it is played, so
   *  the right turn to play it is one where that mana was never going to be spent —
   *  holding it merely defers the cost onto a turn you do not get to choose. It is a
   *  tie-break, not a reason, so it sits below fixing a colour. */
  readonly landTaplandFreerollScore: number;

  // --- removal -------------------------------------------------------------
  /** Base score for casting a removal/burn spell that kills an opposing creature. */
  readonly removalBaseScore: number;
  /** Extra score per point of power of the creature removal kills (kill the
   *  biggest threat first). */
  readonly removalPerPowerOfTarget: number;

  // --- burn to face --------------------------------------------------------
  /** Floor score for pointing direct damage at the opponent's face, before the
   *  pressure term below. On its own it is lower than removal, so at a healthy
   *  life total the AI still prefers killing a real threat over chipping. */
  readonly burnFaceBaseScore: number;
  /** Score per point of face damage, scaled by `burnFaceLifeReference / life`.
   *  This is what makes the same burn spell a chip at twenty life and the best
   *  card in the deck at eight — burn is worth the FRACTION of the remaining life
   *  it removes, so an aggro deck actually closes instead of answering creatures
   *  until it runs out of gas. */
  readonly burnFacePerDamage: number;
  /** The life total at which face burn is worth exactly `burnFacePerDamage` per
   *  point. Above it burn is worth less, below it more — set at the starting life
   *  total so "a fresh opponent" is the reference point. */
  readonly burnFaceLifeReference: number;
  /** Score for burn that is *lethal* to the opponent right now — take the win. */
  readonly lethalBurnScore: number;
  /**
   * What one point of PREVENTED combat damage is worth when deciding whether to
   * cast a fog. Deliberately per-damage rather than a flat score: a fog is worth
   * exactly what it stops, so a two-power poke should leave it in hand while a
   * real attack gets it cast. A swing that would KILL is not priced here at all
   * — it takes {@link lethalBurnScore}, because surviving is the whole game.
   */
  readonly fogValuePerDamagePrevented: number;
  /**
   * The least damage a fog must prevent to be worth the CARD it costs. Below it
   * the pilot holds the fog — two points of life at a healthy total is not worth
   * a card, and a pilot that fires prevention at every poke has thrown it away
   * before the attack that mattered. Ignored when the pilot is already at or
   * below {@link desperateLifeThreshold}, where every point does matter, and
   * irrelevant against a LETHAL swing, which is priced at
   * {@link lethalBurnScore} instead.
   */
  readonly fogMinimumDamagePrevented: number;

  // --- developing the board ------------------------------------------------
  /** Base score for casting a creature to develop the board. */
  readonly castCreatureBaseScore: number;
  /** Extra score per point of (power + toughness) of the creature cast — bigger
   *  bodies are better development. */
  readonly castCreaturePerStat: number;

  // --- combat tricks (pump) ------------------------------------------------
  /** Base score for a +X/+Y trick that saves one of our creatures from dying in
   *  combat. Cards-for-cards this is a real two-for-one, so it sits near removal;
   *  the creature's own stats are added on top (see `ownCreatureLossPerStat`). */
  readonly pumpSaveCreatureScore: number;
  /** Base score for a trick that lets our creature win a fight it would otherwise
   *  lose or draw. The victim's stats are added on top (`killEnemyPerStat`). */
  readonly pumpWinFightScore: number;
  /** Score per point of extra face damage from pumping an UNBLOCKED attacker.
   *  Deliberately small: spending a card to chip a few life is a poor rate, so
   *  this only wins when nothing better is on offer (lethal is scored separately
   *  at `lethalBurnScore`). */
  readonly pumpFaceDamagePerPower: number;

  // --- attachments (auras + equipment) -------------------------------------
  /** Base score for attaching an Aura or Equipment to a creature. Below casting a
   *  creature: an attachment is a card that does nothing on its own and dies with
   *  its host, so developing a real body first is the safer default. */
  readonly attachBaseScore: number;
  /** Extra score per point of (power + toughness) the attachment grants its host,
   *  and per granted keyword. One knob for "how much is this buff worth". */
  readonly attachPerStat: number;
  /** Extra score per keyword granted (flying/trample/lifelink all change a race
   *  more than a stat point does, so this is worth more than one stat). */
  readonly attachPerKeyword: number;

  // --- generic / fallback --------------------------------------------------
  /** Score for any other castable spell we don't specifically understand. Above
   *  passing (so we do *something* with mana) but below targeted plays. */
  readonly genericSpellScore: number;
  /** Score for passing priority — the floor. Any positive-scoring play beats it. */
  readonly passScore: number;

  // --- cycling (alternative costs) -----------------------------------------
  /** How many lands on the battlefield count as FLOODED — the point past which a
   *  further land in hand is worth less than an unknown card, so cycling one away
   *  is a gain rather than a cost. Deliberately a count of lands in play rather
   *  than a ratio: it is the number the pilot can actually see, and it is the same
   *  number a human uses when they say "I have plenty of lands". */
  readonly floodedLandCount: number;
  /** Score for cycling a surplus LAND while flooded. Above `genericSpellScore`
   *  because trading a card that does nothing for an unknown card is close to
   *  free, but below `playLandScore` so a pilot that still wants its land drop
   *  takes the drop first. */
  readonly cycleFloodedScore: number;
  /** Score for cycling anything else when the turn is ENDING and the mana would
   *  otherwise empty unused. Just above `passScore`: it never outbids a real
   *  play, and it stops mana from being wasted on a turn with nothing to do. */
  readonly cycleIdleScore: number;

  // --- attacking -----------------------------------------------------------
  /** Minimum net "value" (see attack evaluation) for an attack to be worth making.
   *  An attacker is sent if it can deal unblocked damage or the expected trade is at
   *  least this favourable; below this we hold it back. */
  readonly attackValueThreshold: number;
  /** How much a point of damage to the opponent's face is worth when weighing an
   *  attack (aggression). */
  readonly faceDamageValue: number;
  /** How much losing our own creature in a trade costs us (by its power+toughness),
   *  per stat point — discourages suiciding good creatures into bad blocks. */
  readonly ownCreatureLossPerStat: number;
  /** How much killing an opponent's creature in a trade is worth, per stat point. */
  readonly killEnemyPerStat: number;
  /** How much removing an enemy planeswalker is worth, per loyalty counter it has —
   *  a walker generates value every turn it lives, so killing one prices like
   *  removal: this per-loyalty term steers both attacks and burn toward walkers
   *  that can actually be finished off. */
  readonly walkerThreatPerLoyalty: number;
  /** Flat value for finishing OFF an enemy planeswalker (on top of the per-loyalty
   *  term) — the ability stream it stops is worth more than its remaining counters. */
  readonly walkerKillBonus: number;
  /** How much removing the last defense counter from an enemy BATTLE is worth, per
   *  counter it has left. Priced BELOW `walkerThreatPerLoyalty` deliberately: a
   *  walker generates value every turn it lives, whereas a battle just sits there
   *  — the prize is the reward for defeating it, not the harm of leaving it up. */
  readonly battleThreatPerDefense: number;
  /** Flat value for DEFEATING an enemy battle (on top of the per-defense term) —
   *  the reward it pays out is the whole reason to attack it, so this is what
   *  outbids face damage once the last counter is actually reachable. */
  readonly battleDefeatBonus: number;

  // --- activating loyalty abilities -----------------------------------------
  /** Base score for activating a loyalty ability whose effects come out at least
   *  neutral: a PLUS ability is nearly free value each turn, so this sits above
   *  `passScore` — a walker whose controller never activates it is an inert card. */
  readonly loyaltyAbilityBaseScore: number;
  /** How much each point of loyalty GAINED (a plus cost) adds to the score, and
   *  each point spent (a minus cost) subtracts — spending toward zero must be
   *  bought by the ability's effect value. */
  readonly loyaltyPerCounter: number;

  // --- blocking ------------------------------------------------------------
  /** Below this life total the defender blocks much more readily (preserve life /
   *  avoid lethal takes priority over keeping creatures back). */
  readonly desperateLifeThreshold: number;
  /** Net value threshold for making a block when not under lethal pressure: block
   *  if the trade is at least this good (kills the attacker without losing more
   *  than we gain). */
  readonly blockValueThreshold: number;

  // --- answering player choices (choices.ts) --------------------------------
  /** What a LAND is worth when the pilot must rank cards for a choice ("which card
   *  do I discard / return / put back on top"). Low: a land in hand late is the
   *  card you part with first, which is the common case for these effects. */
  readonly choiceLandValue: number;
  /** Base worth of a CREATURE being ranked for a choice. */
  readonly choiceCreatureBaseValue: number;
  /** Extra worth per point of (power + toughness) — bigger bodies rank higher. */
  readonly choiceCreaturePerStatValue: number;
  /** Base worth of any non-land, non-creature card (removal, burn, a draw spell). */
  readonly choiceSpellBaseValue: number;
  /** Extra worth per point of mana value — expensive spells are the payoff cards
   *  you keep, cheap ones the chaff you pitch. */
  readonly choiceSpellPerManaValue: number;
  /** Answer to a "you may …" that carries no `ChoiceValence` steer. Yes by default:
   *  an optional clause on a card you chose to cast is normally its upside. */
  readonly choiceConfirmNeutralYes: boolean;
  /** Answer to a "pay {N} or lose it" that carries no `ChoiceValence` steer. Yes
   *  by default: something is being taken away unless the mana is spent, and the
   *  engine only ever asks a player who can actually spend it. */
  readonly choicePayManaNeutralYes: boolean;
  /**
   * What a soft counter ("counter target spell **unless** its controller pays
   * {3}") is worth as a fraction of a hard counter, WHEN that player can pay. It
   * is not zero — paying strips them of the mana, which is most of why the card
   * is played — and it is not one, because the spell probably resolves.
   */
  readonly softCounterPayableFactor: number;
  /** Lands in play below which the ranker treats a land in hand as a lifeline
   *  rather than chaff. Roughly "enough mana to operate the deck". */
  readonly choiceLandsWanted: number;
  /** What a LAND is worth while its controller is still short of mana (below
   *  `choiceLandsWanted`). High enough that a pilot pitches a cheap spell before
   *  the land that would let it cast anything at all. */
  readonly choiceLandShortValue: number;
  /**
   * The `cardValue` a looked-at card must clear to be KEPT on top of the library
   * by a scry or a surveil; anything at or below it is bottomed (scry) or
   * binned (surveil).
   *
   * This one number is the whole scry policy, and it works because `cardValue`
   * already knows about flooding: a land is worth `choiceLandShortValue` while
   * its controller is below `choiceLandsWanted` and only `choiceLandValue`
   * once the mana is built. So a threshold sitting BETWEEN those two values
   * makes the pilot keep a land exactly while it still needs lands and bottom
   * it the moment it is flooded — the single most valuable scry decision in
   * real Magic — while every creature and spell (which start at
   * `choiceCreatureBaseValue` / `choiceSpellBaseValue`) clears it and stays.
   */
  readonly scryKeepValueThreshold: number;

  // --- scoring EFFECTS (effect-value.ts — modal-spell modes) -----------------
  // Modes are scored on the SAME scale as spells above (removal ≈ 60, develop ≈ 40,
  // generic ≈ 25, pass = 0), reusing those weights wherever the category already
  // exists. The weights below are only for the categories a whole-spell score never
  // had to price on its own.
  /** What drawing ONE card is worth. Sits between "generic spell" and "removal":
   *  a card is real, board-independent value, but a mode that kills their threat
   *  or counters their spell is normally worth more. */
  readonly modeDrawCardValue: number;
  /** Penalty (subtracted) for a draw the library cannot pay for — drawing from an
   *  empty library loses the game, so this must outweigh every upside. */
  readonly modeSelfDeckPenalty: number;
  /** Penalty (subtracted) for pointing an effect at our OWN board/face/spell.
   *  Large enough that such a mode always loses to any other on the menu. */
  readonly modeSelfHarmPenalty: number;
  /** Base worth of bouncing an opposing permanent — the tempo floor, before what
   *  it costs them to redeploy. Deliberately low, so bouncing a land or a mana
   *  dork loses to simply drawing a card. */
  readonly modeBounceBaseScore: number;
  /** Extra worth per point of mana value they must re-pay to redeploy the bounced
   *  permanent (this is what makes bouncing a five-drop worth doing). */
  readonly modeBouncePerManaValue: number;
  /** Worth per point of power of an opposing creature we tap down (a Falter/fog
   *  effect): it neither blocks this turn nor attacks the next. */
  readonly modeTapPerPowerValue: number;
  /** Worth per point of life gained at a healthy life total. */
  readonly modeLifePerPointValue: number;
  /** Multiplier on life swings while at or below `desperateLifeThreshold`, where
   *  life stops being a resource and starts being the game. */
  readonly modeDesperateLifeMultiplier: number;
  /** Base worth of stripping a card from a hand, on top of the card's own value. */
  readonly modeDiscardBaseScore: number;
  /** Worth of pure card SELECTION (rearranging/looking at the top of a library):
   *  real, but strictly below drawing, which this must never exceed. */
  readonly modeSelectionValue: number;
  /** Worth per mana symbol an effect adds to our pool mid-resolution. */
  readonly modeManaPerSymbolValue: number;
  /** Score for an effect primitive this build does not recognise. Positive — an
   *  unknown mode is probably still doing something — but below every category we
   *  do understand, so a known-good mode always wins. */
  readonly modeUnknownEffectScore: number;
  /** What one point of a temporary +X/+X is worth when scoring which creature to
   *  point a pump at. Below `attachPerStat` on purpose: a pump wears off at end of
   *  turn, an Equipment does not. */
  readonly modePumpPerStatValue: number;
  /**
   * What fraction of a card's own value a GRANTED FLASHBACK is worth — the
   * Snapcaster ETB, priced as the card advantage it is.
   *
   * Below 1 on purpose, and the reason is the mechanic's one real limit: the
   * grant expires at end of turn and the card still has to be paid for, so it
   * is worth strictly less than returning that card to hand (`returnFromGraveyard`
   * scores the full value). Above zero by a wide margin, because a
   * flashed-back removal spell or draw spell is the same card twice — which is
   * exactly the card advantage the pilot already understands.
   */
  readonly grantedFlashbackValueShare: number;
}

/**
 * The default, MTG-sensible weights. Tuned so the ordering is:
 *   lethal burn  >  play land  >  removal (scaled by threat)  >  combat trick
 *   that saves a creature or wins a fight  >  develop board  >  burn face
 *   >  generic spell  >  pass.
 * Numbers are coarse on purpose — the *relative ordering* is the design, and it's
 * all editable here.
 */
export const DEFAULT_HEURISTIC_WEIGHTS: HeuristicWeights = Object.freeze({
  // land / tempo. Sequencing terms are in `cardValue` units (a spell is 8 + 2 per
  // mana value, a creature 10 + 2 per stat point), so at weight 1 "unlock the
  // removal spell you are holding" is worth ~14 — enough to order two land drops
  // against each other, never enough to reorder a land against a spell.
  // ⚠️ ALL THREE SHIP ON, and the near-miss that established that is worth knowing:
  // on ONE matchup the unlock term alone measured better than the blend (52.6% of
  // discordant games vs 50.9%), which is a tempting reason to zero the other two.
  // On the SECOND matchup it reversed exactly (blend 52.0%, unlock alone 50.9%).
  // Pooled over 80,000 paired games the blend is 51.7% [50.5, 52.8] and unlock alone
  // is 51.4% [50.1, 52.7] — both real, neither separable from the other. Choosing
  // the default from the first matchup would have been picking the best of four arms
  // on one sample. See DESIGN §3.4e.
  playLandScore: 90,
  landUnlocksSpellWeight: 1,
  landFixesNeededColorScore: 6,
  landTaplandFreerollScore: 2,

  // removal
  removalBaseScore: 60,
  removalPerPowerOfTarget: 6,

  // burn to face. Three damage scores ~42 at twenty life (a kill on a 2/2 is 72,
  // so the AI still removes), ~74 at eight life (now the face wins), and jumps to
  // `lethalBurnScore` the moment it finishes the game.
  burnFaceBaseScore: 20,
  burnFacePerDamage: 6,
  burnFaceLifeReference: 24,
  lethalBurnScore: 1000,
  // A fog is priced between a cheap creature and a removal spell per point it
  // saves: six damage prevented (~48) outbids developing a two-drop (~44) and
  // stays below killing a real threat, which is the trade a fog actually is.
  fogValuePerDamagePrevented: 8,
  fogMinimumDamagePrevented: 3,

  // develop
  castCreatureBaseScore: 40,
  castCreaturePerStat: 2,

  // combat tricks — saving a creature or winning a fight is removal-adjacent
  // value; pumping an unblocked attacker for a few points is not.
  pumpSaveCreatureScore: 50,
  pumpWinFightScore: 55,
  pumpFaceDamagePerPower: 2,

  // attachments — worth real value on a board with a creature to carry them,
  // but below developing a body, and (via `attachPerStat`) proportional to the
  // buff rather than a flat "always equip".
  attachBaseScore: 30,
  attachPerStat: 4,
  attachPerKeyword: 6,

  // generic / fallback
  genericSpellScore: 25,
  passScore: 0,

  // cycling
  floodedLandCount: 5,
  cycleFloodedScore: 45,
  cycleIdleScore: 5,

  // attacking
  attackValueThreshold: 1,
  faceDamageValue: 1,
  ownCreatureLossPerStat: 1,
  killEnemyPerStat: 1,
  // A walker at N loyalty prices like a creature with ~2N stats on the table
  // (each turn it lives is another ability), plus a flat bonus for actually
  // finishing it — together they outbid plain face damage whenever the walker
  // can really be killed, and never when it cannot.
  walkerThreatPerLoyalty: 2,
  walkerKillBonus: 8,
  // A battle is not a recurring threat the way a walker is — it does nothing while
  // it sits there — so each remaining counter is worth less than a loyalty point.
  // The value is concentrated in the DEFEAT bonus, which is what a Siege's reward
  // actually is, and that shape is what stops a pilot chipping at a battle it
  // cannot finish (chip damage on a battle buys precisely nothing).
  battleThreatPerDefense: 1,
  battleDefeatBonus: 8,

  // activating loyalty abilities: above genericSpellScore so a walker on the
  // table is USED (a plus activation is close to free value every turn), with
  // each spent counter priced so a minus must be bought by its effect value.
  loyaltyAbilityBaseScore: 30,
  loyaltyPerCounter: 3,

  // blocking
  desperateLifeThreshold: 10,
  blockValueThreshold: 0,

  // answering choices — the ordering these produce is
  //   big creature > small creature ≈ expensive spell > cheap spell > land
  // which is what "discard your worst card / return your best one" should mean.
  choiceLandValue: 2,
  choiceCreatureBaseValue: 10,
  choiceCreaturePerStatValue: 2,
  choiceSpellBaseValue: 8,
  choiceSpellPerManaValue: 2,
  choiceConfirmNeutralYes: true,
  choicePayManaNeutralYes: true,
  // A third of a hard counter: the tax lands every time, the counter only when
  // they are tapped out. Tuned as a fraction rather than an absolute so it tracks
  // the value of the specific card being countered.
  softCounterPayableFactor: 1 / 3,
  // Four lands casts essentially everything in the pool, so that is where a land
  // in hand stops being a lifeline. Below it a land outranks a cheap spell and a
  // small body (a 2/2 scores 18) but still loses to a genuine bomb (a 6/6 scores 34).
  choiceLandsWanted: 4,
  choiceLandShortValue: 20,
  // Between `choiceLandValue` (2 — a land you no longer need) and every other
  // card's floor (`choiceSpellBaseValue` 8, `choiceCreatureBaseValue` 10, and a
  // needed land's `choiceLandShortValue` 20). So: bottom flooded lands, keep
  // everything else. See the field's doc comment for why one number suffices.
  scryKeepValueThreshold: 5,

  // scoring effects (modal-spell modes) — the ordering these produce is
  //   lethal > counter/kill their best thing > draw a card > bounce a real threat
  //   > tap their board > bounce a land ≈ gain a little life
  modeDrawCardValue: 30,
  modeSelfDeckPenalty: 1000,
  modeSelfHarmPenalty: 100,
  modeBounceBaseScore: 6,
  modeBouncePerManaValue: 6,
  modeTapPerPowerValue: 6,
  modeLifePerPointValue: 3,
  modeDesperateLifeMultiplier: 4,
  modeDiscardBaseScore: 10,
  modeSelectionValue: 10,
  modeManaPerSymbolValue: 4,
  modeUnknownEffectScore: 20,
  // A +2/+2 until end of turn scores 8 — worth taking over nothing, comfortably
  // below removing a real threat (60+), which is the ordering that matters.
  modePumpPerStatValue: 2,
  // Two thirds of the card: the same card again, minus the end-of-turn clock
  // and minus having to pay for it a second time.
  grantedFlashbackValueShare: 2 / 3,
});
