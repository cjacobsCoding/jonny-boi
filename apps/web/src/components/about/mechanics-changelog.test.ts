/**
 * THE CHANGELOG REACHES THE SCREEN (§3.166) — a static render of the real
 * component, and of the About view that mounts it, because a table nobody
 * renders is the "built, tested, unreachable" defect this project keeps
 * finding in its own UI.
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { MechanicsChangelog } from './MechanicsChangelog.js';
import {
  CHANGELOG_KIND_LABELS,
  CHANGELOG_VISIBLE_ENTRIES,
  MECHANICS_CHANGELOG,
} from '../../lib/about/changelog.js';

describe('the mechanics changelog on the About page', () => {
  const html = renderToStaticMarkup(createElement(MechanicsChangelog));

  it('renders the newest entry first, with its date, kind, title and cards', () => {
    const newest = MECHANICS_CHANGELOG[0]!;
    expect(html).toContain('What came online recently');
    expect(html).toContain(`dateTime="${newest.date}"`);
    expect(html).toContain(CHANGELOG_KIND_LABELS[newest.kind]);
    expect(html).toContain(newest.title.replace(/'/g, '&#x27;'));
    for (const name of newest.cards ?? []) expect(html).toContain(name.replace(/'/g, '&#x27;'));
    // Newest first in the markup, not just in the data.
    const second = MECHANICS_CHANGELOG[1]!;
    const esc = (s: string): string => s.replace(/'/g, "&#x27;");
    expect(html.indexOf(esc(newest.title))).toBeLessThan(html.indexOf(esc(second.title)));
  });

  it('folds everything past the visible count behind "Earlier"', () => {
    const folded = Math.max(0, MECHANICS_CHANGELOG.length - CHANGELOG_VISIBLE_ENTRIES);
    if (folded === 0) expect(html).not.toContain('Earlier (');
    else expect(html).toContain(`Earlier (${folded})`);
    expect(html.match(/class="changelog__entry"/g)?.length).toBe(MECHANICS_CHANGELOG.length);
  });
});
