import { describe, expect, it } from "vitest";
import { parseEpicLabel } from "./epic-label";

describe("parseEpicLabel", () => {
  it("splits a [tag] code prefix from an em-dash topic", () => {
    const r = parseEpicLabel("[P6-zprepass] C2 — Dual depth resolve pass for foliage");
    expect(r.tag).toBe("[P6-zprepass] C2");
    expect(r.topic).toBe("Dual depth resolve pass for foliage");
  });

  it("splits a [tag] code prefix from a hyphen-separated topic", () => {
    const r = parseEpicLabel("[AUTH] P4 - Refresh token rotation");
    expect(r.tag).toBe("[AUTH] P4");
    expect(r.topic).toBe("Refresh token rotation");
  });

  it("splits a short-code prefix immediately followed by a colon (old-regex failure)", () => {
    const r = parseEpicLabel("P4: colon sep topic");
    expect(r.tag).toBe("P4");
    expect(r.topic).toBe("colon sep topic");
  });

  it("does NOT split an in-word hyphen after a bracket tag", () => {
    const r = parseEpicLabel("[X] First-class undo");
    expect(r.tag).toBe("[X]");
    expect(r.topic).toBe("First-class undo");
  });

  it("returns {null, name} for a name with no prefix and an in-word hyphen", () => {
    const r = parseEpicLabel("Multi-tenant data isolation");
    expect(r.tag).toBeNull();
    expect(r.topic).toBe("Multi-tenant data isolation");
  });

  it("returns {null, name} for a plain topic", () => {
    const r = parseEpicLabel("Refactor the scheduler");
    expect(r.tag).toBeNull();
    expect(r.topic).toBe("Refactor the scheduler");
  });

  it("returns the whole name for a tag-only string (never empty topic)", () => {
    const r = parseEpicLabel("[P6-zprepass] C2");
    expect(r.tag).toBeNull();
    expect(r.topic).toBe("[P6-zprepass] C2");
  });

  it("handles an empty string", () => {
    const r = parseEpicLabel("");
    expect(r.tag).toBeNull();
    expect(r.topic).toBe("");
  });

  it("strips any leading separator (no leading —/-/:/space) from the topic", () => {
    const foliage = parseEpicLabel("[P6-zprepass] C2 — Dual depth resolve pass for foliage");
    expect(foliage.topic).not.toMatch(/^[—–:\-\s]/);
    const colon = parseEpicLabel("P4: colon sep topic");
    expect(colon.topic).not.toMatch(/^[—–:\-\s]/);
  });
});
