/**
 * The About page is a CAPABILITIES CLAIM, and claims rot. These tests are what
 * let it exist at all: every hand-written "supported" entry must present a
 * witness that still resolves against the live registries, and the TODO side
 * must stay well-formed (and non-empty for as long as the compiler really does
 * report gaps — the STUBBED list has since reached zero, which is a claim of
 * its own and is checked as such).
 * If a mechanic is removed (or a witness renamed), the page fails the suite
 * instead of lying to the user.
 */

import { describe, expect, it } from 'vitest';
import { CARD_POOL } from '@jonny-boi/cards';
import {
  SUPPORTED_MECHANIC_GROUPS,
  compilerRuleGroups,
  mechanicsSummary,
  resolveWitness,
  stubbedPoolCards,
  supportedKeywords,
  todoMechanics,
} from './mechanics.js';

describe('supported-mechanic claims', () => {
  for (const group of SUPPORTED_MECHANIC_GROUPS) {
    for (const mechanic of group.mechanics) {
      it(`"${mechanic.title}" still has its witness (${mechanic.witness.kind})`, () => {
        expect(resolveWitness(mechanic.witness)).toBe(true);
      });
    }
  }

  it('never claims the same mechanic twice', () => {
    const titles = SUPPORTED_MECHANIC_GROUPS.flatMap((g) => g.mechanics.map((m) => m.title));
    expect(new Set(titles).size).toBe(titles.length);
  });

  it('every entry has user-facing words, not just a witness', () => {
    for (const group of SUPPORTED_MECHANIC_GROUPS) {
      expect(group.title.length).toBeGreaterThan(0);
      for (const mechanic of group.mechanics) {
        expect(mechanic.title.length).toBeGreaterThan(0);
        expect(mechanic.detail.length).toBeGreaterThan(0);
      }
    }
  });
});

describe('the live registries behind the page', () => {
  it('keywords come from the compiler map and include the combat basics', () => {
    const keywords = supportedKeywords();
    expect(keywords).toContain('flying');
    expect(keywords).toContain('menace');
    expect(keywords.length).toBeGreaterThanOrEqual(10);
  });

  it('every compiler rule shown has an id and a human description', () => {
    for (const group of compilerRuleGroups()) {
      expect(group.rules.length).toBeGreaterThan(0);
      for (const rule of group.rules) {
        expect(rule.id.length).toBeGreaterThan(0);
        expect(rule.description.length).toBeGreaterThan(0);
      }
    }
  });
});

describe('the TODO side', () => {
  it('splits named engine systems from template gaps, without duplicates', () => {
    const todo = todoMechanics();
    const all = [...todo.systems, ...todo.templateGaps];
    expect(new Set(all).size).toBe(all.length);
    // A system everyone knows is missing — if it lands, delete the assertion
    // and enjoy the moment. (Transform/DFC and planeswalker loyalty both used
    // to sit here; both landed, so their hints are TEMPLATE gaps now, and the
    // walker system's one remaining named subsystem is emblems.)
    expect(todo.systems).toContain('emblems (a command-zone object that persists after its planeswalker leaves)');
    expect(todo.templateGaps).toContain('a transform/double-faced template the compiler does not recognize yet');
    // Template wording must not leak into the systems list, or the page would
    // overstate how much engine work is left.
    for (const system of todo.systems) {
      expect(system).not.toMatch(/template the compiler does not recognize yet/);
    }
  });

  it('carries the card types the engine cannot represent', () => {
    expect(todoMechanics().systems).toContain('battles (siege / defense counters)');
  });

  it('lists the stubbed pool cards verbatim, and every entry names a real card', () => {
    // The list is EMPTY today (Cryptic Command, its last entry, was un-stubbed by
    // cast-time modal casting), so this no longer demands a non-empty list — that
    // would be a test demanding the engine stay incomplete. What it still demands
    // is that anything which DOES appear is well-formed and names a card that is
    // really in the pool, which is what makes the page's claim checkable.
    const stubs = stubbedPoolCards();
    for (const stub of stubs) {
      expect(stub.card.length).toBeGreaterThan(0);
      expect(stub.missingEngineSystem.length).toBeGreaterThan(0);
      expect(CARD_POOL.some((card) => card.name === stub.card), stub.card).toBe(true);
    }
  });
});

describe('the summary strip', () => {
  it('reports live, positive counts that agree with their sources', () => {
    const summary = mechanicsSummary();
    expect(summary.poolCards).toBeGreaterThan(0);
    expect(summary.keywords).toBe(supportedKeywords().length);
    expect(summary.compilerRules).toBe(
      compilerRuleGroups().reduce((total, group) => total + group.rules.length, 0),
    );
    expect(summary.primitives).toBeGreaterThan(0);
    expect(summary.missingSystems).toBe(todoMechanics().systems.length);
    expect(summary.templateGaps).toBe(todoMechanics().templateGaps.length);
  });
});
