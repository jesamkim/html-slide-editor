import { describe, expect, it } from "vitest";
import {
  INVALID_MISSING_STAGE,
  INVALID_NO_SLIDES,
  VALID_CASCADE_IMPORTANT_DECK,
  VALID_CASCADE_SPECIFICITY_DECK,
  VALID_DISABLED_STYLE_DECK,
  VALID_FALLBACK_DECK,
  VALID_INLINE_DIMENSIONS_DECK,
  VALID_INLINE_PRIORITY_DECK,
  VALID_INVALID_INLINE_DIMENSIONS_DECK,
  VALID_INVALID_STYLESHEET_DIMENSIONS_DECK,
  VALID_MINIMAL_DECK,
  VALID_PRINT_STYLE_DECK,
  VALID_SOURCE_ORDER_DECK,
  VALID_STYLESHEET_DECK,
  VALID_ZERO_DIMENSIONS_DECK,
} from "../../test/minimalDeck";
import { parseDeckHtml } from "./parseDeck";

describe("parseDeckHtml", () => {
  it("reads inline stage dimensions", () => {
    const result = parseDeckHtml(VALID_INLINE_DIMENSIONS_DECK, "inline.html");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.metadata.stageSize).toEqual({ width: 1440, height: 810 });
  });

  it("reads stage dimensions from a same-document stylesheet", () => {
    const result = parseDeckHtml(VALID_STYLESHEET_DECK, "styled.html");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.metadata.stageSize).toEqual({ width: 1600, height: 900 });
  });

  it("prefers a more specific earlier rule over a later generic rule", () => {
    const result = parseDeckHtml(VALID_CASCADE_SPECIFICITY_DECK, "specificity.html");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.metadata.stageSize).toEqual({ width: 1600, height: 900 });
  });

  it("prefers important declarations over later non-important declarations", () => {
    const result = parseDeckHtml(VALID_CASCADE_IMPORTANT_DECK, "important.html");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.metadata.stageSize).toEqual({ width: 1280, height: 720 });
  });

  it("uses source order when importance and specificity are equal", () => {
    const result = parseDeckHtml(VALID_SOURCE_ORDER_DECK, "source-order.html");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.metadata.stageSize).toEqual({ width: 1280, height: 720 });
  });

  it("preserves the task contract that valid inline pixels win first", () => {
    const result = parseDeckHtml(VALID_INLINE_PRIORITY_DECK, "inline-priority.html");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.metadata.stageSize).toEqual({ width: 1440, height: 810 });
  });

  it("ignores print-only style elements for desktop stage dimensions", () => {
    const result = parseDeckHtml(VALID_PRINT_STYLE_DECK, "print.html");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.metadata.stageSize).toEqual({ width: 1600, height: 900 });
  });

  it("ignores disabled style elements", () => {
    const result = parseDeckHtml(VALID_DISABLED_STYLE_DECK, "disabled.html");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.metadata.stageSize).toEqual({ width: 1600, height: 900 });
  });

  it("falls through invalid inline dimensions to stylesheet pixels", () => {
    const result = parseDeckHtml(VALID_INVALID_INLINE_DIMENSIONS_DECK, "inline-units.html");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.metadata.stageSize).toEqual({ width: 1600, height: 900 });
  });

  it("falls through invalid stylesheet dimensions to the html-slide fallback", () => {
    const result = parseDeckHtml(
      VALID_INVALID_STYLESHEET_DIMENSIONS_DECK,
      "stylesheet-units.html",
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.metadata.stageSize).toEqual({ width: 1920, height: 1080 });
  });

  it("accepts unitless zero dimensions", () => {
    const result = parseDeckHtml(VALID_ZERO_DIMENSIONS_DECK, "zero.html");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.metadata.stageSize).toEqual({ width: 0, height: 0 });
  });

  it("uses the html-slide stage size when dimensions are absent", () => {
    const result = parseDeckHtml(VALID_FALLBACK_DECK, "fallback.html");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.metadata.stageSize).toEqual({ width: 1920, height: 1080 });
  });

  it("extracts deck and slide metadata", () => {
    const result = parseDeckHtml(VALID_MINIMAL_DECK, "deck.html");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.metadata).toMatchObject({
      fileName: "deck.html",
      title: "Minimal Deck",
      slideCount: 2,
      slides: [
        { id: "slide-1", index: 0, sourceId: "intro", label: "Introduction" },
        { id: "slide-2", index: 1, sourceId: null, label: "Slide 2" },
      ],
    });
  });

  it("rejects a document without a stage", () => {
    expect(parseDeckHtml(INVALID_MISSING_STAGE, "bad.html")).toMatchObject({
      ok: false,
      code: "MISSING_STAGE",
    });
  });

  it("rejects a stage whose slides are nested below an intermediate wrapper", () => {
    expect(parseDeckHtml(INVALID_NO_SLIDES, "bad.html")).toMatchObject({
      ok: false,
      code: "NO_SLIDES",
    });
  });
});
