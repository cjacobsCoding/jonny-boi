/**
 * Public surface of the Oracle-text compiler — the seam that turns any real
 * Scryfall card into a genuinely playable engine definition, or an honest report
 * of what the engine still needs (DESIGN §2: features integrate through seams).
 */

export type {
  CompilableCard,
  CompilableCardFace,
  CompileResult,
  CompileRule,
  CompileStatus,
  ClauseContribution,
  RuleContext,
  UnsupportedClause,
} from './types.js';
export {
  compileCard,
  compileCards,
  TYPES_WITHOUT_SYSTEM,
  BACK_FACE_ID_SUFFIX,
  SECOND_CASTABLE_FACE_GAP,
  UNPAYABLE_MANA_SYMBOL_GAP,
  FUSE_GAP,
  ROOM_DOOR_GAP,
} from './compile.js';
export {
  EFFECT_RULES,
  TRIGGER_RULES,
  MANA_RULES,
  STATIC_RULES,
  KEYWORD_FLAGS,
  UNSUPPORTED_HINTS,
  explainUnsupported,
} from './rules.js';
export { parseCount, prepareOracle, normalizeClause, stripReminderText, selfReference } from './text.js';
