/**
 * Does `inOnly` actually pin the IN side of every candidate? The plan for
 * Caleb's item 5 claims it does, from a grep and a read. This turns that into a
 * measurement before a lane builds on it.
 *
 * Pure enumeration — generateCandidates plays no games, so this is instant.
 *
 * ⚠️ RUN `npm run build` FIRST — this imports the packages' built output, so in
 * a fresh worktree it fails with a module-resolution error that has nothing to
 * do with what it measures.
 *
 * A Deck is { name, archetype, cards: DeckEntry[] } where a DeckEntry is
 * { cardId, count } — NOT a list of card definitions. The first attempt passed
 * definitions and got 0 candidates AND 0 skips, which is what an empty
 * `copiesByCard` looks like: a shape error reads exactly like "nothing to
 * suggest", which is why the skip list is printed here too. A candidate's
 * fields are `inName`/`outName`/`inId`/`outId` — there is no `swap` object.
 *
 * MEASURED 2026-09-20 on the pool at a0aae5e:
 *   unrestricted : candidates = 15628, skipped = 15610, distinct IN = 7810
 *   inOnly       : candidates = 2,     skipped = 2,     distinct IN = 1
 *   inOnly IN set: [ 'Sol Ring' ]
 *   inOnly OUT set: Grizzly Bears, Lightning Bolt
 * So the engine already answers "what would I cut to fit THIS card in". Only
 * the CLI and the Lab cannot ask it.
 */
import { generateCandidates } from '@jonny-boi/sim';
import { loadCardPool } from '@jonny-boi/cards';

const pool = loadCardPool({ onWarn: () => {} });
const byName = new Map(pool.cards.map((c) => [c.name, c]));
const byId = new Map(pool.cards.map((c) => [c.id, c]));

const entry = (name, count) => {
  if (!byName.has(name)) throw new Error(`not in pool: ${name}`);
  return { cardId: byName.get(name).id, count, name };
};

const hero = {
  name: 'inOnly probe',
  archetype: 'probe',
  cards: [entry('Mountain', 24), entry('Lightning Bolt', 4), entry('Grizzly Bears', 4), entry('Forest', 28)],
};

const TARGET = 'Sol Ring';
if (!byName.has(TARGET)) throw new Error(`${TARGET} is not in the pool — pick another probe card`);

const free = generateCandidates(hero, pool);
const pinned = generateCandidates(hero, pool, undefined, undefined, undefined, { inOnly: [TARGET] });


const inNames = (r) => new Set(r.candidates.map((c) => c.inName));
const outNames = (r) => new Set(r.candidates.map((c) => c.outName));

console.log('unrestricted : candidates =', free.candidates.length, ', skipped =', free.skipped.length, ', distinct IN =', inNames(free).size);
console.log('inOnly       : candidates =', pinned.candidates.length, ', skipped =', pinned.skipped.length, ', distinct IN =', inNames(pinned).size);
console.log('inOnly IN set:', [...inNames(pinned)]);
console.log('inOnly OUT set (what it would cut):', [...outNames(pinned)].sort().join(', '));

const ok =
  free.candidates.length > 0 &&
  pinned.candidates.length > 0 &&
  pinned.candidates.length < free.candidates.length &&
  inNames(pinned).size === 1 &&
  [...inNames(pinned)][0] === TARGET &&
  outNames(pinned).size > 1;
console.log(ok ? 'VERDICT: inOnly pins the IN and varies the OUT — item 5 is an EXPOSURE, not an engine feature' : 'VERDICT: NOT CONFIRMED');
