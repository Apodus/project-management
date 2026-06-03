import { describe, expect, it } from "vitest";
import { layoutIsolatedGrid, type TrayLayoutOptions } from "./epic-graph-tray";

const OPTS: TrayLayoutOptions = {
  leftX: 80,
  topY: 1000,
  nodeWidth: 200,
  colGap: 40,
  rowHeight: 130,
  columns: 2,
};

describe("layoutIsolatedGrid", () => {
  it("wraps into rows by column count (5 ids, 2 columns → rows 0,0,1,1,2)", () => {
    const r = layoutIsolatedGrid(["a", "b", "c", "d", "e"], OPTS);
    const pitchX = OPTS.nodeWidth + OPTS.colGap; // 240
    // Row 0: a@col0, b@col1
    expect(r.positions.get("a")).toEqual({ x: 80, y: 1000 });
    expect(r.positions.get("b")).toEqual({ x: 80 + pitchX, y: 1000 });
    // Row 1: c@col0, d@col1
    expect(r.positions.get("c")).toEqual({ x: 80, y: 1000 + 130 });
    expect(r.positions.get("d")).toEqual({ x: 80 + pitchX, y: 1000 + 130 });
    // Row 2: e@col0
    expect(r.positions.get("e")).toEqual({ x: 80, y: 1000 + 260 });
  });

  it("sorts ids before placement (shuffled input → identical to sorted)", () => {
    const sorted = layoutIsolatedGrid(["a", "b", "c", "d", "e"], OPTS);
    const shuffled = layoutIsolatedGrid(["d", "a", "e", "c", "b"], OPTS);
    expect([...shuffled.positions.entries()]).toEqual([...sorted.positions.entries()]);
  });

  it("is deterministic — two shuffled calls produce equal maps", () => {
    const one = layoutIsolatedGrid(["x", "m", "a", "q", "b"], OPTS);
    const two = layoutIsolatedGrid(["b", "q", "x", "a", "m"], OPTS);
    expect([...one.positions.entries()]).toEqual([...two.positions.entries()]);
    expect(one.rightX).toBe(two.rightX);
  });

  it("single node lands at (leftX, topY); rightX = leftX + nodeWidth", () => {
    const r = layoutIsolatedGrid(["solo"], OPTS);
    expect(r.positions.get("solo")).toEqual({ x: 80, y: 1000 });
    expect(r.rightX).toBe(80 + 200);
  });

  it("empty input → empty map, rightX = leftX", () => {
    const r = layoutIsolatedGrid([], OPTS);
    expect(r.positions.size).toBe(0);
    expect(r.rightX).toBe(80);
  });

  it("rightX reflects a partial last row (5 ids, 3 columns → full 3-column width)", () => {
    const r = layoutIsolatedGrid(["a", "b", "c", "d", "e"], { ...OPTS, columns: 3 });
    const pitchX = OPTS.nodeWidth + OPTS.colGap; // 240
    // First row fills all 3 columns → rightX spans 3 columns.
    expect(r.rightX).toBe(80 + 2 * pitchX + 200);
  });

  it("produces finite geometry for every node", () => {
    const r = layoutIsolatedGrid(["a", "b", "c", "d", "e", "f", "g"], OPTS);
    for (const p of r.positions.values()) {
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Number.isFinite(p.y)).toBe(true);
    }
    expect(Number.isFinite(r.rightX)).toBe(true);
  });
});
