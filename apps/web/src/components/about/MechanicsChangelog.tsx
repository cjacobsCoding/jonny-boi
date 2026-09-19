/**
 * WHAT CAME ONLINE — the About page's changelog of mechanics (DESIGN §3.166).
 *
 * Renders {@link MECHANICS_CHANGELOG} newest first: the date, what KIND of change
 * it was, the words for him, and the cards it brought online as chips. The
 * newest {@link CHANGELOG_VISIBLE_ENTRIES} are open; the rest fold behind
 * "Earlier". Nothing here is prose the page invents — every row is data that
 * `lib/about/changelog.test.ts` holds to DESIGN.md and to the shipped pool.
 */
import type { ReactElement } from 'react';
import {
  CHANGELOG_KIND_LABELS,
  MECHANICS_CHANGELOG,
  splitChangelog,
  type ChangelogEntry,
} from '../../lib/about/changelog.js';

function Entry({ entry }: { readonly entry: ChangelogEntry }): ReactElement {
  return (
    <li className="changelog__entry">
      <div className="changelog__when">
        <time className="changelog__date" dateTime={entry.date}>
          {entry.date}
        </time>
        <span className={`changelog__kind changelog__kind--${entry.kind}`}>
          {CHANGELOG_KIND_LABELS[entry.kind]}
        </span>
      </div>
      <div className="changelog__body">
        <h4>
          {entry.title}
          <span className="changelog__section" title="The roadmap section in DESIGN.md">
            §{entry.section}
          </span>
        </h4>
        <p>{entry.summary}</p>
        {entry.cards && entry.cards.length > 0 && (
          <ul className="about__chips changelog__cards" aria-label="Cards this brought online">
            {entry.cards.map((name) => (
              <li key={name} className="about__chip">
                {name}
              </li>
            ))}
          </ul>
        )}
      </div>
    </li>
  );
}

export function MechanicsChangelog(): ReactElement {
  const { recent, earlier } = splitChangelog(MECHANICS_CHANGELOG);
  return (
    <section aria-labelledby="changelog-title">
      <h3 id="changelog-title" className="about__heading">
        What came online recently
      </h3>
      <p className="about__fine-print">
        Newest first. Each row is a shipped roadmap section; a card named here is in the pool, or
        the build fails.
      </p>
      <ol className="changelog">
        {recent.map((entry) => (
          <Entry key={entry.section} entry={entry} />
        ))}
      </ol>
      {earlier.length > 0 && (
        <details className="changelog__earlier">
          <summary>Earlier ({earlier.length})</summary>
          <ol className="changelog">
            {earlier.map((entry) => (
              <Entry key={entry.section} entry={entry} />
            ))}
          </ol>
        </details>
      )}
    </section>
  );
}
