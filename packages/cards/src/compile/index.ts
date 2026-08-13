/**
 * Public surface of the Oracle-text compiler — the seam that turns any real
 * Scryfall card into a genuinely playable engine definition, or an honest report
 * of what the engine still needs (DESIGN §2: features integrate through seams).
 */

export type {
  CompilableCard,
  CompileResult,
  CompileRule,
  CompileStatus,
  ClauseContribution,
  RuleContext,
  UnsupportedClause,
} from './types.js';
export { compileCard, compileCards } from './compile.js';
export { EFFECT_RULES, TRIGGER_RULES, MANA_RULES, KEYWORD_FLAGS, explainUnsupported } from './rules.js';
export { parseCount, prepareOracle, normalizeClause, stripReminderText, selfReference } from './text.js';
