/**
 * BLOCKER-LINE pairing (pure, DOM-free, unit-tested) — which blocker→attacker
 * lines the board should draw right now (§3.57: "visual lines connecting cards
 * for blockers"). The SVG geometry lives in `CombatLines.tsx`; WHICH lines
 * exist, and whether each is a committed block or a half-built one, is decided
 * here where it can be tested.
 *
 * Two sources feed the picture:
 * - the engine's DECLARED blocks (`view.combat.blocks`) — the truth once the
 *   defender confirms, visible to both seats through damage and end of combat;
 * - the defender's local DRAFT assignment while the declare-blockers step is
 *   still open — visible only on the device building it, drawn dashed so a
 *   half-decision never looks committed.
 */
import type { InstanceId } from '@jonny-boi/core';

/** One line to draw, blocker → attacker. */
export interface BlockLine {
  readonly blocker: InstanceId;
  readonly attacker: InstanceId;
  /** Committed (engine-declared) vs still being assigned locally. */
  readonly declared: boolean;
}

/** The steps during which declared blocks stay on screen. */
const DECLARED_LINE_STEPS: ReadonlySet<string> = new Set([
  'declareBlockers',
  'combatDamage',
  'endCombat',
]);

/**
 * The lines to draw for one frame. Declared blocks show through
 * {@link DECLARED_LINE_STEPS}; the local draft shows only during
 * `declareBlockers` (it is meaningless afterwards), and a draft entry that the
 * engine already knows is folded into its declared line rather than drawn
 * twice.
 */
export function blockerLinePairs(args: {
  readonly step: string;
  /** The engine's committed blocks, when in combat (else undefined/empty). */
  readonly declaredBlocks: ReadonlyArray<{ readonly blocker: InstanceId; readonly attacker: InstanceId }> | undefined;
  /** The defender's in-progress assignment (blocker → attacker). */
  readonly draftAssign: ReadonlyMap<InstanceId, InstanceId>;
}): readonly BlockLine[] {
  const out: BlockLine[] = [];
  const seen = new Set<InstanceId>();
  if (DECLARED_LINE_STEPS.has(args.step)) {
    for (const block of args.declaredBlocks ?? []) {
      out.push({ blocker: block.blocker, attacker: block.attacker, declared: true });
      seen.add(block.blocker);
    }
  }
  if (args.step === 'declareBlockers') {
    for (const [blocker, attacker] of args.draftAssign) {
      if (seen.has(blocker)) continue;
      out.push({ blocker, attacker, declared: false });
    }
  }
  return out;
}
