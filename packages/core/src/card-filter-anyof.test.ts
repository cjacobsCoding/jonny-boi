/**
 * CardFilter.anyOf — the disjunction (§3.55).
 *
 * Printed search lines disjoin over DIFFERENT characteristics ("a basic land
 * card or a Gate card"), which no conjunction of the other fields can express:
 * the old encoding intersected to the empty set and the search silently found
 * nothing. These pin the semantics: match-any across branches, still ANDed
 * with sibling fields, absent list = unchanged behaviour.
 */
import { describe, expect, it } from "vitest";
import { matchesCardFilter } from "./card.js";
import type { CardDefinition } from "./card.js";

const FOREST: CardDefinition = { id: "f", name: "Forest", types: ["land"], basic: true, subtypes: ["forest"] };
const GUILDGATE: CardDefinition = { id: "g", name: "Selesnya Guildgate", types: ["land"], subtypes: ["gate"] };
const TEMPLE: CardDefinition = { id: "t", name: "Temple Garden", types: ["land"], subtypes: ["forest", "plains"] };
const BEAR: CardDefinition = { id: "b", name: "Grizzly Bears", types: ["creature"], subtypes: ["bear"], power: 2, toughness: 2 };

const wrap = (def: CardDefinition) => ({ def });
const BASIC_OR_GATE = { anyOf: [{ anyOfTypes: ["land" as const], basic: true }, { anyOfSubtypes: ["gate"] }] };

describe("CardFilter.anyOf", () => {
  it("matches when ANY branch matches — the printed OR", () => {
    expect(matchesCardFilter(wrap(FOREST), BASIC_OR_GATE)).toBe(true); // basic branch
    expect(matchesCardFilter(wrap(GUILDGATE), BASIC_OR_GATE)).toBe(true); // gate branch
  });

  it("rejects what no branch claims — a NONBASIC non-Gate land, the exact trap", () => {
    // Temple Garden has land types galore but is neither basic nor a Gate;
    // a lazy encoding that widened to "any land" would wrongly fetch it.
    expect(matchesCardFilter(wrap(TEMPLE), BASIC_OR_GATE)).toBe(false);
    expect(matchesCardFilter(wrap(BEAR), BASIC_OR_GATE)).toBe(false);
  });

  it("still ANDs with sibling fields on the same filter", () => {
    const gateCreatureOnly = { anyOfTypes: ["creature" as const], anyOf: [{ anyOfSubtypes: ["gate"] }, { anyOfSubtypes: ["bear"] }] };
    expect(matchesCardFilter(wrap(BEAR), gateCreatureOnly)).toBe(true); // creature AND bear-branch
    expect(matchesCardFilter(wrap(GUILDGATE), gateCreatureOnly)).toBe(false); // gate-branch but not a creature
  });

  it("an empty branch list matches nothing rather than everything", () => {
    expect(matchesCardFilter(wrap(FOREST), { anyOf: [] })).toBe(false);
  });
});
