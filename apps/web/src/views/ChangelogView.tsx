/**
 * "What's New" — the shipped-feature list, read from the bundled changelog.
 *
 * The list is DERIVED from `CHANGELOG.md` at build time (see
 * `scripts/build-changelog.mjs`) and guarded by `data/changelog.test.ts`, so
 * this view only has to render: there is no second list to keep in sync, and no
 * runtime fetch, so it works offline like the rest of the shell.
 *
 * The body text is authored markdown, but pulling in a markdown renderer for
 * bold and paragraphs would be a dependency for two features. `**bold**` and
 * blank-line paragraphs are handled inline; anything else renders as its own
 * literal text, which is the safe direction to fail.
 */

import type { ReactElement, ReactNode } from 'react';
import entries from '../data/changelog.json';

/** One release note, as derived from CHANGELOG.md. */
interface ChangelogEntry {
  readonly date: string;
  readonly title: string;
  readonly roadmap?: string;
  readonly body: string;
}

/** Render `**bold**` runs; everything else is literal text. */
function withEmphasis(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
    part.startsWith('**') && part.endsWith('**') && part.length > 4 ? (
      <strong key={i}>{part.slice(2, -2)}</strong>
    ) : (
      part
    ),
  );
}

/**
 * A changelog body as paragraphs.
 *
 * Single newlines are the source file's wrapping, not the author's intent, so
 * they collapse to spaces; a blank line starts a new paragraph.
 */
function Body({ text }: { text: string }): ReactElement {
  const paragraphs = text.split(/\n\s*\n/).map((p) => p.replace(/\s*\n\s*/g, ' ').trim());
  return (
    <>
      {paragraphs.filter(Boolean).map((paragraph, i) => (
        <p key={i} className="changelog__body">
          {withEmphasis(paragraph)}
        </p>
      ))}
    </>
  );
}

/** Dates are authored as `YYYY-MM-DD`; show them the way a person reads one. */
function formatDate(iso: string): string {
  const [year, month, day] = iso.split('-').map(Number);
  if (!year || !month || !day) return iso;
  // Construct in UTC: a local-time Date on a `YYYY-MM-DD` string shifts the day
  // backwards for anyone west of UTC, so entries would show the wrong date.
  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

export function ChangelogView(): ReactElement {
  const notes = entries as readonly ChangelogEntry[];

  return (
    <section className="changelog">
      <header className="changelog__header">
        <h2>What&rsquo;s new</h2>
        <p className="changelog__intro">
          Every feature that is actually in this build, newest first. Generated from the
          repository&rsquo;s changelog and checked by the test suite, so it cannot drift from what
          shipped.
        </p>
      </header>

      {notes.length === 0 ? (
        <p className="changelog__empty">No entries yet.</p>
      ) : (
        <ol className="changelog__list">
          {notes.map((entry) => (
            <li key={`${entry.date}-${entry.title}`} className="changelog__entry">
              <div className="changelog__meta">
                <time dateTime={entry.date}>{formatDate(entry.date)}</time>
                {entry.roadmap && (
                  <span className="changelog__tag" title="Roadmap section in DESIGN.md">
                    §{entry.roadmap}
                  </span>
                )}
              </div>
              <h3 className="changelog__title">{entry.title}</h3>
              <Body text={entry.body} />
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
