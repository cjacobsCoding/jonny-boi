/**
 * The event→text formatter is the single source of replay-log prose (DRY). It must
 * name instances via the resolver, describe the meaningful events readably, omit
 * bookkeeping noise (priority/mana/untap), and never throw on an unknown id.
 */
import { describe, expect, it } from 'vitest';
import type { GameEvent } from '@jonny-boi/core';
import { describeEvent, type NameResolver } from './replay-format.js';

const names: Record<number, string> = { 11: 'Grizzly Bears', 12: 'Lightning Bolt', 20: 'Llanowar Elves' };
const resolve: NameResolver = (id) => names[id] ?? `#${id}`;

describe('describeEvent', () => {
  it('describes a spell cast with the cast tone', () => {
    const e: GameEvent = { type: 'spellCast', player: 'A', instanceId: 12, name: 'Lightning Bolt', castTypes: ['instant'] };
    const line = describeEvent(e, resolve);
    expect(line?.text).toBe('Player A casts Lightning Bolt.');
    expect(line?.tone).toBe('cast');
  });

  it('resolves instance ids for damage and names both source and target', () => {
    const e: GameEvent = { type: 'damageDealt', source: 11, target: 20, amount: 2, combat: true };
    const line = describeEvent(e, resolve);
    expect(line?.text).toBe('Grizzly Bears deals 2 to Llanowar Elves.');
  });

  it('labels a player target as "Player X"', () => {
    const e: GameEvent = { type: 'damageDealt', source: 12, target: 'B', amount: 3, combat: false };
    expect(describeEvent(e, resolve)?.text).toBe('Lightning Bolt deals 3 to Player B.');
  });

  it('phrases life loss and gain with the running total', () => {
    const loss: GameEvent = { type: 'lifeChanged', player: 'B', delta: -3, to: 17 };
    expect(describeEvent(loss, resolve)?.text).toBe('Player B loses 3 life (now 17).');
    const gain: GameEvent = { type: 'lifeChanged', player: 'A', delta: 4, to: 24 };
    expect(describeEvent(gain, resolve)?.text).toBe('Player A gains 4 life (now 24).');
  });

  it('describes a creature death and the game end', () => {
    expect(describeEvent({ type: 'creatureDied', instanceId: 11, name: 'Grizzly Bears' }, resolve)?.tone).toBe('death');
    const over = describeEvent({ type: 'gameOver', winner: 'A' }, resolve);
    expect(over?.text).toMatch(/Player A wins/);
    expect(over?.tone).toBe('win');
  });

  it('lists declared attackers by name', () => {
    const e: GameEvent = { type: 'attackersDeclared', attackers: [11, 20] };
    expect(describeEvent(e, resolve)?.text).toBe('Attacks with Grizzly Bears, Llanowar Elves.');
  });

  it('omits bookkeeping events (returns null)', () => {
    expect(describeEvent({ type: 'priorityPassed', player: 'A' }, resolve)).toBeNull();
    expect(describeEvent({ type: 'manaAdded', player: 'A', color: 'R', amount: 1 }, resolve)).toBeNull();
    expect(describeEvent({ type: 'untapped', instanceId: 11, player: 'A' }, resolve)).toBeNull();
    expect(describeEvent({ type: 'attackersDeclared', attackers: [] }, resolve)).toBeNull();
  });

  it('never throws on an unknown instance id — uses the resolver fallback', () => {
    const e: GameEvent = { type: 'damageDealt', source: 999, target: 'A', amount: 1, combat: true };
    expect(() => describeEvent(e, resolve)).not.toThrow();
    expect(describeEvent(e, resolve)?.text).toBe('#999 deals 1 to Player A.');
  });
});

/**
 * THE COPY FAMILY, AND THE EXILE — report 20260911_194411's class, in the
 * viewer that has the same hole. `spellCopied` has had a line since it shipped;
 * its trigger twin, the activation that made it and the zone change that IS an
 * exile had none, so a Strionic Resonator play was invisible here too.
 */
describe('a copied ability, and where a permanent went', () => {
  it('announces a COPIED TRIGGER the way it announces a copied spell', () => {
    const e: GameEvent = {
      type: 'triggerCopied',
      instanceId: 99,
      copiedInstanceId: 50,
      controller: 'A',
      label: 'Enters: exile target creature',
    };
    expect(describeEvent(e, resolve)?.text).toBe('Player A copies Enters: exile target creature.');
  });

  it('names the permanent whose ability was activated', () => {
    const e: GameEvent = { type: 'abilityActivated', player: 'B', instanceId: 20, label: '{T}: add G' };
    expect(describeEvent(e, resolve)?.text).toBe('Player B activates Llanowar Elves.');
  });

  it('says an ability that did nothing did nothing, and why', () => {
    const e: GameEvent = {
      type: 'triggerFizzled',
      sourceInstanceId: 11,
      controller: 'A',
      label: 'Enters: exile target creature',
      reason: 'its target is no longer legal (a creature)',
    };
    expect(describeEvent(e, resolve)?.text).toBe(
      'Enters: exile target creature — nothing happens (its target is no longer legal (a creature)).',
    );
  });

  it('says where a permanent leaving the battlefield went — one row per zone', () => {
    const leave = (to: 'exile' | 'hand' | 'library'): string | undefined =>
      describeEvent({ type: 'zoneChange', instanceId: 11, from: 'battlefield', to }, resolve)?.text;
    expect(leave('exile')).toBe('Grizzly Bears is exiled.');
    expect(leave('hand')).toBe("Grizzly Bears returns to its owner's hand.");
    expect(leave('library')).toBe("Grizzly Bears is put into its owner's library.");
  });

  it('leaves the graveyard move to `creatureDied`, and every other zone change silent', () => {
    // Narrating battlefield→graveyard here would print every death twice.
    expect(
      describeEvent({ type: 'zoneChange', instanceId: 11, from: 'battlefield', to: 'graveyard' }, resolve),
    ).toBeNull();
    // A draw is not a board change, and this feed has `drawCard` for it.
    expect(
      describeEvent({ type: 'zoneChange', instanceId: 11, from: 'library', to: 'hand' }, resolve),
    ).toBeNull();
  });
});
