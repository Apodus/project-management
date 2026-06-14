import { describe, it, expect } from "vitest";
import { deriveNotePromotion } from "../src/index.js";

describe("deriveNotePromotion", () => {
  it("short title (≤120, no newline) + no body → verbatim title, no description", () => {
    expect(deriveNotePromotion({ title: "Caching idea", body: null })).toEqual({
      title: "Caching idea",
      description: undefined,
    });
  });

  it("short title + body → verbatim title, body as description", () => {
    expect(
      deriveNotePromotion({ title: "Caching idea", body: "Use an LRU cache." }),
    ).toEqual({
      title: "Caching idea",
      description: "Use an LRU cache.",
    });
  });

  it("long title (>120, no newline) + no body → word-boundary topic ending in …, full title preserved in description", () => {
    const longTitle =
      "The rendering pipeline silently drops the second draw call whenever the depth buffer is cleared mid-frame and this only reproduces on the integrated GPU";
    const { title, description } = deriveNotePromotion({ title: longTitle, body: null });

    expect(title.endsWith("…")).toBe(true);
    expect(title.length).toBeLessThanOrEqual(101);
    // Nothing lost: the FULL original title is the description.
    expect(description).toBe(longTitle);
    expect(description!.endsWith("…")).toBe(false);
  });

  it("long title + body → description is full title + body joined", () => {
    const longTitle = "x".repeat(130);
    const { description } = deriveNotePromotion({ title: longTitle, body: "the body" });
    expect(description).toBe(`${longTitle}\n\nthe body`);
  });

  it("multiline title (first line short) → topic is the first line; full title in description", () => {
    const multiline = "Fix the leak\nMore detail spanning\nmultiple lines of context";
    const { title, description } = deriveNotePromotion({ title: multiline, body: null });
    expect(title).toBe("Fix the leak");
    expect(description).toBe(multiline);
    expect(description).toContain("multiple lines of context");
  });

  it("first-sentence: long single line → topic is the first sentence", () => {
    const title = "Fix the leak. " + "x".repeat(130);
    expect(deriveNotePromotion({ title, body: null }).title).toBe("Fix the leak.");
  });

  it("boundary: exactly 120 chars, no newline → verbatim (guard is ≤)", () => {
    const title = "a".repeat(120);
    expect(deriveNotePromotion({ title, body: null })).toEqual({
      title,
      description: undefined,
    });
  });
});
