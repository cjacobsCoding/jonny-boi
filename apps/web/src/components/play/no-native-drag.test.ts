/**
 * NO CARD IMAGE MAY BE NATIVELY DRAGGABLE — the land-play killer (§3.54).
 *
 * Bug reports 20260827_205353 + 205443: pressing a hand card and moving a few
 * pixels started a BROWSER image-drag (an <img> is draggable by default). The
 * native drag cancels the pointer stream — our drag machine never commits — and
 * swallows the mouseup, so the click never fires either. Result: no way to play
 * a land by click OR drag, i.e. no way to advance the game at all. The
 * reporter’s clip shows three mousedowns on a card with no mouseup ever
 * recorded — the native drag ate them.
 *
 * Synthetic pointer tests CANNOT catch this (dispatched events never start a
 * native drag), which is why this is pinned STRUCTURALLY: render the real
 * component both ways and require draggable="false" on every image. If someone
 * adds a new <img> to a card face without the attribute, this fails.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { PlayCard, CardBack } from "./PlayCard.js";
import { CARD_POOL } from "@jonny-boi/cards";

const REAL = CARD_POOL.find((c) => c.name === "Forest")!;

function imgsOf(html: string): string[] {
  return html.match(/<img\b[^>]*>/g) ?? [];
}

describe("card images are never natively draggable", () => {
  it("the full-face card (the hand) pins draggable=false on its image", () => {
    const html = renderToStaticMarkup(
      createElement(PlayCard, { cardId: REAL.id, name: REAL.name, face: "full", onClick: () => {} }),
    );
    const imgs = imgsOf(html);
    expect(imgs.length, "the full face must actually render an image").toBeGreaterThan(0);
    for (const img of imgs) expect(img).toContain(`draggable="false"`);
  });

  it("the chip face pins it too", () => {
    const html = renderToStaticMarkup(
      createElement(PlayCard, { cardId: REAL.id, name: REAL.name, onClick: () => {} }),
    );
    for (const img of imgsOf(html)) expect(img).toContain(`draggable="false"`);
  });

  it("a card back renders no draggable image either", () => {
    const html = renderToStaticMarkup(createElement(CardBack, { index: 0 }));
    for (const img of imgsOf(html)) expect(img).toContain(`draggable="false"`);
  });
});
