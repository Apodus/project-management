import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Single source of truth: write src/version.ts from this package's
// package.json "version". Run on both `dev` and `build` so the literal is
// embedded into the compiled output AND the standalone esbuild bundle (which
// ships with no package.json alongside it). The generated file is gitignored.
const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgPath = join(__dirname, "..", "package.json");
const outPath = join(__dirname, "..", "src", "version.ts");

const { version } = JSON.parse(readFileSync(pkgPath, "utf8"));

const contents = `// GENERATED FILE — do not edit. Written by scripts/gen-version.mjs from
// package.json on dev/build. Gitignored. This is the single source of truth
// for the version reported at runtime (works in dev + bundled modes).
export const VERSION = ${JSON.stringify(version)};
`;

writeFileSync(outPath, contents);
console.log(`Wrote ${outPath} (VERSION=${version})`);
