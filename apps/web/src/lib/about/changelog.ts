/**
 * WHAT CAME ONLINE, AND WHEN — the in-app changelog of mechanics (DESIGN §3.166).
 *
 * > "an in-app changelog of mechanics coming online"
 *
 * The About page's "Supported today" list says what the engine plays; it does
 * not say what changed since the last time he looked. This table does, newest
 * first, in his words where the work was his request. It is DATA, and it is
 * GUARDED the way the supported list is:
 *
 *  - every entry names the DESIGN.md roadmap section it reports, and the test
 *    reads DESIGN.md: the heading must exist and be marked ✅ done, and every ✅
 *    section from {@link CHANGELOG_FLOOR_SECTION} onward must have an entry —
 *    so a mechanic can neither be claimed here before it shipped nor ship
 *    without being announced;
 *  - every card an entry names must be in the shipped pool (the test turns each
 *    name into a `card` witness), so "Heliod plays now" cannot outlive Heliod;
 *  - a `mechanic` entry carries a {@link MechanicWitness} that must still
 *    resolve, exactly as a "Supported today" claim does.
 *
 * ⚠️ No pool SIZES here (`pool-size-claims.test.ts`): a delta ("+12 cards") is
 * true forever; a total is false after the next regeneration.
 */
import type { MechanicWitness } from './mechanics.js';

/**
 * The first roadmap section the changelog covers. Sections before it predate
 * the request; from here on, every ✅ section has a row (enforced by the test).
 */
export const CHANGELOG_FLOOR_SECTION = 155;

/**
 * How many entries the About page shows before folding the rest behind
 * "earlier". The page is a reading, not an archive.
 */
export const CHANGELOG_VISIBLE_ENTRIES = 8;

/**
 * What kind of change an entry reports — a CLOSED set, so the page can render
 * each with the right emphasis and the test can demand the right proof:
 *  - `mechanic` — the engine plays something it did not; needs a witness.
 *  - `fix`      — a rule the engine already claimed, now played correctly.
 *  - `app`      — the lab itself (a screen, a flow), not the rules.
 *  - `data`     — the shipped card pool moved.
 */
export type ChangelogKind = 'mechanic' | 'fix' | 'app' | 'data';

interface ChangelogEntryBase {
  /** The DESIGN.md §3 section number, e.g. `'3.163'`. */
  readonly section: string;
  /** ISO date the section landed on `main`. */
  readonly date: string;
  readonly title: string;
  /** One or two sentences, for him — what he can now do, not how it was built. */
  readonly summary: string;
  /** Cards this brought online; each must be in the shipped pool. */
  readonly cards?: readonly string[];
}

export type ChangelogEntry =
  | (ChangelogEntryBase & { readonly kind: 'mechanic'; readonly witness: MechanicWitness })
  | (ChangelogEntryBase & {
      readonly kind: 'fix' | 'app' | 'data';
      readonly witness?: MechanicWitness;
    });

/**
 * Newest first. Add a row when a roadmap section flips to ✅ — the test will
 * tell you which one you forgot.
 */
export const MECHANICS_CHANGELOG: readonly ChangelogEntry[] = [
  {
    section: '3.169',
    date: '2026-09-19',
    kind: 'mechanic',
    title: '"As long as …" — conditional static abilities',
    summary:
      'Threshold, delirium, metalcraft, "as long as it’s equipped", "as long as it’s attacking", fateful hour: a static that switches on and off with the game now does — Krosan Beast is a 1/1 until the seventh card hits your graveyard and an 8/8 the moment it does. 123 more cards play as printed.',
    cards: [
      'Krosan Beast',
      'Grim Flayer',
      'Skyhunter Cub',
      'Indomitable Archangel',
      'Gavony Ironwright',
    ],
    witness: { kind: 'rule', id: 'static-self-modification' },
  },
  {
    section: '3.168',
    date: '2026-09-19',
    kind: 'mechanic',
    title: '"Activate only once each turn"',
    summary:
      'Mindful Biomancer, Frilled Oculus, Twinblade Slasher, Sepulcher Ghoul and 27 more once-a-turn abilities play as printed: the second activation in a turn is simply not offered, and the memory belongs to that permanent on that turn.',
    cards: ['Mindful Biomancer', 'Frilled Oculus', 'Twinblade Slasher', 'Sepulcher Ghoul'],
    witness: { kind: 'card', name: 'Frilled Oculus' },
  },
  {
    section: '3.167',
    date: '2026-09-19',
    kind: 'app',
    title: 'Every card Scryfall knows, in the app',
    summary:
      'The card browser and deck builder now hold the whole of Magic — not just the cards the engine plays. A card the engine cannot play yet wears "Not playable yet", its detail view says what it needs, and a deck holding one cannot be started in Play or tested in the Lab until it is swapped out.',
  },
  {
    section: '3.166',
    date: '2026-09-19',
    kind: 'app',
    title: 'This list',
    summary:
      'What came online, newest first, on the About page — every row is a shipped roadmap section, every card it names is in the pool, and a section that ships without a row here fails the build.',
  },
  {
    section: '3.165',
    date: '2026-09-19',
    kind: 'app',
    title: 'The Lab’s A/B pickers: type to find one card',
    summary:
      'Both card selectors in Lab → A/B Swap Test are now type-to-filter boxes with the card browser’s colour and type chips and a mana-value range. The copies menu only offers what the cut card’s line can give (a 1-of has one choice), and "Apply to my deck" now says "✓ Applied" once it has.',
  },
  {
    section: '3.164',
    date: '2026-09-19',
    kind: 'mechanic',
    title: 'Mana abilities the board sizes — and Selvala’s parley',
    summary:
      'Gaea’s Cradle, Axebane Guardian, Karametra’s Acolyte, Priest of Titania and their family add as much as the board says; Axebane splits it across colours. Selvala, Explorer Returned reveals, pays you green and life per nonland, and everyone draws. Both of your decks are now fully supported by the engine.',
    cards: ['Selvala, Explorer Returned', 'Axebane Guardian', "Gaea's Cradle", 'Priest of Titania'],
    witness: { kind: 'rule', id: 'mana-ability-parley' },
  },
  {
    section: '3.163',
    date: '2026-09-19',
    kind: 'mechanic',
    title: 'Devotion, and the Theros gods',
    summary:
      'Heliod, Sun-Crowned plays as printed: an enchantment until your devotion to white reaches five, a 5/5 indestructible creature from the fifth pip — and its lifegain counters land on it either way. "Where X is your devotion to <colour>" counts too, for every colour.',
    cards: [
      'Heliod, Sun-Crowned',
      'Heliod, God of the Sun',
      'Thassa, God of the Sea',
      'Nylea, God of the Hunt',
    ],
    witness: { kind: 'rule', id: 'god-creature-unless-devotion' },
  },
  {
    section: '3.162',
    date: '2026-09-19',
    kind: 'mechanic',
    title: "Thune's Life, revised at your request",
    summary:
      'Skyclave Apparition, Tyvar\'s Stand, Spike Feeder and Voice of the Blessed play whole — "remove a counter" costs, "gains X until end of turn" keyword lists, the token left behind by an Apparition, and counter-threshold keywords. Two of each were added to your deck for you, with a note in Deck Builder; the deck itself is never rewritten.',
    cards: ['Skyclave Apparition', "Tyvar's Stand", 'Spike Feeder', 'Voice of the Blessed'],
    witness: { kind: 'primitive', id: 'tokenForExiledByThis' },
  },
  {
    section: '3.161',
    date: '2026-09-18',
    kind: 'mechanic',
    title: "Jace, Architect of Thought's −8",
    summary:
      'The last piece of the Tamiyo + Jace Surge deck: a search of BOTH libraries whose exiled cards you may cast for free — a cast permission that belongs to the other seat. Tamiyo + Jace Surge plays end to end.',
    cards: ['Jace, Architect of Thought', 'Tamiyo, the Moon Sage'],
    witness: { kind: 'engine', api: 'castPermissionFor' },
  },
  {
    section: '3.160',
    date: '2026-09-18',
    kind: 'data',
    title: 'The card pool caught up with the engine',
    summary:
      'The shipped pool had not been regenerated since before Tamiyo, Craterhoof Behemoth and Primal Surge compiled. +98 cards, three of them yours.',
    cards: ['Tamiyo, the Moon Sage', 'Craterhoof Behemoth', 'Primal Surge'],
  },
  {
    section: '3.159',
    date: '2026-09-17',
    kind: 'fix',
    title: 'Combat damage past lethal is no longer thrown away',
    summary:
      'A blocked attacker assigned exactly lethal to each blocker and dropped the rest — so a 100-power lifelinker gained 1 from a Llanowar Elves. Every point is assigned now, and lifelink sees all of it.',
  },
  {
    section: '3.158',
    date: '2026-09-17',
    kind: 'app',
    title: 'A deck with unsupported cards is clearly marked, and cannot be played or tested',
    summary:
      'One question — "can this deck be played?" — had four answers. Now there is one: a deck that holds a card the engine cannot play yet says so by name, and Play and the Lab refuse it until the card comes online.',
  },
  {
    section: '3.157',
    date: '2026-09-16',
    kind: 'app',
    title: 'One collection of decks, all of them editable',
    summary:
      '"Your paper decks" and "Your decks" were two collections, one read-only. They are one now, every deck is yours to edit, and the 59-card Acidic Angels is gone.',
  },
  {
    section: '3.156',
    date: '2026-09-16',
    kind: 'mechanic',
    title: '"Repeat this process" — iterative effects',
    summary:
      'Primal Surge and its family: an effect that repeats until a stated card stops it, with the cards it reveals put where the card says.',
    cards: ['Primal Surge'],
    witness: { kind: 'card', name: 'Primal Surge' },
  },
  {
    section: '3.155',
    date: '2026-09-16',
    kind: 'mechanic',
    title: 'Team pumps until end of turn — Craterhoof Behemoth',
    summary:
      '"Creatures you control gain trample and get +X/+X until end of turn, where X is the number of creatures you control" — the mass, team-wide modification the compiler had no template for.',
    cards: ['Craterhoof Behemoth'],
    witness: { kind: 'card', name: 'Craterhoof Behemoth' },
  },
];

/** The entries the page shows first, and the ones it folds. */
export function splitChangelog(entries: readonly ChangelogEntry[] = MECHANICS_CHANGELOG): {
  readonly recent: readonly ChangelogEntry[];
  readonly earlier: readonly ChangelogEntry[];
} {
  return {
    recent: entries.slice(0, CHANGELOG_VISIBLE_ENTRIES),
    earlier: entries.slice(CHANGELOG_VISIBLE_ENTRIES),
  };
}

/** The user-facing word for a kind — one table, read by the page and its test. */
export const CHANGELOG_KIND_LABELS: Readonly<Record<ChangelogKind, string>> = {
  mechanic: 'New mechanic',
  fix: 'Rules fix',
  app: 'The lab',
  data: 'Card pool',
};

/** The section number as it reads in DESIGN.md's heading. */
export function sectionHeadingPrefix(entry: ChangelogEntry): string {
  return `### ${entry.section} `;
}
