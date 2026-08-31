#!/usr/bin/env node
/**
 * Pin the PM server's deployed artifact, so a deployment is a thing someone
 * DID rather than whatever the working tree last built.
 *
 * ── Why this exists ───────────────────────────────────────────────────────
 *
 * `start:prod` used to run `node packages/server/dist/index.js` — the build
 * OUTPUT directory. On a machine that is both the dev checkout and the live
 * host (which is exactly the game_one layout), that makes every `pnpm build`
 * a silent redeploy-in-waiting: the running process keeps the code it loaded
 * at startup, but the artifact on disk has already changed, so the NEXT
 * restart ships whatever the tree happened to contain.
 *
 * The sharpest instance is `pnpm test:e2e`. `playwright.config.ts`'s
 * `webServer.command` begins with `pnpm build`, so running the E2E suite —
 * an action nobody thinks of as a deployment — rewrites the live server's
 * artifact. Turbo's cache hides it whenever the tree matches the last build;
 * it fires precisely when the tree does NOT match, i.e. when someone runs
 * E2E from a feature branch. That is the dangerous case and the silent one.
 *
 * NOT fixed by giving E2E its own build output: an end-to-end test SHOULD
 * build and exercise the real artifact. The coupling to break is on the
 * deployment side, not the test side.
 *
 * ── What it does ──────────────────────────────────────────────────────────
 *
 * Copies the built server and web output into `packages/server/.deploy/`,
 * alongside a manifest recording the git SHA, branch, dirty flag and time.
 * The live server runs from THAT copy, so a later `pnpm build` (or E2E run,
 * or branch switch) cannot change what is deployed. Redeploying is explicit:
 * run this script again.
 *
 * ── Why `packages/server/.deploy/` and not a directory outside the repo ───
 *
 * Node resolves `node_modules` by walking up from the module's own directory.
 * `packages/server/.deploy/server/index.js` walks up through
 * `packages/server/node_modules` (where pnpm links `@pm/shared` and the
 * native better-sqlite3 build) and then the root — the SAME chain as
 * `packages/server/dist/index.js`. A copy outside the repo would miss the
 * package-level link and need its own install. Verified by running the copy
 * standalone before this script was written.
 */

import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverDist = path.join(repoRoot, "packages", "server", "dist");
const webDist = path.join(repoRoot, "packages", "web", "dist");
const deployRoot = path.join(repoRoot, "packages", "server", ".deploy");
const deployServer = path.join(deployRoot, "server");
const deployWeb = path.join(deployRoot, "web");
const migrationsSrc = path.join(repoRoot, "packages", "server", "src", "db", "migrations");

function git(args) {
  try {
    return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

async function main() {
  for (const [label, dir] of [
    ["server", serverDist],
    ["web", webDist],
  ]) {
    if (!existsSync(dir)) {
      console.error(`Missing ${label} build output: ${dir}`);
      console.error("Run `pnpm build` first.");
      process.exit(1);
    }
  }

  // Replace wholesale rather than merging: a stale file left behind by an
  // older build is the same class of lie this script exists to prevent.
  await rm(deployRoot, { recursive: true, force: true });
  await mkdir(deployRoot, { recursive: true });
  await cp(serverDist, deployServer, { recursive: true });
  await cp(webDist, deployWeb, { recursive: true });

  // ── Migrations, and why they must be copied ──────────────────────────────
  //
  // `tsc` emits only JS, so `dist/db/migrations` does not exist. The server's
  // `resolveMigrationsFolder()` therefore takes its documented fallback —
  // `../../src/db/migrations` relative to the running module — which means a
  // server started from `dist/` reads its migrations OUT OF THE WORKING TREE.
  //
  // That is a sharper form of the hazard this script exists to close: the
  // artifact is pinned but the schema history it applies is not, so a branch
  // switch changes which migrations a restarting production server runs. The
  // repo's own migration rules (CLAUDE.md: journal order is load-bearing, and
  // boot FAILS LOUD if an applied migration is missing) make that a genuinely
  // dangerous coupling, not a cosmetic one.
  //
  // Copying them to `db/migrations` INSIDE the pinned server satisfies
  // `resolveMigrationsFolder()`'s FIRST check (adjacent to the module), so the
  // deployed server never consults `src/` at all.
  if (!existsSync(migrationsSrc)) {
    console.error(`Missing migrations: ${migrationsSrc}`);
    process.exit(1);
  }
  await cp(migrationsSrc, path.join(deployServer, "db", "migrations"), { recursive: true });

  const manifest = {
    deployedAt: new Date().toISOString(),
    sha: git(["rev-parse", "HEAD"]),
    shortSha: git(["rev-parse", "--short", "HEAD"]),
    branch: git(["rev-parse", "--abbrev-ref", "HEAD"]),
    // A dirty tree is not refused — sometimes you genuinely need to deploy a
    // local fix — but it IS recorded, so "what is deployed?" always has a
    // truthful answer rather than a plausible one.
    dirty: git(["status", "--porcelain"]).length > 0,
    source: { server: serverDist, web: webDist, migrations: migrationsSrc },
  };
  await writeFile(path.join(deployRoot, "MANIFEST.json"), JSON.stringify(manifest, null, 2) + "\n");

  console.log("Pinned PM server artifact:");
  console.log(`  server -> ${deployServer}`);
  console.log(`  web    -> ${deployWeb}`);
  console.log(
    `  migrations -> ${path.join(deployServer, "db", "migrations")} (no longer read from src/)`,
  );
  console.log(
    `  commit -> ${manifest.shortSha} (${manifest.branch})${manifest.dirty ? " DIRTY" : ""}`,
  );
  console.log("");
  console.log("Start it with:");
  console.log("  pnpm start:prod");
  console.log("");
  console.log("A later `pnpm build`, branch switch, or `pnpm test:e2e` cannot change this copy.");
  console.log("Re-run `pnpm deploy:server` to move the deployment forward.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
