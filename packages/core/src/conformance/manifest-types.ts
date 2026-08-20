/**
 * The SHAPE of the rules-conformance manifest, and the compile-time proofs that
 * keep it honest. The manifest's DATA lives in `rules-manifest.ts`; the rules
 * about what a manifest entry may say live here, so the data file reads as a
 * list of claims rather than as machinery.
 *
 * ## Why a manifest at all
 * This engine's tests grew up organised BY FEATURE — each written by whoever
 * built that feature, asserting what that author believed the rule was. That
 * answers "do our tests pass?"; it cannot answer **"which rules do we actually
 * implement, and which do we only think we do?"** A rule nobody's feature
 * happened to need is invisibly absent: there is no place where its absence
 * shows up.
 *
 * The manifest is that place. Every Comprehensive Rules section in scope is
 * classified exactly once, as one of four things:
 *
 *  - `covered`   — a conformance test in this directory drives the real engine
 *                  and affirms the rule. The entry NAMES the tests.
 *  - `cited`     — an existing per-feature suite already affirms it properly.
 *                  Pointing at a good test beats copying it (TESTING.md).
 *  - `not-applicable` — with a REASON. Two-player, no-commander, no-multiplayer,
 *                  no formats: most of the CR genuinely does not apply here.
 *  - `gap`       — with the rule's requirement and **what the engine does
 *                  instead**. A gap is a claim we are NOT making.
 *
 * ## Default-deny, enforced three ways
 * This repo already uses exactly this shape three times — `packages/sim`'s
 * `OBSERVATION_POLICY`, `paired-arms-config.ts`, and `internal/continuous.ts`'s
 * `KEYWORD_KEYS`. That last one was hand-maintained until it silently ate a
 * granted hexproof AND a granted indestructible, so it is now a compile-time
 * exhaustiveness proof. The same lesson applies here, and harder: a coverage
 * manifest that can be left stale is WORSE than none, because it reads like an
 * answer.
 *
 *  1. **Every section must be classified** — {@link RulesManifest} is a mapped
 *     type over {@link CrSection}, so a section listed in scope with no entry
 *     stops `tsc`. (`packages/core/tsconfig.json` excludes `*.test.ts`, so this
 *     file being ordinary source is what makes the proof actually run — a
 *     `@ts-expect-error` in a test file is never evaluated by anything.)
 *  2. **Every rule reference must name a section that is in scope** —
 *     {@link CrRule} is a template-literal type over `CrSection`, so `'702.9a'`
 *     type-checks only while `'702'` is a scoped section. A citation cannot
 *     point into the void.
 *  3. **The engine's own vocabularies must stay mapped** — `rules-manifest.ts`
 *     maps every `Step`, every `ZoneName`, every `GameAction['kind']` and every
 *     key of `KeywordFlags` to the rule that governs it, as mapped types over
 *     those unions. **Add a keyword, a zone, a step or an action kind to core
 *     and this package stops compiling until the manifest says which rule it
 *     answers to.** That is the property the KEYWORD_KEYS bug bought: a new
 *     thing must not default into the safe-looking bucket.
 *
 * A fourth check is a runtime one, in `manifest.test.ts` and in the harness's
 * {@link ConformanceFile} assertion: the tests the suite actually COLLECTED are
 * exactly the tests the manifest claims. That is what a type cannot do — it
 * catches a claimed test that was deleted, renamed, or `.skip`ped.
 */

import type { GameAction } from '../actions.js';
import type { KeywordFlags } from '../card.js';
import type { Step, ZoneName } from '../state.js';

// --- scope -------------------------------------------------------------------

/**
 * Every Comprehensive Rules SECTION this manifest reasons about.
 *
 * Scope is deliberately generous: the whole of CR chapters 1–7 plus the parts of
 * 8–9 a two-player game could conceivably touch. Most of it is
 * `not-applicable` — and saying so, with a reason, is the point. A narrow scope
 * that lists only what we implement cannot tell you what we decided not to.
 *
 * ⚠️ Adding a number here without an entry in `RULES_MANIFEST` fails the build.
 */
export const CR_SECTIONS = [
  // 1 — Game concepts
  '100', '101', '102', '103', '104', '105', '106', '107', '108', '109',
  '110', '111', '112', '113', '114', '115', '116', '117', '118', '119',
  '120', '121', '122', '123',
  // 2 — Parts of a card
  '200', '201', '202', '203', '204', '205', '206', '207', '208', '209',
  '210', '211', '212', '213',
  // 3 — Card types
  '300', '301', '302', '303', '304', '305', '306', '307', '308', '309',
  '310', '311', '312', '313', '314', '315',
  // 4 — Zones
  '400', '401', '402', '403', '404', '405', '406', '407', '408',
  // 5 — Turn structure
  '500', '501', '502', '503', '504', '505', '506', '507', '508', '509',
  '510', '511', '512', '513', '514',
  // 6 — Spells, abilities, and effects
  '600', '601', '602', '603', '604', '605', '606', '607', '608', '609',
  '610', '611', '612', '613', '614', '615', '616',
  // 7 — Additional rules
  '700', '701', '702', '703', '704', '705', '706', '707', '708', '709',
  '710', '711', '712', '713', '714', '715', '716', '717', '718', '719',
  '720', '721', '722', '723', '724', '725', '726', '727', '728', '729',
  '730', '731', '732', '733',
  // 8 — Multiplayer, 9 — Casual variants (all not-applicable; enumerated so the
  // classification is a stated decision rather than an omission).
  '800', '801', '802', '803', '804', '805', '806', '807', '808', '809',
  '810', '811',
  '900', '901', '902', '903', '904', '905',
] as const;

/** One CR section number, as a string. */
export type CrSection = (typeof CR_SECTIONS)[number];

/**
 * A reference to one CR rule — a scoped section plus its sub-rule
 * (`'704.5g'`, `'509.1'`, `'117.3a'`).
 *
 * The template-literal type is the second default-deny: a citation whose section
 * is not in {@link CR_SECTIONS} does not type-check, so the manifest and the
 * tests cannot cite a rule the scope does not know about.
 */
export type CrRule = `${CrSection}.${string}`;

/** The section a rule reference belongs to: `'704.5g'` → `'704'`. */
export function sectionOf(rule: CrRule): CrSection {
  return rule.slice(0, rule.indexOf('.')) as CrSection;
}

// --- the conformance files ----------------------------------------------------

/**
 * Every conformance test file, by basename. The harness's per-file assertion is
 * keyed by these, so a new file must be listed before it can claim anything.
 */
export const CONFORMANCE_FILES = [
  'cr1xx-2xx-objects',
  'cr4xx-zones',
  'cr5xx-turn-and-combat',
  'cr6xx-spells-and-abilities',
  'cr7xx-sba-keywords-copy',
] as const;

/** One conformance file's basename. */
export type ConformanceFile = (typeof CONFORMANCE_FILES)[number];

// --- what an entry may say ----------------------------------------------------

/** One conformance test, as the manifest claims it: its rule and its title. */
export interface ClaimedTest {
  readonly rule: CrRule;
  readonly title: string;
}

/**
 * `covered` — conformance tests in THIS directory affirm the section against the
 * real engine. `tests` is the exact list the named file must collect.
 */
export interface Covered {
  readonly status: 'covered';
  readonly file: ConformanceFile;
  readonly tests: readonly ClaimedTest[];
  /** Optional: what part of the section is affirmed, when it isn't all of it. */
  readonly note?: string;
}

/**
 * `cited` — an existing per-feature suite already affirms this rule properly, so
 * the conformance corpus INDEXES it rather than copying it. TESTING.md: "a
 * manifest that points at an existing good test is better than a copy of it."
 */
export interface Cited {
  readonly status: 'cited';
  /** Repo-relative path of the suite that owns the proof. */
  readonly suite: string;
  /** What that suite proves about this section. */
  readonly what: string;
}

/**
 * `not-applicable` — the section describes something this engine deliberately
 * does not model. The reason is mandatory and must say WHY, not merely that it
 * is out of scope.
 */
export interface NotApplicable {
  readonly status: 'not-applicable';
  readonly reason: string;
}

/**
 * `gap` — the engine does not do what the rule requires, or does something
 * observably different. Both fields are mandatory: a gap with no `engine` field
 * is an admission with no reproduction, which is how a known defect becomes a
 * forgotten one.
 */
export interface Gap {
  readonly status: 'gap';
  /** What the rule requires, in one sentence. */
  readonly rule: string;
  /** What this engine does instead — concretely enough to reproduce. */
  readonly engine: string;
  /**
   * A sibling branch that owns the fix, when one does. A gap inside somebody
   * else's live work is written up, not raced (COORDINATION.md).
   */
  readonly owner?: string;
}

/** One section's classification. */
export type ManifestEntry = Covered | Cited | NotApplicable | Gap;

/**
 * The manifest itself: a mapped type over {@link CrSection}, so **an
 * unclassified section fails the build**.
 */
export type RulesManifest = { readonly [S in CrSection]: ManifestEntry };

// --- the engine's own vocabularies --------------------------------------------

/**
 * Every key of `KeywordFlags` — the payload keywords (`protectionFrom`, `ward`,
 * `minBlockers`) included, because a rules index cares that the keyword exists,
 * not how its value is shaped.
 */
export type EngineKeyword = keyof KeywordFlags;

/**
 * A vocabulary map: every member of an engine union → the CR rule that governs
 * it. Mapped, so the union growing makes the manifest fail to compile.
 */
export type RuleFor<Union extends string> = { readonly [K in Union]: CrRule };

/** Every shipped keyword → its CR 702.x (or 113.x) rule. */
export type KeywordRules = RuleFor<EngineKeyword>;
/** Every step of the turn → the CR 5xx rule that defines it. */
export type StepRules = RuleFor<Step>;
/** Every zone → the CR 4xx rule that defines it. */
export type ZoneRules = RuleFor<ZoneName>;
/** Every player action the engine accepts → the rule that authorises it. */
export type ActionRules = RuleFor<GameAction['kind']>;
