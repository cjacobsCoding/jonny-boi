import { describe, expect, it } from 'vitest';
import { formatDecklist, parseDecklist } from './parseDecklist.js';

describe('parseDecklist', () => {
  it('parses a plain "N Name" line', () => {
    const { cards, errors } = parseDecklist('4 Lightning Bolt');
    expect(errors).toHaveLength(0);
    expect(cards).toEqual([{ name: 'Lightning Bolt', qty: 4 }]);
  });

  it('accepts an "x" suffix after the quantity', () => {
    const { cards } = parseDecklist('1x Sol Ring\n3X Island');
    expect(cards).toEqual([
      { name: 'Sol Ring', qty: 1 },
      { name: 'Island', qty: 3 },
    ]);
  });

  it('defaults quantity to 1 when omitted', () => {
    const { cards } = parseDecklist('Black Lotus');
    expect(cards).toEqual([{ name: 'Black Lotus', qty: 1 }]);
  });

  it('captures a trailing set code in parens and lowercases it', () => {
    const { cards } = parseDecklist('2 Fatal Push (MH2)');
    expect(cards).toEqual([{ name: 'Fatal Push', qty: 2, set: 'mh2' }]);
  });

  it('ignores blank lines and comments', () => {
    const text = ['', '# my deck', '// notes', '  ', '4 Lightning Bolt'].join('\n');
    const { cards, errors } = parseDecklist(text);
    expect(errors).toHaveLength(0);
    expect(cards).toEqual([{ name: 'Lightning Bolt', qty: 4 }]);
  });

  it('skips section headers like "Sideboard" gracefully', () => {
    const text = ['Deck', '4 Lightning Bolt', '', 'Sideboard', '2 Negate'].join('\n');
    const { cards, errors } = parseDecklist(text);
    expect(errors).toHaveLength(0);
    expect(cards).toEqual([
      { name: 'Lightning Bolt', qty: 4 },
      { name: 'Negate', qty: 2 },
    ]);
  });

  it('reports a bare-number line as an error, not a card', () => {
    const { cards, errors } = parseDecklist('4');
    expect(cards).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.line).toBe(1);
  });

  it('handles multi-word names and preserves order', () => {
    const { cards } = parseDecklist('3 Snapcaster Mage\n1 Jace, the Mind Sculptor');
    expect(cards.map((c) => c.name)).toEqual(['Snapcaster Mage', 'Jace, the Mind Sculptor']);
  });

  it('collapses internal whitespace in names', () => {
    const { cards } = parseDecklist('2   Serra   Angel');
    expect(cards[0]!.name).toBe('Serra Angel');
  });

  it('round-trips through formatDecklist', () => {
    const text = '4 Lightning Bolt\n2 Fatal Push (mh2)';
    const { cards } = parseDecklist(text);
    expect(formatDecklist(cards)).toBe(text);
  });
});
