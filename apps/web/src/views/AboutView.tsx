import { useEffect, useMemo, useReducer, useState, type ReactElement } from 'react';
import {
  SUPPORTED_MECHANIC_GROUPS,
  compilerRuleGroups,
  mechanicsSummary,
  stubbedPoolCards,
  supportedKeywords,
  todoMechanics,
} from '../lib/about/mechanics.js';
import {
  clearUnsupportedMechanics,
  formatUnsupportedReport,
  subscribeToUnsupportedMechanics,
  unsupportedMechanics,
} from '../lib/cards/unsupportedRegistry.js';
import { copyText } from '../lib/clipboard.js';
import { EffectsPreview } from '../components/play/EffectsPreview.js';
import './about.css';

/** How long the copy button's success/failure notice stays up. */
const COPY_NOTICE_MILLIS = 2500;

/**
 * The About view: a live reading of which MTG mechanics the engine plays today
 * and which are still on the TODO list.
 *
 * Nothing on this page is a prose snapshot. The supported list is pinned by
 * witnesses in `lib/about/mechanics.test.ts`; the keyword set, the compiler
 * templates and the whole TODO section render straight from the registries the
 * import pipeline itself runs on; and the "gaps you've hit" panel subscribes to
 * the same per-browser queue the Cards view fills. Land a mechanic and this
 * page already says so.
 */
export function AboutView(): ReactElement {
  // Re-render whenever the per-browser unsupported queue changes (a card added
  // in the Cards view while this page is open shows up here immediately).
  const [queueVersion, bumpQueueVersion] = useReducer((v: number) => v + 1, 0);
  useEffect(() => subscribeToUnsupportedMechanics(bumpQueueVersion), []);
  const hitGaps = useMemo(() => {
    // The version is the real dependency: the registry mutates in place, so the
    // memo must recompute exactly when the subscription bumps it.
    void queueVersion;
    return unsupportedMechanics();
  }, [queueVersion]);

  const [copyNotice, setCopyNotice] = useState<'copied' | 'failed' | null>(null);
  useEffect(() => {
    if (copyNotice === null) return;
    const timer = setTimeout(() => setCopyNotice(null), COPY_NOTICE_MILLIS);
    return () => clearTimeout(timer);
  }, [copyNotice]);

  const summary = mechanicsSummary();
  const todo = todoMechanics();
  const stubs = stubbedPoolCards();

  return (
    <section className="about" aria-labelledby="about-title">
      <header className="about__intro">
        <h2 id="about-title">About this lab</h2>
        <p>
          <strong>jonny-boi</strong> is a Magic: The Gathering deck-tuning lab: AI pilots play your
          deck hundreds of games against a meta gauntlet, and single-card swaps get a
          statistically-tested verdict. That only works if every card in a sim plays{' '}
          <em>exactly as printed</em> — so the engine never approximates. A card either compiles to
          a fully-implemented definition, or it is honestly reported as blocked on a named engine
          system. This page is the live reading of where that line sits right now.
        </p>
      </header>

      <dl className="about__summary" aria-label="Engine coverage at a glance">
        <div className="about__stat">
          <dt>Cards playable as printed</dt>
          <dd>{summary.poolCards}</dd>
        </div>
        <div className="about__stat">
          <dt>Import templates recognized</dt>
          <dd>{summary.compilerRules}</dd>
        </div>
        <div className="about__stat">
          <dt>Keywords enforced</dt>
          <dd>{summary.keywords}</dd>
        </div>
        <div className="about__stat">
          <dt>Effect primitives</dt>
          <dd>{summary.primitives}</dd>
        </div>
        <div className="about__stat about__stat--todo">
          <dt>Engine systems still missing</dt>
          <dd>{summary.missingSystems}</dd>
        </div>
        <div className="about__stat about__stat--todo">
          <dt>Template gaps</dt>
          <dd>{summary.templateGaps}</dd>
        </div>
      </dl>

      <h3 className="about__heading">Supported today</h3>
      <div className="about__groups">
        {SUPPORTED_MECHANIC_GROUPS.map((group) => (
          <article key={group.title} className="about__card">
            <h4>{group.title}</h4>
            <ul className="about__mechanics">
              {group.mechanics.map((mechanic) => (
                <li key={mechanic.title}>
                  <strong>{mechanic.title}.</strong> {mechanic.detail}
                </li>
              ))}
            </ul>
          </article>
        ))}
      </div>

      <article className="about__card">
        <h4>Keywords the engine enforces</h4>
        <ul className="about__chips" aria-label="Supported keywords">
          {supportedKeywords().map((keyword) => (
            <li key={keyword} className="about__chip">
              {keyword}
            </li>
          ))}
        </ul>
      </article>

      <details className="about__card about__details">
        <summary>
          Every printed template the card importer recognizes ({summary.compilerRules})
        </summary>
        <p className="about__fine-print">
          A card imports as playable only when <em>every</em> line of its rules text matches one of
          these. This list renders from the compiler&rsquo;s own rule tables, so it is always
          current.
        </p>
        {compilerRuleGroups().map((group) => (
          <div key={group.title}>
            <h5>
              {group.title} ({group.rules.length})
            </h5>
            <ul className="about__templates">
              {group.rules.map((rule) => (
                <li key={rule.id}>{rule.description}</li>
              ))}
            </ul>
          </div>
        ))}
      </details>

      <h3 className="about__heading">Still to do</h3>
      <div className="about__groups">
        <article className="about__card">
          <h4>Missing engine systems ({todo.systems.length})</h4>
          <p className="about__fine-print">
            Real subsystems nobody has built yet. Each one, once implemented, unblocks every card
            waiting on it — this is the engine&rsquo;s work queue, straight from the compiler.
          </p>
          <ul className="about__mechanics about__mechanics--todo">
            {todo.systems.map((system) => (
              <li key={system}>{system}</li>
            ))}
          </ul>
        </article>

        <article className="about__card">
          <h4>Curated-pool cards still waiting ({stubs.length})</h4>
          {/*
            The list reached ZERO, so the empty state is a real claim rather than
            a blank panel: every hand-authored card now plays as printed. It is
            still rendered (not hidden) because "nothing is waiting" is exactly
            the fact a reader of this page came to check.
          */}
          {stubs.length === 0 ? (
            <p className="about__fine-print">
              None. Every card in the curated pool now plays as printed — each one reproduced
              exactly from its real Oracle text, with no approximations left to declare.
            </p>
          ) : (
            <>
              <p className="about__fine-print">
                Famous cards the pool deliberately keeps un-playable rather than approximate — each
                named with the system it is waiting for.
              </p>
              <ul className="about__mechanics about__mechanics--todo">
                {stubs.map((stub) => (
                  <li key={stub.card}>
                    <strong>{stub.card}.</strong> {stub.missingEngineSystem}
                  </li>
                ))}
              </ul>
            </>
          )}
        </article>
      </div>

      <details className="about__card about__details">
        <summary>Template gaps — playable by the engine, unreadable by the importer ({todo.templateGaps.length})</summary>
        <p className="about__fine-print">
          The engine could play these, but no compiler rule reads the printed wording yet — usually
          one rule-table entry of work each, much cheaper than a missing system.
        </p>
        <ul className="about__templates">
          {todo.templateGaps.map((gap) => (
            <li key={gap}>{gap}</li>
          ))}
        </ul>
      </details>

      <article className="about__card">
        <h4>Gaps you&rsquo;ve hit in this browser ({hitGaps.length})</h4>
        {hitGaps.length === 0 ? (
          <p className="about__fine-print">
            None yet — every card you&rsquo;ve added compiled as fully playable. When an import
            needs a missing system it is recorded here, grouped by the system that would unblock
            it.
          </p>
        ) : (
          <>
            <p className="about__fine-print">
              Real demand, from the cards you actually tried to add — the most useful ranking of
              what to build next.
            </p>
            <ul className="about__mechanics about__mechanics--todo">
              {hitGaps.map((gap) => (
                <li key={gap.system}>
                  <strong>{gap.system}.</strong> Blocks {gap.cards.length} card
                  {gap.cards.length === 1 ? '' : 's'}: {gap.cards.join(', ')}
                </li>
              ))}
            </ul>
            <div className="about__actions">
              <button
                type="button"
                className="btn"
                onClick={() => {
                  void copyText(formatUnsupportedReport(hitGaps)).then((ok) =>
                    setCopyNotice(ok ? 'copied' : 'failed'),
                  );
                }}
              >
                Copy as Markdown report
              </button>
              <button type="button" className="btn btn--ghost" onClick={() => clearUnsupportedMechanics()}>
                Clear the queue
              </button>
              {copyNotice === 'copied' && <span role="status">Copied.</span>}
              {copyNotice === 'failed' && (
                <span role="status">Copy failed — clipboard unavailable.</span>
              )}
            </div>
          </>
        )}
      </article>

      <EffectsPreview />
    </section>
  );
}
