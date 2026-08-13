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
   *  mana is almost always correct, so this outranks most spells on a given turn. */
  readonly playLandScore: number;

  // --- removal -------------------------------------------------------------
  /** Base score for casting a removal/burn spell that kills an opposing creature. */
  readonly removalBaseScore: number;
  /** Extra score per point of power of the creature removal kills (kill the
   *  biggest threat first). */
  readonly removalPerPowerOfTarget: number;

  // --- burn to face --------------------------------------------------------
  /** Base score for pointing direct damage at the opponent's face. Lower than
   *  removal so the AI prefers killing a real threat over chipping life — unless
   *  the damage is lethal (see `lethalBurnScore`). */
  readonly burnFaceBaseScore: number;
  /** Score for burn that is *lethal* to the opponent right now — take the win. */
  readonly lethalBurnScore: number;

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

  // --- generic / fallback --------------------------------------------------
  /** Score for any other castable spell we don't specifically understand. Above
   *  passing (so we do *something* with mana) but below targeted plays. */
  readonly genericSpellScore: number;
  /** Score for passing priority — the floor. Any positive-scoring play beats it. */
  readonly passScore: number;

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

  // --- blocking ------------------------------------------------------------
  /** Below this life total the defender blocks much more readily (preserve life /
   *  avoid lethal takes priority over keeping creatures back). */
  readonly desperateLifeThreshold: number;
  /** Net value threshold for making a block when not under lethal pressure: block
   *  if the trade is at least this good (kills the attacker without losing more
   *  than we gain). */
  readonly blockValueThreshold: number;
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
  // land / tempo
  playLandScore: 90,

  // removal
  removalBaseScore: 60,
  removalPerPowerOfTarget: 6,

  // burn to face
  burnFaceBaseScore: 20,
  lethalBurnScore: 1000,

  // develop
  castCreatureBaseScore: 40,
  castCreaturePerStat: 2,

  // combat tricks — saving a creature or winning a fight is removal-adjacent
  // value; pumping an unblocked attacker for a few points is not.
  pumpSaveCreatureScore: 50,
  pumpWinFightScore: 55,
  pumpFaceDamagePerPower: 2,

  // generic / fallback
  genericSpellScore: 25,
  passScore: 0,

  // attacking
  attackValueThreshold: 1,
  faceDamageValue: 1,
  ownCreatureLossPerStat: 1,
  killEnemyPerStat: 1,

  // blocking
  desperateLifeThreshold: 10,
  blockValueThreshold: 0,
});
