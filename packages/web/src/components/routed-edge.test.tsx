import { describe, expect, it } from "vitest";
import { buildRoutedPath } from "./routed-edge";

const src = { x: 0, y: 0 };
const tgt = { x: 400, y: 0 };

describe("buildRoutedPath", () => {
  it("threads a single interior waypoint into a smooth (quadratic) path", () => {
    const d = buildRoutedPath([{ x: 200, y: 100 }], src, tgt);
    expect(d.startsWith(`M ${src.x},${src.y}`)).toBe(true);
    // The waypoint appears as a quadratic control point.
    expect(d).toContain("Q 200,100");
    // Ends at the real target endpoint.
    expect(d.endsWith(`L ${tgt.x},${tgt.y}`)).toBe(true);
  });

  it("threads TWO interior waypoints (dist-3 edge) — both present, in order", () => {
    const d = buildRoutedPath(
      [
        { x: 150, y: -50 },
        { x: 300, y: 60 },
      ],
      src,
      tgt,
    );
    expect(d).toContain("Q 150,-50");
    expect(d).toContain("Q 300,60");
    // The first waypoint's quadratic precedes the second in the string.
    expect(d.indexOf("Q 150,-50")).toBeLessThan(d.indexOf("Q 300,60"));
    expect(d.endsWith(`L ${tgt.x},${tgt.y}`)).toBe(true);
  });

  it("degrades to a straight M..L.. with zero interior points", () => {
    const d = buildRoutedPath([], src, tgt);
    expect(d).toBe(`M ${src.x},${src.y} L ${tgt.x},${tgt.y}`);
  });
});
