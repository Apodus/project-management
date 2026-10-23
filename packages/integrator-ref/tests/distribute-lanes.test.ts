import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// @ts-expect-error — the distribute script is plain ESM (.mjs) with no .d.ts.
import * as distributeModule from "../../../scripts/distribute.mjs";

// The script is untyped; give the handful of exports this suite uses a shape.
type Lane = {
  name: string;
  projectId: string;
  resource?: string;
  pmUrl?: string;
  env?: Record<string, unknown>;
};
type Config = { lanes?: unknown[]; targets: Record<string, unknown>[] };
const {
  distribute,
  lanesFor,
  launcherArtifacts,
  loadConfig,
  renderDaemonLauncher,
  renderLanesJson,
  validateConfig,
} = distributeModule as {
  distribute: (o: Record<string, unknown>) => Record<string, string>;
  lanesFor: (c: Config, t: Record<string, unknown>) => Required<Lane>[];
  launcherArtifacts: (c: Config, t: Record<string, unknown>) => { dest: string }[];
  loadConfig: (p: string) => Config;
  renderDaemonLauncher: (kind: string, o: { bundleName: string }) => string;
  renderLanesJson: (lanes: Lane[]) => string;
  validateConfig: (c: unknown) => Config;
};

/**
 * C4-P1: N integrator lanes on one host from ONE generated supervisor. Lanes are
 * a host property (top-level `lanes`); each lane's state lives in
 * `lanes/<lane>/`; no project id is ever baked into a launcher.
 */

const ULID = "01KSMSZVN87QWZZBY7AR7QV149";
const ULID_LITERAL = /\b[0-9A-HJKMNP-TV-Z]{26}\b/;

let workDir: string;
let fakeRepoRoot: string;

function seedSources(root: string, integratorBundle = "INTEGRATOR_BUNDLE_CONTENT"): void {
  mkdirSync(join(root, "packages", "mcp-server", "dist", "bundle"), { recursive: true });
  mkdirSync(join(root, "packages", "integrator-ref", "dist", "bundle"), { recursive: true });
  mkdirSync(join(root, "docs"), { recursive: true });
  writeFileSync(
    join(root, "packages", "mcp-server", "dist", "bundle", "pm-mcp-server.mjs"),
    "MCP_BUNDLE_CONTENT",
  );
  writeFileSync(
    join(root, "packages", "integrator-ref", "dist", "bundle", "pm-integrator.mjs"),
    integratorBundle,
  );
  writeFileSync(join(root, "docs", "integrator-deployment.md"), "OPERATOR_GUIDE");
  writeFileSync(join(root, "docs", "worker-pm-workflow.md"), "WORKER_WORKFLOW");
}

function fullTarget(name: string, dir: string, extra: Record<string, unknown> = {}) {
  return {
    name,
    mcpDest: join(dir, "tools", "pm-mcp-server", "pm-mcp-server.mjs"),
    integratorDest: join(dir, "tools", "pm-integrator", "pm-integrator.mjs"),
    docsDest: join(dir, "docs", "integrator-deployment.md"),
    workerDocDest: join(dir, "docs", "pm-workflow.md"),
    ...extra,
  };
}

const minimalTarget = (extra: Record<string, unknown> = {}) => ({
  name: "t1",
  integratorDest: "/x/pm-integrator.mjs",
  ...extra,
});

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "distribute-lanes-"));
  fakeRepoRoot = join(workDir, "repo");
  mkdirSync(fakeRepoRoot, { recursive: true });
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe("lanes config validation", () => {
  const withLanes = (lanes: unknown[], targets: unknown[] = [minimalTarget()]) => ({
    lanes,
    targets,
  });

  it("accepts the real lane names and fills defaults", () => {
    const config = withLanes([
      { name: "game_one", projectId: ULID, env: { GAMEONE_ENGINE_PRUNE_FORCE: "1" } },
      { name: "rynx_engine", projectId: "01OTHER", resource: "main" },
      { name: "default", projectId: "01THIRD", resource: "side" },
    ]);
    expect(() => validateConfig(config)).not.toThrow();
    const lanes = lanesFor(config, config.targets[0] as Record<string, unknown>);
    expect(lanes.map((l) => l.name)).toEqual(["game_one", "rynx_engine", "default"]);
    expect(lanes[0]).toEqual({
      name: "game_one",
      projectId: ULID,
      resource: "main",
      pmUrl: "http://localhost:3000",
      env: { GAMEONE_ENGINE_PRUNE_FORCE: "1" },
    });
  });

  it.each(["Game_One", "game one", "1lane", "-lane", "a".repeat(33), "", "lane/x", "..", "gäme"])(
    "rejects lane name %j",
    (name) => {
      expect(() => validateConfig(withLanes([{ name, projectId: ULID }]))).toThrow(
        /"name" must match/,
      );
    },
  );

  it("rejects a lane name declared twice", () => {
    expect(() =>
      validateConfig(
        withLanes([
          { name: "a", projectId: "01A" },
          { name: "a", projectId: "01B" },
        ]),
      ),
    ).toThrow(/declared twice/);
  });

  it("rejects two lanes that are the same (project, resource) train, defaults included", () => {
    expect(() =>
      validateConfig(
        withLanes([
          { name: "a", projectId: ULID },
          { name: "b", projectId: ULID, resource: "main" },
        ]),
      ),
    ).toThrow(/same train/);
  });

  it.each([
    [{ lower: "x" }, /must match/],
    [{ "1X": "x" }, /must match/],
    [{ GAMEONE_ENGINES_BUDGET_GB: 24 }, /must be a string/],
    [{ PM_API_TOKEN: "secret" }, /set by the supervisor itself/],
    [{ PM_INTEGRATOR_LOG_FILE: "x.log" }, /set by the supervisor itself/],
  ])("rejects lane env %j", (env, message) => {
    expect(() => validateConfig(withLanes([{ name: "a", projectId: ULID, env }]))).toThrow(message);
  });

  it("rejects an env that is not an object, and an unknown lane key", () => {
    expect(() => validateConfig(withLanes([{ name: "a", projectId: ULID, env: ["X=1"] }]))).toThrow(
      /"env" must be an object/,
    );
    expect(() => validateConfig(withLanes([{ name: "a", project_id: ULID }]))).toThrow(
      /unknown key "project_id"/,
    );
  });

  it("refuses per-target lanes and points at the top level", () => {
    expect(() =>
      validateConfig({ targets: [minimalTarget({ lanes: [{ name: "a", projectId: ULID }] })] }),
    ).toThrow(/lanes are a HOST property/);
  });

  it("refuses a legacy target projectId next to top-level lanes", () => {
    expect(() =>
      validateConfig(
        withLanes([{ name: "a", projectId: ULID }], [minimalTarget({ projectId: ULID })]),
      ),
    ).toThrow(/legacy "projectId" AND the config declares top-level "lanes"/);
  });

  it("refuses lanes that no target can run, and resource/pmUrl without projectId", () => {
    expect(() =>
      validateConfig(
        withLanes([{ name: "a", projectId: ULID }], [{ name: "docs", docsDest: "/d.md" }]),
      ),
    ).toThrow(/no target receives the integrator/);
    expect(() => validateConfig({ targets: [minimalTarget({ resource: "main" })] })).toThrow(
      /without "projectId"/,
    );
  });

  it("refuses two targets that would share a launcher directory (one lanes/ state tree)", () => {
    // The S4 hazard: two integrator targets in one directory overwrite each
    // other's supervisor and share every lane's token, stop.flag and logs.
    const dir = join(workDir, "shared");
    const config = withLanes(
      [{ name: "a", projectId: ULID }],
      [
        { name: "t1", integratorDest: join(dir, "pm-integrator.mjs") },
        { name: "t2", integratorDest: join(dir, "other-integrator.mjs") },
      ],
    );
    expect(() => validateConfig(config)).toThrow(/both write .*run_daemon\.bat/);
  });

  it.skipIf(process.platform !== "win32")(
    "a launcher directory differing only in case is the same directory on Windows",
    () => {
      const config = withLanes(
        [{ name: "a", projectId: ULID }],
        [
          { name: "t1", integratorDest: join(workDir, "Deploy", "pm-integrator.mjs") },
          { name: "t2", integratorDest: join(workDir, "deploy", "x.mjs") },
        ],
      );
      expect(() => validateConfig(config)).toThrow(/both write/);
    },
  );

  it("loads the shipped example config", () => {
    const example = fileURLToPath(
      new URL("../../../distribute.config.example.json", import.meta.url),
    );
    const config = loadConfig(example);
    expect(config.lanes?.length).toBeGreaterThan(0);
  });
});

describe("lanes emission", () => {
  it("gives every integrator target the same lanes.json and ONE supervisor; other targets none", () => {
    seedSources(fakeRepoRoot);
    const repo = join(workDir, "client");
    const deployBundle = join(workDir, "deploy", "pm-integrator.mjs");
    const config = {
      lanes: [
        {
          name: "game_one",
          projectId: ULID,
          env: { GAMEONE_ENGINE_STORE: "D:\\game_one-engines" },
        },
        { name: "rynx_engine", projectId: "01RYNXENGINEPROJECT" },
      ],
      targets: [
        fullTarget("client", repo),
        { name: "deploy", integratorDest: deployBundle },
        { name: "docs-only", docsDest: join(workDir, "elsewhere", "guide.md") },
      ],
    };

    distribute({ config, repoRoot: fakeRepoRoot, build: false });

    const repoDir = join(repo, "tools", "pm-integrator");
    const deployDir = join(workDir, "deploy");
    const repoLanes = readFileSync(join(repoDir, "lanes.json"), "utf8");
    expect(readFileSync(join(deployDir, "lanes.json"), "utf8")).toBe(repoLanes);
    for (const f of ["run_daemon.bat", "run_daemon_supervised.ps1", "run_daemon.sh"]) {
      expect(readFileSync(join(deployDir, f), "utf8")).toBe(readFileSync(join(repoDir, f), "utf8"));
    }
    // The deploy target asked only for the integrator: no MCP bundle, no docs.
    expect(existsSync(join(deployDir, "pm-mcp-server.mjs"))).toBe(false);
    expect(existsSync(join(workDir, "elsewhere", "lanes.json"))).toBe(false);
    expect(existsSync(join(workDir, "elsewhere", "run_daemon.bat"))).toBe(false);

    const doc = JSON.parse(repoLanes);
    expect(doc.schema).toBe(1);
    expect(doc.lanes).toEqual([
      {
        name: "game_one",
        projectId: ULID,
        resource: "main",
        pmUrl: "http://localhost:3000",
        env: { GAMEONE_ENGINE_STORE: "D:\\game_one-engines" },
      },
      {
        name: "rynx_engine",
        projectId: "01RYNXENGINEPROJECT",
        resource: "main",
        pmUrl: "http://localhost:3000",
        env: {},
      },
    ]);
    expect(repoLanes.endsWith("}\n")).toBe(true);
    // Never the real secret, anywhere.
    expect(existsSync(join(repoDir, "pm_token.txt"))).toBe(false);
    expect(existsSync(join(repoDir, "lanes"))).toBe(false);
  });

  it("a legacy target projectId is one lane named default", () => {
    const target = minimalTarget({ projectId: ULID, resource: "side" });
    const config = { targets: [target] };
    expect(lanesFor(config, target)).toEqual([
      {
        name: "default",
        projectId: ULID,
        resource: "side",
        pmUrl: "http://localhost:3000",
        env: {},
      },
    ]);
    expect(launcherArtifacts(config, target).map((a) => a.dest.replace(/\\/g, "/"))).toEqual([
      "/x/run_daemon.bat",
      "/x/run_daemon_supervised.ps1",
      "/x/run_daemon.sh",
      "/x/lanes.json",
      "/x/pm_token.txt.template",
    ]);
  });

  it("no launcher carries a project id: lanes are data in lanes.json", () => {
    // Mutation (3): the pre-C4 template baked `--project <ULID>` into the .ps1/.sh.
    for (const kind of ["bat", "ps1", "sh"]) {
      expect(renderDaemonLauncher(kind, { bundleName: "pm-integrator.mjs" })).not.toMatch(
        ULID_LITERAL,
      );
    }
    expect(renderLanesJson([{ name: "game_one", projectId: ULID }])).toMatch(ULID_LITERAL);
  });

  it("renders CRLF for Windows launchers, LF for sh, and only takes a plain bundle name", () => {
    const ps1 = renderDaemonLauncher("ps1", { bundleName: "pm-integrator.mjs" });
    expect(ps1).toContain("$BundleName = 'pm-integrator.mjs'");
    expect(ps1.split("\n").every((l) => l === "" || l.endsWith("\r"))).toBe(true);
    expect(renderDaemonLauncher("bat", { bundleName: "x.mjs" })).toContain(
      'powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0run_daemon_supervised.ps1" %*',
    );
    const sh = renderDaemonLauncher("sh", { bundleName: "custom.mjs" });
    expect(sh).toContain('BUNDLE="$DIR/custom.mjs"');
    expect(sh).not.toContain("\r");
    expect(() => renderDaemonLauncher("ps1", { bundleName: "x'; rm -rf /'" })).toThrow(
      /must match/,
    );
    expect(() => renderDaemonLauncher("exe", { bundleName: "x.mjs" })).toThrow(
      /Unknown launcher kind/,
    );
  });

  it("the supervisor wires each lane to its OWN state dir, stop file and daemon log", () => {
    const ps1 = renderDaemonLauncher("ps1", { bundleName: "pm-integrator.mjs" });
    expect(ps1).toContain("$laneDir   = Join-Path (Join-Path $HERE 'lanes') $laneName");
    expect(ps1).toContain("$stopFlag  = Join-Path $laneDir 'stop.flag'");
    expect(ps1).toContain("$psi.EnvironmentVariables['PM_INTEGRATOR_LOG_FILE'] = $daemonLog");
    expect(ps1).toContain('--stop-file "{4}"');
    expect(ps1).not.toMatch(/Join-Path \$HERE '(stop\.flag|pm_token\.txt|supervisor\.log)'/);
    const sh = renderDaemonLauncher("sh", { bundleName: "pm-integrator.mjs" });
    expect(sh).toContain('LANE_DIR="$DIR/lanes/$LANE"');
    expect(sh).toContain('--stop-file "$STOPFLAG"');
    expect(sh).toContain('export PM_INTEGRATOR_LOG_FILE="$LANE_DIR/daemon.log"');
  });

  it("the receipt guards generated launchers and lanes.json like any artifact", () => {
    seedSources(fakeRepoRoot);
    const config = {
      lanes: [{ name: "a", projectId: ULID }],
      targets: [fullTarget("t1", join(workDir, "one")), fullTarget("t2", join(workDir, "two"))],
    };
    const receiptPath = join(workDir, "distribute.receipt.json");
    distribute({ config, repoRoot: fakeRepoRoot, build: false, receiptPath });
    const writes = JSON.parse(readFileSync(receiptPath, "utf8")).writes as Record<string, string>;
    const lanesOne = join(workDir, "one", "tools", "pm-integrator", "lanes.json");
    const batTwo = join(workDir, "two", "tools", "pm-integrator", "run_daemon.bat");
    expect(writes[lanesOne]).toMatch(/^[0-9a-f]{64}$/);
    expect(writes[batTwo]).toMatch(/^[0-9a-f]{64}$/);

    // A hand edit in the SECOND target's launcher, and a lane change upstream.
    writeFileSync(batTwo, "@echo hand-edited\r\n");
    const before = readFileSync(lanesOne, "utf8");
    const changed = { ...config, lanes: [{ name: "a", projectId: ULID, env: { X_Y: "1" } }] };
    expect(() =>
      distribute({ config: changed, repoRoot: fakeRepoRoot, build: false, receiptPath }),
    ).toThrow(/run_daemon\.bat: it has changed since distribute last wrote it/);
    // Checked before ANY target was written: the first target is untouched too.
    expect(readFileSync(lanesOne, "utf8")).toBe(before);
    expect(readFileSync(batTwo, "utf8")).toBe("@echo hand-edited\r\n");
  });
});

// ── The supervisor itself, on a real PowerShell, against a stub daemon. ──────
//
// The stub stands in for pm-integrator.mjs: it records what it was started with
// (argv, cwd, the env the supervisor owns) into its working directory, honours
// --stop-file like the real daemon, and can be told by its lane env to crash
// once (so the supervisor's restart path can be observed).
const STUB_DAEMON = `
import { existsSync, writeFileSync } from "node:fs";
const argv = process.argv.slice(2);
const at = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
const run = existsSync("started.json") ? 2 : 1;
const env = {};
for (const k of ["LANE_MARK", "PM_API_TOKEN", "PM_INTEGRATOR_LOG_FILE", "NoDefaultCurrentDirectoryInExePath"]) {
  env[k] = process.env[k] ?? null;
}
writeFileSync(run === 1 ? "started.json" : "started2.json", JSON.stringify({ argv, cwd: process.cwd(), env }));
if (process.env.STUB_CRASH_FIRST === "1" && run === 1) process.exit(3);
const stopFile = at("--stop-file");
setInterval(() => { if (stopFile && existsSync(stopFile)) process.exit(0); }, 100);
// Safety net: a red run (or a mutation) must never leave a stub alive on the host.
setTimeout(() => process.exit(9), 120000);
`;

const spawned: ChildProcess[] = [];
afterAll(() => {
  // Kill only what this suite started, by pid, tree and all.
  for (const child of spawned) {
    if (child.exitCode === null && child.pid !== undefined) {
      spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    }
  }
});

describe.skipIf(process.platform !== "win32")("supervisor on Windows (real PowerShell)", () => {
  const unique = `${Date.now().toString(36).toUpperCase()}${process.pid}`;
  let hereDir: string;
  let ps1: string;

  const supervisorEnv = () => ({
    ...process.env,
    // A Claude-spawned shell sets this; the supervisor must clear it for the daemon.
    NoDefaultCurrentDirectoryInExePath: "1",
  });

  const runSync = (args: string[]) => {
    const r = spawnSync(
      "powershell",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1, ...args],
      { env: supervisorEnv(), encoding: "utf8", timeout: 30_000 },
    );
    return { status: r.status, out: `${r.stdout}${r.stderr}` };
  };

  const start = (args: string[]) => {
    const child = spawn(
      "powershell",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1, ...args],
      { env: supervisorEnv(), stdio: ["ignore", "pipe", "pipe"] },
    );
    spawned.push(child);
    let out = "";
    child.stdout?.on("data", (d) => (out += String(d)));
    child.stderr?.on("data", (d) => (out += String(d)));
    const exited = new Promise<number | null>((resolve) =>
      child.on("exit", (code) => resolve(code)),
    );
    return { child, exited, output: () => out };
  };

  const waitFor = async (pred: () => boolean, ms: number, what: string) => {
    const t0 = Date.now();
    while (!pred()) {
      if (Date.now() - t0 > ms) throw new Error(`timed out after ${ms}ms waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  };

  const within = <T>(p: Promise<T>, ms: number, what: string) =>
    Promise.race([
      p,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`timed out after ${ms}ms waiting for ${what}`)), ms),
      ),
    ]);

  const laneDir = (name: string) => join(hereDir, "lanes", name);
  const started = (name: string, file = "started.json") =>
    JSON.parse(readFileSync(join(laneDir(name), file), "utf8")) as {
      argv: string[];
      cwd: string;
      env: Record<string, string | null>;
    };

  beforeEach(() => {
    seedSources(fakeRepoRoot, STUB_DAEMON);
    hereDir = join(workDir, "deploy");
    const config = {
      lanes: [
        { name: "a", projectId: `01TESTA${unique}`, env: { LANE_MARK: "a" } },
        { name: "b", projectId: `01TESTB${unique}` },
        { name: "notoken", projectId: `01TESTC${unique}` },
        {
          name: "crashy",
          projectId: `01TESTD${unique}`,
          env: { STUB_CRASH_FIRST: "1", LANE_MARK: "one" },
        },
      ],
      targets: [{ name: "deploy", integratorDest: join(hereDir, "pm-integrator.mjs") }],
    };
    distribute({ config, repoRoot: fakeRepoRoot, build: false });
    ps1 = join(hereDir, "run_daemon_supervised.ps1");
    for (const name of ["a", "b", "crashy"]) {
      mkdirSync(laneDir(name), { recursive: true });
      writeFileSync(join(laneDir(name), "pm_token.txt"), `token-${name}\n`);
    }
  });

  it("an unknown lane exits 2 and lists the valid lanes", () => {
    const r = runSync(["nope"]);
    expect(r.status).toBe(2);
    expect(r.out).toContain("unknown lane 'nope'");
    expect(r.out).toContain("a, b, notoken, crashy");
  });

  it("with more than one lane there is no default: exit 2", () => {
    const r = runSync([]);
    expect(r.status).toBe(2);
    expect(r.out).toMatch(/declares 4 lanes; name one/);
  });

  it("a lane without its own pm_token.txt exits 2 and names the file", () => {
    const r = runSync(["notoken"]);
    expect(r.status).toBe(2);
    expect(r.out).toContain(join("lanes", "notoken", "pm_token.txt"));
  });

  it("each lane's state, env and stop.flag are its own", async () => {
    const a = start(["a"]);
    const b = start(["-Lane", "b"]);
    await waitFor(
      () =>
        existsSync(join(laneDir("a"), "started.json")) &&
        existsSync(join(laneDir("b"), "started.json")),
      30_000,
      `both stub daemons\n--- a ---\n${a.output()}\n--- b ---\n${b.output()}`,
    );

    const sa = started("a");
    const sb = started("b");
    expect(sa.cwd.toLowerCase()).toBe(laneDir("a").toLowerCase());
    expect(sb.cwd.toLowerCase()).toBe(laneDir("b").toLowerCase());
    expect(sa.env.LANE_MARK).toBe("a");
    expect(sb.env.LANE_MARK).toBeNull();
    expect(sa.env.PM_API_TOKEN).toBe("token-a");
    expect(sb.env.PM_API_TOKEN).toBe("token-b");
    expect(sa.env.PM_INTEGRATOR_LOG_FILE).toBe(join(laneDir("a"), "daemon.log"));
    expect(sb.env.PM_INTEGRATOR_LOG_FILE).toBe(join(laneDir("b"), "daemon.log"));
    expect(sa.env.NoDefaultCurrentDirectoryInExePath).toBeNull();
    const argAt = (argv: string[], k: string) => argv[argv.indexOf(k) + 1];
    expect(argAt(sa.argv, "--project")).toBe(`01TESTA${unique}`);
    expect(argAt(sb.argv, "--project")).toBe(`01TESTB${unique}`);
    expect(argAt(sa.argv, "--resource")).toBe("main");
    expect(argAt(sa.argv, "--stop-file")).toBe(join(laneDir("a"), "stop.flag"));
    // C4-P2: every lane names itself and its host-slot file to the daemon.
    expect(argAt(sa.argv, "--lane")).toBe("a");
    expect(argAt(sb.argv, "--lane")).toBe("b");
    expect(argAt(sa.argv, "--host-slots-file")).toBe(join(hereDir, "lanes.json"));

    // Mutation (4): a flag in lanes/a stops a, and only a.
    writeFileSync(join(laneDir("a"), "stop.flag"), "");
    expect(await within(a.exited, 30_000, `lane a to stop\n${a.output()}`)).toBe(0);
    await new Promise((r) => setTimeout(r, 1_500));
    expect(b.child.exitCode).toBeNull();
    // The supervisor consumed its own flag (so the next start is not a stop).
    expect(existsSync(join(laneDir("a"), "stop.flag"))).toBe(false);

    writeFileSync(join(laneDir("b"), "stop.flag"), "");
    expect(await within(b.exited, 30_000, `lane b to stop\n${b.output()}`)).toBe(0);

    for (const name of ["a", "b"]) {
      expect(readFileSync(join(laneDir(name), "supervisor.log"), "utf8")).toMatch(/clean shutdown/);
    }
    // Nothing lane-specific lives beside the bundle.
    for (const f of ["stop.flag", "supervisor.log", "pm_token.txt", "daemon.log"]) {
      expect(existsSync(join(hereDir, f))).toBe(false);
    }
  }, 90_000);

  it("re-reads lanes.json before every daemon start, and stops on an identity change", async () => {
    const c = start(["crashy"]);
    await waitFor(
      () => existsSync(join(laneDir("crashy"), "started.json")),
      30_000,
      `first run\n${c.output()}`,
    );
    expect(started("crashy").env.LANE_MARK).toBe("one");

    // While the supervisor backs off after the crash, change the lane's env.
    const lanesPath = join(hereDir, "lanes.json");
    const doc = JSON.parse(readFileSync(lanesPath, "utf8"));
    doc.lanes[3].env.LANE_MARK = "two";
    writeFileSync(lanesPath, JSON.stringify(doc, null, 2));
    await waitFor(
      () => existsSync(join(laneDir("crashy"), "started2.json")),
      30_000,
      `the restart\n${c.output()}`,
    );
    expect(started("crashy", "started2.json").env.LANE_MARK).toBe("two");

    // Re-pointing a running lane at another train is refused (exit 2), not adopted.
    doc.lanes[3].projectId = "01SOMEONEELSE";
    writeFileSync(lanesPath, JSON.stringify(doc, null, 2));
    unlinkSync(join(laneDir("crashy"), "started.json"));
    // Make the stub exit (stop.flag would end the loop cleanly instead): kill only the daemon.
    const second = started("crashy", "started2.json");
    expect(second.argv).toContain("--stop-file");
    const pid = spawnSync(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        `(Get-CimInstance Win32_Process -Filter "ParentProcessId=${c.child.pid} AND Name='node.exe'").ProcessId`,
      ],
      { encoding: "utf8" },
    ).stdout.trim();
    expect(pid).toMatch(/^\d+$/);
    spawnSync("taskkill", ["/PID", pid, "/F"], { stdio: "ignore" });
    expect(await within(c.exited, 30_000, `the identity refusal\n${c.output()}`)).toBe(2);
    expect(readFileSync(join(laneDir("crashy"), "supervisor.log"), "utf8")).toMatch(
      /different project\/resource/,
    );
  }, 90_000);
});
