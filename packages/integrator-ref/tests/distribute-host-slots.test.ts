import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// @ts-expect-error — the distribute script is plain ESM (.mjs) with no .d.ts.
import * as distributeModule from "../../../scripts/distribute.mjs";
import { parseHostSlotConfig, readHostSlotsFile } from "../src/host-slot.js";

const { distribute, renderDaemonLauncher, validateConfig, validateHostSlots } =
  distributeModule as {
    distribute: (o: Record<string, unknown>) => unknown;
    renderDaemonLauncher: (kind: string, o: { bundleName: string }) => string;
    validateConfig: (c: unknown) => unknown;
    validateHostSlots: (h: unknown) => void;
  };

/**
 * C4-P2: the host verify semaphore is ONE per host. It is declared once, at the
 * top level of the distribute config, emitted into lanes.json, and read by the
 * daemon through --host-slots-file. The generator and the daemon validate it
 * with two implementations (plain .mjs vs TypeScript); this table holds them
 * to one verdict.
 */
const ok = {
  dir: "D:\\pm-host-slots",
  count: 1,
  identityCommand: ["powershell", "-File", "x.ps1"],
};
const VERDICTS: [string, unknown, boolean][] = [
  ["the planned shape", ok, true],
  ["a POSIX absolute dir", { ...ok, dir: "/var/pm-host-slots" }, true],
  ["count 2", { ...ok, count: 2 }, true],
  ["a relative dir", { ...ok, dir: "pm-host-slots" }, false],
  ["an empty dir", { ...ok, dir: "" }, false],
  ["count 0", { ...ok, count: 0 }, false],
  ["a fractional count", { ...ok, count: 1.5 }, false],
  ["a string count", { ...ok, count: "1" }, false],
  ["an empty identity command", { ...ok, identityCommand: [] }, false],
  ["an identity command string", { ...ok, identityCommand: "powershell x.ps1" }, false],
  ["an empty identity argument", { ...ok, identityCommand: ["powershell", ""] }, false],
  ["an unknown key", { ...ok, slots: 2 }, false],
  ["not an object", [ok], false],
];

let workDir: string;
beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "distribute-hostslots-"));
});
afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe("hostSlots: one host, one semaphore", () => {
  it.each(VERDICTS)("generator and daemon agree on %s", (_name, value, accepted) => {
    const gen = (() => {
      try {
        validateHostSlots(value);
        return true;
      } catch {
        return false;
      }
    })();
    const daemon = (() => {
      try {
        parseHostSlotConfig(value);
        return true;
      } catch {
        return false;
      }
    })();
    expect({ gen, daemon }).toEqual({ gen: accepted, daemon: accepted });
  });

  const lanes = [{ name: "a", projectId: "01A" }];
  const target = { name: "t", integratorDest: "/x/pm-integrator.mjs" };

  it("a lane cannot carry its own hostSlots (two lanes could then disagree)", () => {
    expect(() =>
      validateConfig({ lanes: [{ ...lanes[0], hostSlots: ok }], targets: [target] }),
    ).toThrow(/ONE per host: declare hostSlots once at the top level/);
  });

  it("hostSlots without lanes bounds nothing: refused", () => {
    expect(() => validateConfig({ hostSlots: ok, targets: [target] })).toThrow(
      /no "lanes" to bound/,
    );
  });

  it("lanes.json carries the host block the daemon reads back", () => {
    const root = join(workDir, "repo");
    for (const d of [
      "packages/mcp-server/dist/bundle",
      "packages/integrator-ref/dist/bundle",
      "docs",
    ]) {
      mkdirSync(join(root, d), { recursive: true });
    }
    writeFileSync(join(root, "packages/mcp-server/dist/bundle/pm-mcp-server.mjs"), "M");
    writeFileSync(join(root, "packages/integrator-ref/dist/bundle/pm-integrator.mjs"), "I");
    writeFileSync(join(root, "docs/integrator-deployment.md"), "D");
    writeFileSync(join(root, "docs/worker-pm-workflow.md"), "W");
    const dest = join(workDir, "deploy", "pm-integrator.mjs");
    distribute({
      config: { lanes, hostSlots: ok, targets: [{ name: "t", integratorDest: dest }] },
      repoRoot: root,
      build: false,
    });
    const lanesFile = join(workDir, "deploy", "lanes.json");
    expect(JSON.parse(readFileSync(lanesFile, "utf8")).hostSlots).toEqual(ok);
    expect(readHostSlotsFile(lanesFile)).toEqual(ok);
  });

  it("a lanes.json without hostSlots reads as unbounded (null), not as an error", () => {
    const f = join(workDir, "lanes.json");
    writeFileSync(f, JSON.stringify({ schema: 1, lanes: [] }));
    expect(readHostSlotsFile(f)).toBeNull();
  });

  it("both supervisors hand the daemon its lane name and the lanes.json path", () => {
    const ps1 = renderDaemonLauncher("ps1", { bundleName: "pm-integrator.mjs" });
    expect(ps1).toContain('--lane {5} --host-slots-file "{6}"');
    const sh = renderDaemonLauncher("sh", { bundleName: "pm-integrator.mjs" });
    expect(sh).toContain('--lane "$LANE" --host-slots-file "$LANES"');
  });
});
