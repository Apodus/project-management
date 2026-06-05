#!/usr/bin/env node
/**
 * Cross-platform, parameterized successor to packages/mcp-server/distribute.bat.
 *
 * Builds the MCP + integrator bundles and copies the four vendored artifacts
 * (MCP bundle, integrator daemon, operator guide, worker workflow doc) to every
 * target declared in a gitignored `distribute.config.json`. Mirrors the .bat's
 * behavior exactly — including renaming worker-pm-workflow.md to whatever the
 * target's `workerDocDest` names it (pm-workflow.md by convention).
 *
 * Usage:
 *   node scripts/distribute.mjs [--config <path>] [--dry-run]
 *
 * The exported helpers (parseArgs, loadConfig, resolveSources, distribute) are
 * pure and unit-tested; only `main()` runs when invoked directly.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Parse argv (positional-free): `--config <path>` and `--dry-run`. */
export function parseArgs(argv) {
  const args = { config: join(repoRoot, "distribute.config.json"), dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run") {
      args.dryRun = true;
    } else if (arg === "--config") {
      const value = argv[i + 1];
      if (value === undefined) {
        throw new Error("--config requires a path argument");
      }
      args.config = value;
      i++;
    } else if (arg.startsWith("--config=")) {
      args.config = arg.slice("--config=".length);
    } else {
      throw new Error(
        `Unknown argument: ${arg}\nUsage: node scripts/distribute.mjs [--config <path>] [--dry-run]`,
      );
    }
  }
  return args;
}

const REQUIRED_TARGET_FIELDS = ["mcpDest", "integratorDest", "docsDest", "workerDocDest"];

/**
 * Load + validate a distribute config from disk. Throws clear, actionable
 * errors on a missing file, malformed JSON, or a structurally invalid config.
 */
export function loadConfig(configPath) {
  if (!existsSync(configPath)) {
    throw new Error(
      `Config not found at ${configPath}\n` +
        "Copy distribute.config.example.json to distribute.config.json " +
        "(gitignored) and set absolute dest paths for each target.",
    );
  }

  let raw;
  try {
    raw = readFileSync(configPath, "utf8");
  } catch (err) {
    throw new Error(`Could not read config at ${configPath}: ${err.message}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Config at ${configPath} is not valid JSON: ${err.message}`);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Config at ${configPath} must be a JSON object`);
  }
  if (!Array.isArray(parsed.targets) || parsed.targets.length === 0) {
    throw new Error(`Config at ${configPath} must contain a non-empty "targets" array`);
  }

  parsed.targets.forEach((target, idx) => {
    if (!target || typeof target !== "object" || Array.isArray(target)) {
      throw new Error(`Config target #${idx} must be an object`);
    }
    if (typeof target.name !== "string" || target.name.trim() === "") {
      throw new Error(`Config target #${idx} is missing a non-empty "name"`);
    }
    for (const field of REQUIRED_TARGET_FIELDS) {
      if (typeof target[field] !== "string" || target[field].trim() === "") {
        throw new Error(`Config target "${target.name}" is missing a non-empty string "${field}"`);
      }
    }
    // Optional launcher fields: present ⇒ must be a non-empty string. `projectId`
    // is the gate — a target that declares one also gets a generated daemon
    // launcher (run_daemon.bat/.sh + pm_token.txt.template) next to its bundle.
    for (const optField of OPTIONAL_TARGET_FIELDS) {
      if (
        target[optField] !== undefined &&
        (typeof target[optField] !== "string" || target[optField].trim() === "")
      ) {
        throw new Error(
          `Config target "${target.name}" has an invalid "${optField}" (must be a non-empty string when present)`,
        );
      }
    }
  });

  return parsed;
}

const OPTIONAL_TARGET_FIELDS = ["projectId", "resource", "pmUrl"];

const DEFAULT_RESOURCE = "main";
const DEFAULT_PM_URL = "http://localhost:3000";
const TOKEN_TEMPLATE_CONTENT = "paste-your-pm-api-token-here\n";

/**
 * Render a self-contained daemon launcher that runs the vendored bundle sitting
 * next to it (`bundleName`), loading the PM token from a gitignored `pm_token.txt`
 * in the same directory. `kind` is "bat" (Windows, CRLF) or "sh" (POSIX, LF).
 * This is what makes a target self-contained — no reference to the dev monorepo.
 */
export function renderDaemonLauncher(
  kind,
  { bundleName, projectId, resource = DEFAULT_RESOURCE, pmUrl = DEFAULT_PM_URL },
) {
  if (kind === "bat") {
    return [
      "@echo off",
      "rem PM merge-train integrator daemon launcher (generated by scripts/distribute.mjs).",
      "rem Runs the vendored pm-integrator bundle sitting next to this script.",
      "rem First-time setup: copy pm_token.txt.template -> pm_token.txt and paste your PM API token.",
      "setlocal",
      'if not exist "%~dp0pm_token.txt" (',
      "    echo ERROR: %~dp0pm_token.txt not found.",
      "    echo Copy pm_token.txt.template to pm_token.txt and paste your PM API token into it.",
      "    exit /b 1",
      ")",
      'set /p PM_API_TOKEN=<"%~dp0pm_token.txt"',
      `node "%~dp0${bundleName}" --project ${projectId} --resource ${resource} --pm-url ${pmUrl} %*`,
      "",
    ].join("\r\n");
  }
  if (kind === "sh") {
    return [
      "#!/usr/bin/env bash",
      "# PM merge-train integrator daemon launcher (generated by scripts/distribute.mjs).",
      "# Runs the vendored pm-integrator bundle sitting next to this script.",
      "# First-time setup: copy pm_token.txt.template -> pm_token.txt and paste your PM API token.",
      "set -euo pipefail",
      'DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"',
      'if [ ! -f "$DIR/pm_token.txt" ]; then',
      '  echo "ERROR: $DIR/pm_token.txt not found." >&2',
      '  echo "Copy pm_token.txt.template to pm_token.txt and paste your PM API token into it." >&2',
      "  exit 1",
      "fi",
      'export PM_API_TOKEN="$(cat "$DIR/pm_token.txt")"',
      `exec node "$DIR/${bundleName}" --project ${projectId} --resource ${resource} --pm-url ${pmUrl} "$@"`,
      "",
    ].join("\n");
  }
  throw new Error(`Unknown launcher kind: "${kind}" (expected "bat" or "sh")`);
}

/**
 * Emit the daemon launcher trio (run_daemon.bat, run_daemon.sh,
 * pm_token.txt.template) next to a target's integrator bundle — but ONLY when the
 * target declares a `projectId` (a launcher needs one to be runnable). The
 * launchers reference the bundle by its actual basename, so the target is fully
 * self-contained. `pm_token.txt` (the real secret) is never written or touched.
 * Returns the list of files written (empty when no launcher was emitted).
 */
export function writeLaunchers(target, dryRun) {
  if (!target.projectId) return [];

  const dir = dirname(target.integratorDest);
  const bundleName = basename(target.integratorDest);
  const opts = {
    bundleName,
    projectId: target.projectId,
    resource: target.resource ?? DEFAULT_RESOURCE,
    pmUrl: target.pmUrl ?? DEFAULT_PM_URL,
  };
  const files = [
    ["run_daemon.bat", renderDaemonLauncher("bat", opts)],
    ["run_daemon.sh", renderDaemonLauncher("sh", opts)],
    ["pm_token.txt.template", TOKEN_TEMPLATE_CONTENT],
  ];

  const written = [];
  for (const [name, content] of files) {
    const dest = join(dir, name);
    if (dryRun) {
      console.log(`  [dry-run] would write ${dest}`);
      continue;
    }
    mkdirSync(dir, { recursive: true });
    writeFileSync(dest, content);
    console.log(`  wrote ${dest}`);
    written.push(dest);
  }
  return written;
}

/**
 * Resolve the four absolute source artifact paths and assert they exist.
 * Missing files almost always mean the build/bundle step did not run.
 */
export function resolveSources(root) {
  const sources = {
    mcpBundle: join(root, "packages", "mcp-server", "dist", "bundle", "pm-mcp-server.mjs"),
    integratorBundle: join(
      root,
      "packages",
      "integrator-ref",
      "dist",
      "bundle",
      "pm-integrator.mjs",
    ),
    docs: join(root, "docs", "integrator-deployment.md"),
    workerDoc: join(root, "docs", "worker-pm-workflow.md"),
  };

  const labels = {
    mcpBundle: "MCP bundle",
    integratorBundle: "Integrator bundle",
    docs: "Operator guide",
    workerDoc: "Worker workflow doc",
  };

  for (const [key, path] of Object.entries(sources)) {
    if (!existsSync(path)) {
      const buildHint =
        key === "mcpBundle" || key === "integratorBundle"
          ? " — did the build run? (the bundles are produced by `pnpm --filter @urtela/pm-mcp-server build` and `pnpm --filter @urtela/pm-integrator build && bundle`)"
          : "";
      throw new Error(`${labels[key]} not found at ${path}${buildHint}`);
    }
  }

  return sources;
}

/**
 * Spawn `pnpm <args>` cross-platform WITHOUT `shell:true`. On Windows `pnpm` is a
 * `.cmd` shim that recent Node refuses to spawn directly (EINVAL, CVE-2024-27980
 * hardening); `shell:true` works but trips DEP0190 (unescaped args). Routing
 * through `cmd.exe /c` avoids both — cmd.exe is a real executable and resolves
 * the `pnpm` shim itself. On POSIX, spawn `pnpm` directly.
 */
function spawnPnpm(args, opts) {
  return process.platform === "win32"
    ? spawnSync("cmd.exe", ["/c", "pnpm", ...args], opts)
    : spawnSync("pnpm", args, opts);
}

function runBuild(root) {
  const steps = [
    ["--filter", "@urtela/pm-mcp-server", "build"],
    ["--filter", "@urtela/pm-integrator", "build"],
    ["--filter", "@urtela/pm-integrator", "bundle"],
  ];
  for (const stepArgs of steps) {
    console.log(`Running: pnpm ${stepArgs.join(" ")}`);
    const result = spawnPnpm(stepArgs, {
      cwd: root,
      stdio: "inherit",
    });
    if (result.error) {
      throw new Error(`Failed to spawn pnpm: ${result.error.message}`);
    }
    if (result.status !== 0) {
      throw new Error(`\`pnpm ${stepArgs.join(" ")}\` exited with code ${result.status}`);
    }
  }
}

function copyArtifact(src, dest, dryRun) {
  if (dryRun) {
    console.log(`  [dry-run] would copy ${src} -> ${dest}`);
    return;
  }
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(src, dest);
  console.log(`  copied ${src} -> ${dest}`);
}

/**
 * Orchestrator. Builds the bundles (unless build === false), resolves + asserts
 * the four sources, then copies them to each target. `dryRun` skips BOTH the
 * build and every copy (logs intentions, writes nothing).
 */
export function distribute({ config, repoRoot: root, dryRun = false, build = true }) {
  if (build && !dryRun) {
    runBuild(root);
  } else if (dryRun) {
    console.log("[dry-run] skipping build");
  }

  const sources = resolveSources(root);

  for (const target of config.targets) {
    console.log(`\nTarget: ${target.name}`);
    copyArtifact(sources.mcpBundle, target.mcpDest, dryRun);
    copyArtifact(sources.integratorBundle, target.integratorDest, dryRun);
    copyArtifact(sources.docs, target.docsDest, dryRun);
    copyArtifact(sources.workerDoc, target.workerDocDest, dryRun);
    const launchers = writeLaunchers(target, dryRun);

    if (!dryRun) {
      console.log(`Distributed to "${target.name}":`);
      console.log(`  MCP bundle        -> ${target.mcpDest}`);
      console.log(`  Integrator daemon -> ${target.integratorDest}`);
      console.log(`  Operator guide    -> ${target.docsDest}`);
      console.log(`  Worker workflow   -> ${target.workerDocDest}`);
      console.log(
        "  Restart any running Claude Code session in this target to pick up the new MCP bundle.",
      );
      if (launchers.length > 0) {
        const launcherDir = dirname(target.integratorDest);
        console.log(`  Daemon launcher   -> ${join(launcherDir, "run_daemon.bat")} (+ .sh)`);
        console.log(
          "  First run: copy pm_token.txt.template -> pm_token.txt, paste the daemon's PM API token,",
        );
        console.log(`  then run:  "${join(launcherDir, "run_daemon.bat")}"`);
      } else {
        console.log(
          `  Run the integrator with:  node "${target.integratorDest}" --project <id> --resource main --pm-url http://localhost:3000`,
        );
        console.log(
          '  (Add "projectId" to this target in the config to auto-generate a run_daemon launcher.)',
        );
      }
    }
  }
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }

  try {
    const config = loadConfig(args.config);
    distribute({ config, repoRoot, dryRun: args.dryRun });
    console.log(args.dryRun ? "\n[dry-run] complete — nothing written." : "\nDone.");
  } catch (err) {
    console.error(`\nDistribute failed: ${err.message}`);
    process.exit(1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
