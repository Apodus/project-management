import { build } from "esbuild";
import { mkdirSync, statSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const outfile = join(__dirname, "..", "dist", "bundle", "pm-integrator.mjs");

mkdirSync(dirname(outfile), { recursive: true });

const result = await build({
  entryPoints: [join(__dirname, "..", "dist", "index.js")],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  outfile,
  banner: {
    // ESM bundle has no real `require`; esbuild's dynamic-require shim throws on
    // Node built-ins. Several transitive deps (ulid's crypto PRNG, pino's
    // internal lazy requires) call require(...) eagerly. Inject a real
    // createRequire so those resolve to Node's module system. Mirrors the
    // mcp-server bundle.
    // No shebang here: the entry (dist/index.js) already carries one from
    // add-shebang.mjs, and esbuild hoists that hashbang to line 1. Adding it
    // in the banner too would emit a second `#!` on line 2 (a syntax error).
    js: [
      "import { createRequire as __pmCreateRequire } from 'node:module';",
      "const require = __pmCreateRequire(import.meta.url);",
    ].join("\n"),
  },
  external: [],
  minify: true,
  sourcemap: false,
});

if (result.warnings.length) {
  for (const w of result.warnings) console.warn(w.text);
}

const size = statSync(outfile).size;
const sizeKB = (size / 1024).toFixed(1);
console.log(`Bundled: ${outfile} (${sizeKB} KB)`);
