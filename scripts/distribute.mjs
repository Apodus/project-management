#!/usr/bin/env node
/**
 * Cross-platform, parameterized successor to packages/mcp-server/distribute.bat.
 *
 * Builds the MCP + integrator bundles and copies the vendored artifacts (MCP
 * bundle, integrator daemon, operator guide, worker workflow doc) to every
 * target declared in a gitignored `distribute.config.json`. Mirrors the .bat's
 * behavior exactly — including renaming worker-pm-workflow.md to whatever the
 * target's `workerDocDest` names it (pm-workflow.md by convention).
 *
 * Usage:
 *   node scripts/distribute.mjs [--config <path>] [--dry-run]
 *                               [--accept-existing] [--force]
 *
 * LANES. A host runs one integrator daemon per lane -- a (project, resource)
 * train -- and every lane on the host is declared ONCE, at the top level of the
 * config (`lanes`). Every target that receives the integrator bundle also gets a
 * generated `lanes.json` and ONE supervisor (`run_daemon.bat <lane>`) that serves
 * all of them, with each lane's state (token, stop.flag, logs, cwd) in
 * `lanes/<lane>/` beside it. Lanes are a host property, not a target property:
 * two targets on one host (a client repo's vendored copy and a deploy directory)
 * can therefore never disagree about them. A legacy target `projectId` is one
 * lane named `default` for that target only, and cannot be mixed with `lanes`.
 *
 * WRITE RECEIPTS. Every artifact this script writes is recorded -- destination
 * path -> sha256 of the exact bytes written -- in a `distribute.receipt.json`
 * beside the config. On the next run each destination is compared against that
 * record, and a destination that no longer matches what we last wrote is
 * REFUSED rather than overwritten. Generated launchers and `lanes.json` go
 * through the same guard as the bundles.
 *
 * This exists because the overwrite is one-way and silent, and a destination
 * can be AHEAD of its source. On 2026-09-19 game_one's docs/pm-workflow.md held
 * 33 lines of durable-worker-slot guidance, added downstream by d412a393f, that
 * does not exist upstream; a distribute would have removed exactly those 33
 * lines and re-added the 3 they replaced. Nothing would have reported it. It was
 * caught by someone reading a 36-line diff inside a change about a bundle.
 *
 * `--accept-existing` allows a first write to a destination we have no record
 * for (the bootstrap case, and the one-time cost of adopting receipts).
 * `--force` overwrites a destination that HAS diverged -- it discards downstream
 * edits, so it is never the right reflex; check the diff and decide.
 *
 * The exported helpers (parseArgs, loadConfig, validateConfig, lanesFor,
 * resolveSources, distribute) are pure and unit-tested; only `main()` runs when
 * invoked directly.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Parse argv (positional-free): `--config <path>` and `--dry-run`. */
export function parseArgs(argv) {
  const args = {
    config: join(repoRoot, "distribute.config.json"),
    dryRun: false,
    acceptExisting: false,
    force: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--accept-existing") {
      args.acceptExisting = true;
    } else if (arg === "--force") {
      args.force = true;
    } else if (arg === "--dry-run") {
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
        `Unknown argument: ${arg}\nUsage: node scripts/distribute.mjs [--config <path>] [--dry-run] [--accept-existing] [--force]`,
      );
    }
  }
  return args;
}

/** The vendored artifacts, by the target field that names each one's destination. */
const ARTIFACT_FIELDS = ["mcpDest", "integratorDest", "docsDest", "workerDocDest"];
/** Legacy single-lane launcher fields (one lane named "default" for that target). */
const LEGACY_LANE_FIELDS = ["projectId", "resource", "pmUrl"];
const TARGET_KEYS = new Set(["name", ...ARTIFACT_FIELDS, ...LEGACY_LANE_FIELDS]);
const LANE_KEYS = new Set(["name", "projectId", "resource", "pmUrl", "env"]);
const TOP_LEVEL_KEYS = new Set(["targets", "lanes"]);

/** A lane name is a directory name, a scheduled-task suffix and a CLI argument. */
export const LANE_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;
export const LANE_ENV_KEY_PATTERN = /^[A-Z][A-Z0-9_]*$/;
/**
 * Set by the supervisor itself, per lane, AFTER the lane's env, so no lane can
 * shadow them -- and refused in a lane's env so nobody believes they can.
 * (`lanes.json` is committed in client repos: a token there would be published.)
 */
export const SUPERVISOR_OWNED_ENV = ["PM_API_TOKEN", "PM_INTEGRATOR_LOG_FILE"];
/** The bundle basename is spliced into generated scripts; keep it a plain file name. */
const BUNDLE_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;

const DEFAULT_RESOURCE = "main";
const DEFAULT_PM_URL = "http://localhost:3000";
const DEFAULT_LANE_NAME = "default";
const TOKEN_TEMPLATE_CONTENT = "paste-your-pm-api-token-here\n";

/** Keys beginning with `_` are comments, accepted anywhere (`_comment`, ...). */
function assertKnownKeys(obj, allowed, where, hint = () => "") {
  for (const key of Object.keys(obj)) {
    if (key.startsWith("_") || allowed.has(key)) continue;
    throw new Error(
      `${where} has an unknown key "${key}"${hint(key)} (allowed: ${[...allowed].join(", ")})`,
    );
  }
}

function isNonEmptyString(v) {
  return typeof v === "string" && v.trim() !== "";
}

function isPlainObject(v) {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

/** Same-file identity on this OS: Windows paths are case-insensitive. */
function pathKey(p) {
  const abs = resolve(p);
  return process.platform === "win32" ? abs.toLowerCase() : abs;
}

function validateLane(lane, idx) {
  if (!isPlainObject(lane)) throw new Error(`Config lane #${idx} must be an object`);
  const where = `Config lane "${lane.name ?? `#${idx}`}"`;
  assertKnownKeys(lane, LANE_KEYS, where);
  if (typeof lane.name !== "string" || !LANE_NAME_PATTERN.test(lane.name)) {
    throw new Error(
      `${where}: "name" must match ${LANE_NAME_PATTERN} (lowercase, starts with a letter, at most 32 characters)`,
    );
  }
  if (!isNonEmptyString(lane.projectId)) {
    throw new Error(`${where} is missing a non-empty string "projectId"`);
  }
  for (const field of ["resource", "pmUrl"]) {
    if (lane[field] !== undefined && !isNonEmptyString(lane[field])) {
      throw new Error(
        `${where} has an invalid "${field}" (must be a non-empty string when present)`,
      );
    }
  }
  if (lane.env !== undefined) {
    if (!isPlainObject(lane.env)) throw new Error(`${where}: "env" must be an object of strings`);
    for (const [key, value] of Object.entries(lane.env)) {
      if (!LANE_ENV_KEY_PATTERN.test(key)) {
        throw new Error(`${where}: env key "${key}" must match ${LANE_ENV_KEY_PATTERN}`);
      }
      if (SUPERVISOR_OWNED_ENV.includes(key)) {
        throw new Error(
          `${where}: env key "${key}" is set by the supervisor itself (the token lives in lanes/<lane>/pm_token.txt, the log in lanes/<lane>/daemon.log)`,
        );
      }
      if (typeof value !== "string") {
        throw new Error(`${where}: env "${key}" must be a string (got ${typeof value})`);
      }
    }
  }
}

function validateTarget(target, idx, hasTopLevelLanes) {
  if (!isPlainObject(target)) throw new Error(`Config target #${idx} must be an object`);
  if (!isNonEmptyString(target.name)) {
    throw new Error(`Config target #${idx} is missing a non-empty "name"`);
  }
  const where = `Config target "${target.name}"`;
  assertKnownKeys(target, TARGET_KEYS, where, (key) =>
    key === "lanes"
      ? " -- lanes are a HOST property: declare them once at the top level of the config, and every integrator target gets them"
      : "",
  );
  const artifacts = ARTIFACT_FIELDS.filter((f) => target[f] !== undefined);
  if (artifacts.length === 0) {
    throw new Error(`${where} names no artifact (one or more of: ${ARTIFACT_FIELDS.join(", ")})`);
  }
  for (const field of [...artifacts, ...LEGACY_LANE_FIELDS]) {
    if (target[field] !== undefined && !isNonEmptyString(target[field])) {
      throw new Error(
        `${where} has an invalid "${field}" (must be a non-empty string when present)`,
      );
    }
  }
  if (
    target.integratorDest !== undefined &&
    !BUNDLE_NAME_PATTERN.test(basename(target.integratorDest))
  ) {
    throw new Error(`${where}: the integrator bundle file name must match ${BUNDLE_NAME_PATTERN}`);
  }
  if (target.projectId !== undefined) {
    if (hasTopLevelLanes) {
      throw new Error(
        `${where} has a legacy "projectId" AND the config declares top-level "lanes": declare this target's lane in "lanes" instead (one way to say it, not two)`,
      );
    }
    if (target.integratorDest === undefined) {
      throw new Error(`${where} has "projectId" but no "integratorDest" for its launcher to run`);
    }
  } else if (target.resource !== undefined || target.pmUrl !== undefined) {
    throw new Error(
      `${where} has "resource"/"pmUrl" without "projectId" (they would configure nothing)`,
    );
  }
}

/**
 * Structural validation of a whole config. Throws on the first defect; returns
 * the config unchanged. Called by loadConfig AND by distribute, so no caller can
 * reach a write with an unchecked config.
 */
export function validateConfig(config, where = "Config") {
  if (!isPlainObject(config)) throw new Error(`${where} must be a JSON object`);
  assertKnownKeys(config, TOP_LEVEL_KEYS, where);
  if (!Array.isArray(config.targets) || config.targets.length === 0) {
    throw new Error(`${where} must contain a non-empty "targets" array`);
  }

  const hasLanes = config.lanes !== undefined;
  if (hasLanes) {
    if (!Array.isArray(config.lanes) || config.lanes.length === 0) {
      throw new Error(`${where}: "lanes" must be a non-empty array when present`);
    }
    config.lanes.forEach(validateLane);
    const names = new Set();
    const identities = new Map();
    for (const lane of config.lanes) {
      if (names.has(lane.name))
        throw new Error(`${where}: lane name "${lane.name}" is declared twice`);
      names.add(lane.name);
      // One daemon per (project, resource): the supervisor's mutex is keyed by it.
      const identity = `${lane.projectId}/${lane.resource ?? DEFAULT_RESOURCE}`;
      if (identities.has(identity)) {
        throw new Error(
          `${where}: lanes "${identities.get(identity)}" and "${lane.name}" are the same train (${identity})`,
        );
      }
      identities.set(identity, lane.name);
    }
  }

  config.targets.forEach((t, idx) => validateTarget(t, idx, hasLanes));
  if (hasLanes && !config.targets.some((t) => t.integratorDest !== undefined)) {
    throw new Error(
      `${where} declares "lanes" but no target receives the integrator ("integratorDest")`,
    );
  }

  // Every destination -- artifact AND generated launcher file -- belongs to
  // exactly one target. Two targets sharing a launcher directory would overwrite
  // each other's supervisor and share one lanes/ state tree.
  const owner = new Map();
  for (const target of config.targets) {
    for (const dest of plannedDestinations(config, target)) {
      const key = pathKey(dest);
      const prev = owner.get(key);
      if (prev !== undefined) {
        throw new Error(
          `${where}: targets "${prev}" and "${target.name}" both write ${dest} -- a destination (and a launcher directory with its lanes/ state) belongs to one target`,
        );
      }
      owner.set(key, target.name);
    }
  }
  return config;
}

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

  return validateConfig(parsed, `Config at ${configPath}`);
}

function normalizeLane(lane) {
  return {
    name: lane.name,
    projectId: lane.projectId,
    resource: lane.resource ?? DEFAULT_RESOURCE,
    pmUrl: lane.pmUrl ?? DEFAULT_PM_URL,
    env: { ...(lane.env ?? {}) },
  };
}

/**
 * The lanes a target's launcher serves: the host's top-level lanes for every
 * integrator target, or the legacy single `default` lane of a target that sets
 * `projectId`, or none.
 */
export function lanesFor(config, target) {
  if (target.integratorDest === undefined) return [];
  if (config.lanes !== undefined) return config.lanes.map(normalizeLane);
  if (target.projectId !== undefined) {
    return [
      normalizeLane({
        name: DEFAULT_LANE_NAME,
        projectId: target.projectId,
        resource: target.resource,
        pmUrl: target.pmUrl,
      }),
    ];
  }
  return [];
}

const LAUNCHER_FILES = [
  "run_daemon.bat",
  "run_daemon_supervised.ps1",
  "run_daemon.sh",
  "lanes.json",
  "pm_token.txt.template",
];

function plannedDestinations(config, target) {
  const dests = ARTIFACT_FIELDS.filter((f) => target[f] !== undefined).map((f) => target[f]);
  if (lanesFor(config, target).length > 0) {
    const dir = dirname(target.integratorDest);
    for (const name of LAUNCHER_FILES) dests.push(join(dir, name));
  }
  return dests;
}

/**
 * The data file the supervisor reads: the host's lanes, nothing else. It holds
 * no secret (tokens live in lanes/<lane>/pm_token.txt) and is safe to commit.
 */
export function renderLanesJson(lanes) {
  const doc = {
    _generated:
      "GENERATED by scripts/distribute.mjs from the distribute config's top-level `lanes` -- edits here are overwritten, and are refused until you pass --force.",
    schema: 1,
    lanes: lanes.map(normalizeLane),
  };
  return JSON.stringify(doc, null, 2) + "\n";
}

// The Windows supervisor. ONE script for every lane in lanes.json. Written as a
// raw block (no `${`, no backticks) so it reads as the PowerShell it is; the
// only substitution is the bundle file name.
const SUPERVISOR_PS1 = String.raw`# PM merge-train integrator daemon SUPERVISOR (generated by scripts/distribute.mjs; do not edit).
# ONE supervisor for every lane declared in lanes.json next to this script. A lane is one
# (project, resource) train. Usage:
#   run_daemon.bat <lane> [extra daemon args]        (or: run_daemon_supervised.ps1 -Lane <lane>)
# A lane's state lives in lanes\<lane>\ and nowhere else:
#   pm_token.txt    the lane's PM API token (you create it; never generated, never printed)
#   stop.flag       New-Item -ItemType File lanes\<lane>\stop.flag stops THAT lane only: the daemon
#                   finishes its current loop iteration (--stop-file), then this supervisor exits 0
#   supervisor.log  this script's log
#   daemon.log      the daemon's own JSONL log (PM_INTEGRATOR_LOG_FILE)
# and the directory is the daemon's working directory. lanes.json is re-read before every daemon
# start, so a lane's env reaches the next start; its project/resource may not change under a running
# supervisor. Single instance per (project, resource) via a named mutex; crash-loop backoff.
# Exit codes: 0 clean stop, 1 unexpected or duplicate, 2 configuration (lane, lanes.json, token).
$ErrorActionPreference = 'Stop'
$HERE = Split-Path -Parent $MyInvocation.MyCommand.Path

$BundleName = '@@BUNDLE_NAME@@'
$bundle    = Join-Path $HERE $BundleName
$lanesFile = Join-Path $HERE 'lanes.json'
$MinHealthySeconds = 60
$BackoffSeconds = @(5, 15, 45, 120, 300)
$LoudAfter = 5

function Stop-Config($m) { [Console]::Error.WriteLine("ERROR: $m"); exit 2 }

function Read-Lanes {
  if (-not (Test-Path -LiteralPath $lanesFile)) { Stop-Config "$lanesFile not found (scripts/distribute.mjs writes it next to this script)." }
  try { $doc = [IO.File]::ReadAllText($lanesFile) | ConvertFrom-Json } catch { Stop-Config "$lanesFile is not valid JSON: $($_.Exception.Message)" }
  $all = @($doc.lanes)
  if ($all.Count -eq 0) { Stop-Config "$lanesFile declares no lanes." }
  return ,$all
}

function Find-Lane($all, $name) {
  $hit = @($all | Where-Object { [string]$_.name -ceq $name })
  if ($hit.Count -ne 1) { Stop-Config ("unknown lane '{0}'. Lanes in {1}: {2}" -f $name, $lanesFile, ((@($all | ForEach-Object { $_.name })) -join ', ')) }
  return $hit[0]
}

# Lane: the first argument, or -Lane <name>. Everything else goes to the daemon.
$laneName = $null
$passThrough = New-Object System.Collections.Generic.List[string]
for ($i = 0; $i -lt $args.Count; $i++) {
  $a = [string]$args[$i]
  if ($null -eq $laneName -and $a -eq '-Lane') {
    if ($i + 1 -ge $args.Count) { Stop-Config '-Lane needs a lane name.' }
    $laneName = [string]$args[$i + 1]; $i++; continue
  }
  if ($null -eq $laneName -and $i -eq 0 -and -not $a.StartsWith('-')) { $laneName = $a; continue }
  $passThrough.Add($a)
}

$lanes = Read-Lanes
if ($null -eq $laneName) {
  if ($lanes.Count -ne 1) { Stop-Config ("{0} declares {1} lanes; name one: run_daemon.bat <lane>. Lanes: {2}" -f $lanesFile, $lanes.Count, ((@($lanes | ForEach-Object { $_.name })) -join ', ')) }
  $laneName = [string]$lanes[0].name
}
$lane = Find-Lane $lanes $laneName
# The name becomes a directory: never trust a hand-edited lanes.json with a path.
if ($laneName -cnotmatch '^[a-z][a-z0-9_-]{0,31}$') { Stop-Config "lane name '$laneName' is not a valid lane name." }
$ProjectId = [string]$lane.projectId
$Resource  = [string]$lane.resource

$laneDir   = Join-Path (Join-Path $HERE 'lanes') $laneName
New-Item -ItemType Directory -Force -Path $laneDir | Out-Null
$tokenFile = Join-Path $laneDir 'pm_token.txt'
$stopFlag  = Join-Path $laneDir 'stop.flag'
$logFile   = Join-Path $laneDir 'supervisor.log'
$daemonLog = Join-Path $laneDir 'daemon.log'

function Write-SupLog($m) { $line = '[{0}] [{1}] {2}' -f (Get-Date).ToString('yyyy-MM-dd HH:mm:ss'), $laneName, $m; Write-Host $line; Add-Content -Path $logFile -Value $line }

if (-not (Test-Path -LiteralPath $tokenFile)) { Stop-Config "$tokenFile not found. Put lane $laneName's PM API token in it (see pm_token.txt.template)." }

# Single-instance guard per (project, resource): a named mutex the OS releases if this process dies.
$mutex = New-Object System.Threading.Mutex($false, "Global\pm-integrator-$ProjectId-$Resource")
try { $owned = $mutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $owned = $true }
if (-not $owned) {
  Write-Host "A pm-integrator supervisor for [$ProjectId / $Resource] (lane $laneName) is already running. Refusing to start a duplicate."
  exit 1
}

if (Test-Path -LiteralPath $stopFlag) { Remove-Item -LiteralPath $stopFlag -Force }
$script:child = $null
$exitCode = 0
$cleanup = {
  if ($script:child -and -not $script:child.HasExited) {
    try { Start-Process taskkill -ArgumentList '/PID', $script:child.Id, '/T', '/F' -NoNewWindow -Wait } catch {}
  }
}
try {
  Write-SupLog "supervisor started (bundle=$BundleName project=$ProjectId resource=$Resource)"
  $rapid = 0
  while ($true) {
    if (Test-Path -LiteralPath $stopFlag) { Write-SupLog 'stop.flag present - clean shutdown.'; Remove-Item -LiteralPath $stopFlag -Force; break }
    $now = Find-Lane (Read-Lanes) $laneName
    if ([string]$now.projectId -cne $ProjectId -or [string]$now.resource -cne $Resource) {
      Write-SupLog "lanes.json now names a different project/resource for lane $laneName; restart the supervisor."
      $exitCode = 2
      break
    }
    if (-not (Test-Path -LiteralPath $tokenFile)) { Write-SupLog "$tokenFile disappeared."; $exitCode = 2; break }
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = 'node'
    $psi.Arguments = '"{0}" --project {1} --resource {2} --pm-url {3} --stop-file "{4}"' -f $bundle, $ProjectId, $Resource, [string]$now.pmUrl, $stopFlag
    if ($passThrough.Count -gt 0) { $psi.Arguments += ' ' + ($passThrough -join ' ') }
    $psi.UseShellExecute = $false
    $psi.WorkingDirectory = $laneDir
    $envNames = @()
    if ($null -ne $now.env) {
      foreach ($p in $now.env.PSObject.Properties) { $psi.EnvironmentVariables[$p.Name] = [string]$p.Value; $envNames += $p.Name }
    }
    # Supervisor-owned, set AFTER the lane's env so no lane entry can shadow them.
    $psi.EnvironmentVariables['PM_API_TOKEN'] = ([IO.File]::ReadAllText($tokenFile)).Trim()
    $psi.EnvironmentVariables['PM_INTEGRATOR_LOG_FILE'] = $daemonLog
    # The daemon's verify children resolve a bare 'pm-verify.bat'; a Claude-spawned shell sets
    # NoDefaultCurrentDirectoryInExePath, which breaks that. Clear it for a clean-launch match.
    [void]$psi.EnvironmentVariables.Remove('NoDefaultCurrentDirectoryInExePath')
    $envText = if ($envNames.Count -gt 0) { $envNames -join ', ' } else { 'none' }
    Write-SupLog "starting integrator daemon (lane env: $envText)"
    $t0 = Get-Date
    $script:child = [System.Diagnostics.Process]::Start($psi)
    $script:child.WaitForExit()
    $code = $script:child.ExitCode
    $up = [int]((Get-Date) - $t0).TotalSeconds
    $script:child = $null
    if (Test-Path -LiteralPath $stopFlag) { Write-SupLog "daemon exited (code $code); stop.flag set - clean shutdown."; Remove-Item -LiteralPath $stopFlag -Force; break }
    if ($up -ge $MinHealthySeconds) { $rapid = 0; Write-SupLog "daemon exited after $($up)s (code $code) - restarting."; continue }
    $rapid++
    $delay = $BackoffSeconds[[Math]::Min($rapid - 1, $BackoffSeconds.Count - 1)]
    if ($rapid -ge $LoudAfter) { Write-SupLog "!! daemon crashed $rapid times fast (last $($up)s, code $code) - likely a bad pm_token.txt or the PM server is down. Still retrying every $($delay)s; check supervisor.log + the PM server." }
    else { Write-SupLog "daemon crashed after $($up)s (code $code) - backoff $($delay)s (#$rapid)." }
    Start-Sleep -Seconds $delay
  }
}
finally {
  & $cleanup
  try { $mutex.ReleaseMutex() } catch {}
  $mutex.Dispose()
  Write-SupLog 'supervisor exited.'
}
exit $exitCode
`;

// The POSIX supervisor: same contract as the .ps1. node (already required to
// run the daemon) reads lanes.json, so there is no jq/grep JSON parsing.
const SUPERVISOR_SH =
  String.raw`#!/usr/bin/env bash
# PM merge-train integrator daemon SUPERVISOR (generated by scripts/distribute.mjs; do not edit).
# ONE supervisor for every lane declared in lanes.json next to this script. Usage:
#   ./run_daemon.sh <lane> [extra daemon args]
# A lane's state lives in lanes/<lane>/: pm_token.txt (you create it), stop.flag (touch it to stop
# THAT lane; the daemon finishes its loop iteration via --stop-file), supervisor.log, daemon.log,
# supervisor.lock, and it is the daemon's working directory. lanes.json is re-read before every
# daemon start. Exit codes: 0 clean stop, 1 unexpected or duplicate, 2 configuration.
set -uo pipefail
DIR="$(cd "$(dirname "$` +
  "{BASH_SOURCE[0]}" +
  String.raw`")" && pwd)"
BUNDLE="$DIR/@@BUNDLE_NAME@@"
LANES="$DIR/lanes.json"
MIN_HEALTHY=60
BACKOFFS=(5 15 45 120 300)
LOUD_AFTER=5

die_config() { echo "ERROR: $1" >&2; exit 2; }

# lane_query <lane> <field|names|env>: one field of a lane, every lane name, or the lane's env as
# NUL-separated KEY=VALUE pairs. Exit 3 = unreadable lanes.json, 4 = no such lane.
lane_query() {
  node -e '
const fs = require("fs");
const [file, lane, what] = process.argv.slice(1);
let doc;
try { doc = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { console.error(e.message); process.exit(3); }
const lanes = Array.isArray(doc.lanes) ? doc.lanes : [];
if (what === "names") { process.stdout.write(lanes.map((l) => l.name).join(" ")); process.exit(0); }
const hit = lanes.filter((l) => l.name === lane);
if (hit.length !== 1) process.exit(4);
if (what === "env") {
  for (const [k, v] of Object.entries(hit[0].env || {})) process.stdout.write(k + "=" + v + String.fromCharCode(0));
} else {
  process.stdout.write(String(hit[0][what]));
}
' "$LANES" "$1" "$2"
}

[ -f "$LANES" ] || die_config "$LANES not found (scripts/distribute.mjs writes it next to this script)."
NAMES="$(lane_query "" names)" || die_config "$LANES is not valid JSON."
read -r -a NAME_LIST <<< "$NAMES"

LANE=""
if [ "$#" -ge 2 ] && [ "$1" = "-Lane" ]; then LANE="$2"; shift 2
elif [ "$#" -ge 1 ] && [ "$` +
  "{1#-}" +
  String.raw`" = "$1" ]; then LANE="$1"; shift
fi
if [ -z "$LANE" ]; then
  [ "$` +
  "{#NAME_LIST[@]}" +
  String.raw`" -eq 1 ] || die_config "$LANES declares $` +
  "{#NAME_LIST[@]}" +
  String.raw` lanes; name one: run_daemon.sh <lane>. Lanes: $NAMES"
  LANE="$` +
  "{NAME_LIST[0]}" +
  String.raw`"
fi
[[ "$LANE" =~ ^[a-z][a-z0-9_-]{0,31}$ ]] || die_config "unknown lane '$LANE'. Lanes: $NAMES"
PROJECT="$(lane_query "$LANE" projectId)" || die_config "unknown lane '$LANE'. Lanes: $NAMES"
RESOURCE="$(lane_query "$LANE" resource)"

LANE_DIR="$DIR/lanes/$LANE"
mkdir -p "$LANE_DIR"
TOKEN="$LANE_DIR/pm_token.txt"
STOPFLAG="$LANE_DIR/stop.flag"
LOG="$LANE_DIR/supervisor.log"
LOCK="$LANE_DIR/supervisor.lock"

log() { local m="[$(date '+%Y-%m-%d %H:%M:%S')] [$LANE] $1"; echo "$m"; echo "$m" >> "$LOG"; }

[ -f "$TOKEN" ] || die_config "$TOKEN not found. Put lane $LANE's PM API token in it (see pm_token.txt.template)."

# Single-instance guard: flock on an fd held for the process lifetime (auto-released on death).
# Lane names map 1:1 to (project, resource), so one lock per lane directory is one per train.
exec 9>"$LOCK"
if ! flock -n 9; then
  echo "A pm-integrator supervisor for lane $LANE is already running (lock $LOCK). Refusing to start a duplicate." >&2
  exit 1
fi

child=""
cleanup() { if [ -n "$child" ] && kill -0 "$child" 2>/dev/null; then kill -TERM "$child" 2>/dev/null; fi; }
trap 'cleanup; exit 0' INT TERM

[ -f "$STOPFLAG" ] && rm -f "$STOPFLAG"
rapid=0
exit_code=0
log "supervisor started (bundle=$(basename "$BUNDLE") project=$PROJECT resource=$RESOURCE)"
while true; do
  [ -f "$STOPFLAG" ] && { log "stop.flag present - clean shutdown."; rm -f "$STOPFLAG"; break; }
  now_project="$(lane_query "$LANE" projectId)" || { log "lane $LANE vanished from lanes.json."; exit_code=2; break; }
  now_resource="$(lane_query "$LANE" resource)"
  if [ "$now_project" != "$PROJECT" ] || [ "$now_resource" != "$RESOURCE" ]; then
    log "lanes.json now names a different project/resource for lane $LANE; restart the supervisor."; exit_code=2; break
  fi
  pm_url="$(lane_query "$LANE" pmUrl)"
  t0=$SECONDS
  log "starting integrator daemon..."
  (
    while IFS= read -r -d '' kv; do export "$kv"; done < <(lane_query "$LANE" env)
    # Supervisor-owned, set AFTER the lane's env so no lane entry can shadow them.
    PM_API_TOKEN="$(cat "$TOKEN")"; export PM_API_TOKEN
    export PM_INTEGRATOR_LOG_FILE="$LANE_DIR/daemon.log"
    cd "$LANE_DIR" || exit 1
    exec node "$BUNDLE" --project "$PROJECT" --resource "$RESOURCE" --pm-url "$pm_url" --stop-file "$STOPFLAG" "$@"
  ) &
  child=$!
  wait "$child"; code=$?
  child=""
  up=$((SECONDS - t0))
  [ -f "$STOPFLAG" ] && { log "daemon exited (code $code); stop.flag set - clean shutdown."; rm -f "$STOPFLAG"; break; }
  if [ "$up" -ge "$MIN_HEALTHY" ]; then rapid=0; log "daemon exited after $` +
  "{up}" +
  String.raw`s (code $code) - restarting."; continue; fi
  rapid=$((rapid + 1))
  idx=$((rapid - 1)); [ "$idx" -ge "$` +
  "{#BACKOFFS[@]}" +
  String.raw`" ] && idx=$(( $` +
  "{#BACKOFFS[@]}" +
  String.raw` - 1 ))
  delay="$` +
  "{BACKOFFS[$idx]}" +
  String.raw`"
  if [ "$rapid" -ge "$LOUD_AFTER" ]; then log "!! daemon crashed $` +
  "{rapid}" +
  String.raw`x fast (last $` +
  "{up}" +
  String.raw`s, code $code) - likely a bad pm_token.txt or the PM server is down. Retrying in $` +
  "{delay}" +
  String.raw`s."; else log "daemon crashed after $` +
  "{up}" +
  String.raw`s (code $code) - backoff $` +
  "{delay}" +
  String.raw`s (#$` +
  "{rapid}" +
  String.raw`)."; fi
  sleep "$delay"
done
exit "$exit_code"
`;

/**
 * Render one generated launcher. `kind` is "bat" (Windows, CRLF), "ps1" (the
 * Windows supervisor, CRLF) or "sh" (POSIX supervisor, LF). The only input is
 * the bundle's file name: lanes (project ids, resources, env) are DATA in
 * lanes.json, never code, so no launcher carries a project id.
 */
export function renderDaemonLauncher(kind, { bundleName }) {
  if (!BUNDLE_NAME_PATTERN.test(bundleName)) {
    throw new Error(`bundle name "${bundleName}" must match ${BUNDLE_NAME_PATTERN}`);
  }
  if (kind === "bat") {
    // Thin invoker: the supervision lives in run_daemon_supervised.ps1 next to this file, so
    // `run_daemon.bat <lane>` stays the one command an operator runs.
    return [
      "@echo off",
      "rem PM merge-train integrator daemon launcher (generated by scripts/distribute.mjs).",
      "rem Usage: run_daemon.bat <lane> [extra daemon args]   -- lanes are declared in lanes.json here.",
      "rem SUPERVISED: run_daemon_supervised.ps1 (next to this file) restarts the daemon on crash with",
      "rem backoff, refuses a duplicate via a named mutex, and stops the lane cleanly on",
      "rem lanes\\<lane>\\stop.flag or Ctrl+C. Put each lane's PM API token in lanes\\<lane>\\pm_token.txt.",
      'powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0run_daemon_supervised.ps1" %*',
      "",
    ].join("\r\n");
  }
  if (kind === "ps1") {
    return SUPERVISOR_PS1.replace("@@BUNDLE_NAME@@", bundleName).replace(/\r?\n/g, "\r\n");
  }
  if (kind === "sh") {
    return SUPERVISOR_SH.replace("@@BUNDLE_NAME@@", bundleName);
  }
  throw new Error(`Unknown launcher kind: "${kind}" (expected "bat", "ps1", or "sh")`);
}

/**
 * The generated files next to a target's integrator bundle: the supervisor
 * trio, `lanes.json` and `pm_token.txt.template` -- or nothing, for a target
 * with no lanes. `pm_token.txt` (the real secret) is never written or touched.
 */
export function launcherArtifacts(config, target) {
  const lanes = lanesFor(config, target);
  if (lanes.length === 0) return [];
  const dir = dirname(target.integratorDest);
  const bundleName = basename(target.integratorDest);
  const contents = {
    "run_daemon.bat": renderDaemonLauncher("bat", { bundleName }),
    "run_daemon_supervised.ps1": renderDaemonLauncher("ps1", { bundleName }),
    "run_daemon.sh": renderDaemonLauncher("sh", { bundleName }),
    "lanes.json": renderLanesJson(lanes),
    "pm_token.txt.template": TOKEN_TEMPLATE_CONTENT,
  };
  return LAUNCHER_FILES.map((name) => ({
    dest: join(dir, name),
    payload: Buffer.from(contents[name], "utf8"),
    label: name === "lanes.json" ? "the distribute config's lanes" : "scripts/distribute.mjs",
  }));
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

const RECEIPT_BASENAME = "distribute.receipt.json";

/** The receipt lives beside the config it belongs to, and is gitignored like it. */
export function receiptPathFor(configPath) {
  return join(dirname(resolve(configPath)), RECEIPT_BASENAME);
}

export function loadReceipt(receiptPath) {
  if (!existsSync(receiptPath)) return {};
  try {
    const parsed = JSON.parse(readFileSync(receiptPath, "utf8"));
    return parsed && typeof parsed === "object" && parsed.writes ? parsed.writes : {};
  } catch {
    // A corrupt receipt must not silently behave like "no record" -- that is the
    // permissive direction, and the permissive direction is what this guards.
    throw new Error(
      `Receipt at ${receiptPath} is unreadable. Delete it and re-run with ` +
        `--accept-existing after checking each destination, or restore it.`,
    );
  }
}

export function saveReceipt(receiptPath, writes) {
  const body = JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), writes }, null, 2);
  writeFileSync(receiptPath, body + String.fromCharCode(10));
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

/**
 * The banner every distributed artifact carries. A destination that says what
 * wrote it is a destination somebody is less likely to hand-edit; the receipt
 * catches the ones who do it anyway.
 *
 * Markdown gets an HTML comment (invisible when rendered). JS gets `//`, placed
 * AFTER the shebang -- both bundles begin `#!/usr/bin/env node`, and a comment
 * above that line would stop them being executable.
 */
export function applyBanner(contents, destPath, sourceLabel) {
  const text = contents.toString("utf8");
  const line = (open, close) =>
    `${open} GENERATED by scripts/distribute.mjs from ${sourceLabel} -- ` +
    `edits here are overwritten, and are refused until you pass --force. ${close}`;

  const EOL = String.fromCharCode(10);

  if (/\.mdx?$/i.test(destPath)) {
    return Buffer.from(line("<!--", "-->") + EOL + EOL + text, "utf8");
  }
  if (/\.(mjs|cjs|js)$/i.test(destPath)) {
    if (text.startsWith("#!")) {
      const nl = text.indexOf(EOL);
      const shebang = nl === -1 ? text : text.slice(0, nl);
      const rest = nl === -1 ? "" : text.slice(nl + 1);
      return Buffer.from(shebang + EOL + line("//", "") + EOL + rest, "utf8");
    }
    return Buffer.from(line("//", "") + EOL + text, "utf8");
  }
  return contents;
}

/**
 * Write one artifact, refusing to clobber a destination that changed since we
 * last wrote it.
 *
 * The decision, in full:
 *   recorded && current === recorded  -> ours, untouched. Write.
 *   recorded && current !== recorded  -> edited downstream since our last write.
 *                                        REFUSE unless --force.
 *   no record && destination absent   -> nothing to lose. Write.
 *   no record && already identical    -> writing changes nothing. Write.
 *   no record && differs             -> we CANNOT tell a hand-edit from a stale
 *                                        copy. REFUSE unless --accept-existing.
 * The last case is the bootstrap, and it is deliberately not permissive: "we have
 * no record" is exactly the state in which the 2026-09-19 revert would have gone
 * through unremarked.
 */
function writeArtifact(payload, dest, opts) {
  const { dryRun, receipt, acceptExisting, force, sourceLabel, quiet = false, guard = true } = opts;
  const say = (msg) => {
    if (!quiet) console.log(msg);
  };
  const next = sha256(payload);
  const recorded = receipt[dest];
  const present = existsSync(dest);
  const current = present ? sha256(readFileSync(dest)) : null;

  if (guard && present && recorded && current !== recorded) {
    if (!force) {
      throw new Error(
        [
          `Refusing to overwrite ${dest}: it has changed since distribute last wrote it.`,
          `  expected sha256 ${recorded}`,
          `  found    sha256 ${current}`,
          ``,
          `This is NOT the expected first-run case — distribute wrote this file, and it has`,
          `changed since. Someone edited the destination. Read the diff and decide: move the`,
          `change upstream into ${sourceLabel}, or drop this path from the config if it is`,
          `locally owned now. --force overwrites it and DISCARDS that edit; it is a decision`,
          `about somebody else's work, not a way past an error.`,
        ].join(String.fromCharCode(10)),
      );
    }
    say(`  [force] overwriting diverged ${dest}`);
  } else if (guard && present && !recorded && current !== next) {
    if (!acceptExisting) {
      throw new Error(
        [
          `Refusing to overwrite ${dest}: there is no record of distribute having written it,`,
          `and it differs from what would be written now.`,
          ``,
          `THIS IS EXPECTED ON THE FIRST RUN AFTER RECEIPTS WERE ADOPTED. There is no receipt`,
          `yet, so every destination refuses exactly once. It is not a fault and nothing is`,
          `wrong with your build.`,
          ``,
          `Without a record, a deliberate downstream edit and a merely-stale copy look`,
          `identical, and this tool has silently destroyed the former before. So:`,
          `  1. Diff each destination against its source (this one: ${sourceLabel}).`,
          `  2. If a destination holds something the source does not, move it UPSTREAM or drop`,
          `     that path from the config — it is locally owned now, not generated.`,
          `  3. When every destination holds nothing you need, re-run once with --accept-existing.`,
          `Do NOT reach for --force here: it discards whatever the destination holds, which is`,
          `the one outcome this refusal exists to prevent.`,
        ].join(String.fromCharCode(10)),
      );
    }
    say(`  [accept-existing] adopting unrecorded ${dest}`);
  }

  if (dryRun) {
    say(`  [dry-run] would write ${dest} (from ${sourceLabel})`);
    return next;
  }
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, payload);
  say(`  wrote ${dest} (from ${sourceLabel})`);
  return next;
}

/** Every artifact one target receives: {dest, payload, label}, in write order. */
function plannedArtifacts(config, target, sources) {
  const vendored = [
    ["mcpDest", sources.mcpBundle, "packages/mcp-server/dist/bundle/pm-mcp-server.mjs"],
    [
      "integratorDest",
      sources.integratorBundle,
      "packages/integrator-ref/dist/bundle/pm-integrator.mjs",
    ],
    ["docsDest", sources.docs, "docs/integrator-deployment.md"],
    ["workerDocDest", sources.workerDoc, "docs/worker-pm-workflow.md"],
  ]
    .filter(([field]) => target[field] !== undefined)
    .map(([field, src, label]) => ({
      dest: target[field],
      payload: applyBanner(readFileSync(src), target[field], label),
      label,
    }));
  return [...vendored, ...launcherArtifacts(config, target)];
}

/**
 * Orchestrator. Builds the bundles (unless build === false), resolves + asserts
 * the four sources, then copies them to each target. `dryRun` skips BOTH the
 * build and every copy (logs intentions, writes nothing).
 */
export function distribute({
  config,
  repoRoot: root,
  dryRun = false,
  build = true,
  receiptPath = null,
  acceptExisting = false,
  force = false,
}) {
  validateConfig(config);
  if (build && !dryRun) {
    runBuild(root);
  } else if (dryRun) {
    console.log("[dry-run] skipping build");
  }

  const sources = resolveSources(root);
  const receipt = receiptPath ? loadReceipt(receiptPath) : {};
  const written = { ...receipt };
  const guardOpts = { receipt, acceptExisting, force, guard: Boolean(receiptPath) };

  const plans = config.targets.map((target) => ({
    target,
    artifacts: plannedArtifacts(config, target, sources),
  }));

  // Every destination of EVERY target is checked before any of them is written,
  // so a refusal on the last file cannot leave the others already replaced. A
  // half-applied distribution is its own silent-divergence source.
  for (const { artifacts } of plans) {
    for (const { dest, payload, label } of artifacts) {
      writeArtifact(payload, dest, { ...guardOpts, dryRun: true, sourceLabel: label, quiet: true });
    }
  }

  for (const { target, artifacts } of plans) {
    console.log(`\nTarget: ${target.name}`);
    for (const { dest, payload, label } of artifacts) {
      written[dest] = writeArtifact(payload, dest, { ...guardOpts, dryRun, sourceLabel: label });
    }

    if (!dryRun) {
      console.log(`Distributed to "${target.name}":`);
      for (const field of ARTIFACT_FIELDS) {
        if (target[field] !== undefined) console.log(`  ${field.padEnd(16)} -> ${target[field]}`);
      }
      const lanes = lanesFor(config, target);
      if (lanes.length > 0) {
        const launcherDir = dirname(target.integratorDest);
        console.log(
          `  Supervisor         -> ${join(launcherDir, "run_daemon.bat")} <lane> (+ .ps1, .sh, lanes.json)`,
        );
        for (const lane of lanes) {
          console.log(
            `  lane ${lane.name}: project ${lane.projectId} resource ${lane.resource}; token -> ${join(launcherDir, "lanes", lane.name, "pm_token.txt")}`,
          );
        }
      }
      if (target.mcpDest !== undefined) {
        console.log(
          "  Restart any running Claude Code session in this target to pick up the new MCP bundle.",
        );
      }
    }
  }

  if (receiptPath && !dryRun) {
    saveReceipt(receiptPath, written);
    console.log(`\nReceipt updated: ${receiptPath}`);
  }
  return written;
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
    distribute({
      config,
      repoRoot,
      dryRun: args.dryRun,
      receiptPath: receiptPathFor(args.config),
      acceptExisting: args.acceptExisting,
      force: args.force,
    });
    console.log(args.dryRun ? "\n[dry-run] complete — nothing written." : "\nDone.");
  } catch (err) {
    console.error(`\nDistribute failed: ${err.message}`);
    process.exit(1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
