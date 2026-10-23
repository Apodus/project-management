import { lstat, readdir, rm, unlink } from "node:fs/promises";
import path from "node:path";
import type { SimpleGit } from "simple-git";
import type { Logger } from "./logger.js";

/**
 * C4-P3 — a slot holds no nested repository that HEAD does not declare.
 *
 * ── Why this is STATE, not a transition ─────────────────────────────────────
 *
 * The engine-independence cutover retires two submodules (`rynx`,
 * `tools/rynx-treegen`) in the CANDIDATE itself. The slot that verifies that
 * candidate was populated by the PREVIOUS request and moves to the candidate by
 * a checkout; no reset ever spans old→new, and a `clean_keep` entry such as
 * `rynx/build` keeps the retired directory alive across the clean that does
 * run. A rule keyed on "HEAD changed across a reset" therefore never fires.
 * What is checkable is the STATE: before any verify, every nested repository on
 * disk is one HEAD declares (a 160000 entry), and nothing else survives.
 *
 * ── What counts as a nested repository ──────────────────────────────────────
 *
 * - FOUND: a directory under the slot root that contains a `.git` file or
 *   directory (the walk prunes AT a found repository: what is inside it is its
 *   own business), and every module gitdir `<root>/.git/modules/<name>` (a
 *   directory holding a `HEAD`), which outlives its checkout and is what makes a
 *   retired submodule come back on the next `submodule update`.
 * - DECLARED: the 160000 entries of `git ls-tree -r HEAD`. A module gitdir is
 *   declared when HEAD's `.gitmodules` maps its NAME to a declared path (the name
 *   defaults to the path); a module no `.gitmodules` at HEAD names is judged by
 *   its name as a path.
 *
 * There is NO exemption list. A store of engine checkouts under the slot would be
 * a nested repository like any other; the store policy keeps it outside the
 * checkout under verify (engine_store_policy.ps1, exit 8), so a slot never has
 * one and nothing here needs to know that.
 *
 * ── Cost ────────────────────────────────────────────────────────────────────
 *
 * The walk reads directory entries only (`readdir` with file types); it never
 * stats a file and prunes by NAME the trees where build products live
 * ({@link PRUNED_DIRECTORY_NAMES}, {@link PRUNED_DIRECTORY_PATHS}), so its cost
 * does not grow with the size of a slot's build output. {@link NestedRepoSweepResult.walkMs}
 * is returned and logged; a sweep over {@link SLOW_SWEEP_MS} on a warm slot is a bug.
 *
 * ── Safety ──────────────────────────────────────────────────────────────────
 *
 * Every path is asserted under the slot root ({@link assertUnderRoot}) before it
 * is touched; anything else is refused. Tracked content is never deleted: when
 * HEAD tracks files under a found repository's directory only its `.git` is
 * removed. A symbolic link or junction is unlinked, never recursed into.
 * Uncertainty (no HEAD, not a git repository) removes NOTHING.
 */

/** Directory names the walk does not descend into: build output, scratch and vendored trees. */
export const PRUNED_DIRECTORY_NAMES: readonly string[] = [
  "build",
  "build_temp",
  "prof",
  "logs",
  "external",
  "node_modules",
];

/** Two-segment paths pruned the same way (POSIX, relative to the slot root). */
export const PRUNED_DIRECTORY_PATHS: readonly string[] = ["generate/build"];

/** A sweep slower than this on a warm slot is logged as a bug (R5-minors). */
export const SLOW_SWEEP_MS = 5000;

export interface NestedRepoRemoval {
  /** POSIX path relative to the slot root: the repository directory, or `.git/modules/<name>`. */
  path: string;
  kind: "checkout" | "module" | "git-dir-only";
  reason: string;
  headSha: string;
  /** `clean_keep` entries that lived under the removed path and went with it. */
  droppedCleanKeep: string[];
}

export interface NestedRepoSweepResult {
  removed: NestedRepoRemoval[];
  /** Directories read by the walk. */
  directoriesRead: number;
  walkMs: number;
  /** Set when the sweep deliberately did nothing because it could not be sure (no HEAD, not a repository). */
  skipped: string | null;
}

export interface NestedRepoSweepOptions {
  /** A SimpleGit bound to the slot (any directory inside it); the walk starts at its toplevel. */
  git: SimpleGit;
  /** Entries of the lane's `clean_keep`; those under a removed path are reported as dropped. */
  cleanKeep?: readonly string[];
  logger?: Logger;
}

export class NestedRepoSweepError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NestedRepoSweepError";
  }
}

/**
 * Refuse any path that is not strictly inside `root`: the root itself, a `..`
 * escape, an absolute path on another drive or any non-string input. Returns the
 * resolved path. The single guard every removal goes through.
 */
export function assertUnderRoot(root: string, candidate: string): string {
  if (typeof candidate !== "string" || candidate.length === 0) {
    throw new NestedRepoSweepError(`refusing an empty path under ${root}`);
  }
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, candidate);
  const rel = path.relative(resolvedRoot, resolved);
  if (rel === "" || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new NestedRepoSweepError(
      `refusing ${candidate}: ${resolved} is not inside the slot ${resolvedRoot}`,
    );
  }
  return resolved;
}

function posix(p: string): string {
  return p.split(path.sep).join("/");
}

async function gitText(git: SimpleGit, args: string[]): Promise<string | null> {
  try {
    return await git.raw(args);
  } catch {
    return null;
  }
}

/** Gitlink paths HEAD declares, and the paths HEAD tracks files under (for the tracked-content guard). */
async function readHeadTree(
  git: SimpleGit,
): Promise<{ gitlinks: Set<string>; tracked: string[] } | null> {
  const out = await gitText(git, ["ls-tree", "-r", "-z", "HEAD"]);
  if (out === null) return null;
  const gitlinks = new Set<string>();
  const tracked: string[] = [];
  for (const rec of out.split("\0")) {
    if (!rec) continue;
    const tab = rec.indexOf("\t");
    if (tab < 0) continue;
    const mode = rec.slice(0, rec.indexOf(" "));
    const file = rec.slice(tab + 1);
    if (mode === "160000") gitlinks.add(file);
    else {
      tracked.push(file);
    }
  }
  return { gitlinks, tracked };
}

/** submodule name -> path from HEAD's `.gitmodules` (empty when HEAD has none). */
async function readModuleNames(git: SimpleGit): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const out = await gitText(git, [
    "config",
    "--blob",
    "HEAD:.gitmodules",
    "--get-regexp",
    "^submodule\\..*\\.path$",
  ]);
  if (!out) return names;
  for (const line of out.split("\n")) {
    const m = /^submodule\.(.+)\.path (.+)$/.exec(line.trim());
    if (m) names.set(m[1], m[2].trim());
  }
  return names;
}

async function isModuleGitDir(dir: string): Promise<boolean> {
  try {
    return (await lstat(path.join(dir, "HEAD"))).isFile();
  } catch {
    return false;
  }
}

/** Module gitdirs under `<gitDir>/modules`, as names relative to it (POSIX). Does not descend into a module. */
async function findModuleGitDirs(modulesDir: string): Promise<string[]> {
  const found: string[] = [];
  async function walk(dir: string, rel: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const child = path.join(dir, e.name);
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (await isModuleGitDir(child)) found.push(childRel);
      else await walk(child, childRel);
    }
  }
  await walk(modulesDir, "");
  return found;
}

async function removeTree(root: string, target: string): Promise<void> {
  const resolved = assertUnderRoot(root, target);
  let info;
  try {
    info = await lstat(resolved);
  } catch {
    return; // already gone
  }
  if (info.isSymbolicLink()) {
    // A junction/symlink is removed as a link; its target is not ours to delete.
    await unlink(resolved).catch(async () => rm(resolved, { force: true, recursive: false }));
    return;
  }
  await rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

/**
 * Remove every nested repository under the slot that HEAD does not declare.
 * Idempotent, returns what it removed. Throws {@link NestedRepoSweepError} when a
 * removal fails (the slot would otherwise verify against a retired tree).
 */
export async function sweepUndeclaredNestedRepos(
  opts: NestedRepoSweepOptions,
): Promise<NestedRepoSweepResult> {
  const started = Date.now();
  const empty = (skipped: string | null): NestedRepoSweepResult => ({
    removed: [],
    directoriesRead: 0,
    walkMs: Date.now() - started,
    skipped,
  });
  const git = opts.git;

  // One git spawn on the common path: the root and the common gitdir (where module gitdirs live).
  let toplevel: string;
  let commonDir: string;
  try {
    [toplevel, commonDir] = (
      await git.raw(["rev-parse", "--show-toplevel", "--path-format=absolute", "--git-common-dir"])
    )
      .split(/\r?\n/)
      .map((l) => l.trim());
    if (!toplevel || !commonDir) throw new Error("unexpected rev-parse output");
  } catch {
    return empty("not a git repository"); // uncertain: remove nothing
  }
  const root = path.resolve(toplevel);
  const modulesDir = path.join(path.resolve(commonDir), "modules");

  const prunedPaths = new Set(PRUNED_DIRECTORY_PATHS);
  const prunedNames = new Set(PRUNED_DIRECTORY_NAMES);
  const found: string[] = [];
  let directoriesRead = 0;

  async function walk(dir: string, rel: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    directoriesRead++;
    // A directory with a .git entry IS a repository: record it and stop (what is inside is its own business).
    if (rel !== "" && entries.some((e) => e.name === ".git")) {
      found.push(rel);
      return;
    }
    for (const e of entries) {
      // Never follow a link out of the slot; files are never stat'ed.
      if (!e.isDirectory() || e.name === ".git") continue;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (prunedNames.has(e.name) || prunedPaths.has(childRel)) continue;
      await walk(path.join(dir, e.name), childRel);
    }
  }
  await walk(root, "");
  const moduleDirs = await findModuleGitDirs(modulesDir);

  // Nothing nested on disk: nothing to judge, so no further git is spent (the common case on every checkout).
  if (found.length === 0 && moduleDirs.length === 0) {
    return { removed: [], directoriesRead, walkMs: Date.now() - started, skipped: null };
  }

  const head = await gitText(git, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
  if (head === null || head.trim() === "") return empty("no HEAD"); // unborn: remove nothing
  const headSha = head.trim();
  const tree = await readHeadTree(git);
  if (tree === null) return empty("ls-tree failed"); // uncertain: remove nothing

  const removals: NestedRepoRemoval[] = [];
  const cleanKeep = (opts.cleanKeep ?? []).map((p) => p.replace(/\\/g, "/").replace(/\/+$/, ""));
  const droppedFor = (p: string) => cleanKeep.filter((k) => k === p || k.startsWith(`${p}/`));
  const log = opts.logger;

  // 1. Working-tree repositories HEAD does not declare.
  for (const rel of found) {
    if (tree.gitlinks.has(rel)) continue; // declared: `submodule update` manages it
    const abs = assertUnderRoot(root, rel);
    const dropped = droppedFor(rel);
    const trackedUnder = tree.tracked.some((f) => f === rel || f.startsWith(`${rel}/`));
    if (trackedUnder) {
      // Tracked files live here: only the repository-ness goes, never the content.
      await removeTree(root, path.join(abs, ".git"));
      removals.push({
        path: `${rel}/.git`,
        kind: "git-dir-only",
        reason: `nested repository '${rel}' undeclared at HEAD (tracked content kept)`,
        headSha,
        droppedCleanKeep: [],
      });
      continue;
    }
    // A registered-but-retired submodule: deinit is best-effort, the removal below is what matters.
    await gitText(git, ["submodule", "deinit", "-f", "--", rel]);
    await removeTree(root, abs);
    removals.push({
      path: rel,
      kind: "checkout",
      reason: `nested repository '${rel}' undeclared at HEAD`,
      headSha,
      droppedCleanKeep: dropped,
    });
  }

  // 2. Module gitdirs HEAD does not declare (they outlive their checkout).
  const moduleNames = await readModuleNames(git);
  for (const name of moduleDirs) {
    const modulePath = moduleNames.get(name) ?? name;
    if (tree.gitlinks.has(modulePath)) continue;
    const rel = posix(path.relative(root, path.join(modulesDir, ...name.split("/"))));
    await removeTree(root, path.join(modulesDir, ...name.split("/")));
    removals.push({
      path: rel,
      kind: "module",
      reason: `module gitdir '${name}' undeclared at HEAD`,
      headSha,
      droppedCleanKeep: droppedFor(modulePath),
    });
  }

  const result: NestedRepoSweepResult = {
    removed: removals,
    directoriesRead,
    walkMs: Date.now() - started,
    skipped: null,
  };
  for (const r of removals) {
    for (const k of r.droppedCleanKeep) {
      log?.warn(
        { cleanKeep: k, parent: r.path, headSha },
        `clean_keep entry '${k}' dropped: parent nested repo '${r.path}' undeclared at HEAD`,
      );
    }
    log?.warn({ path: r.path, kind: r.kind, reason: r.reason, headSha }, "nested_repo_removed");
  }
  if (result.walkMs > SLOW_SWEEP_MS) {
    log?.warn(
      { walkMs: result.walkMs, directoriesRead },
      `nested_repo_sweep_slow: ${result.walkMs} ms exceeds ${SLOW_SWEEP_MS} ms; file a bug note`,
    );
  }
  return result;
}

/** Read for tests: does `<root>/.git/modules/<name>` exist. */
export async function moduleGitDirExists(root: string, name: string): Promise<boolean> {
  return isModuleGitDir(path.join(root, ".git", "modules", ...name.split("/")));
}
