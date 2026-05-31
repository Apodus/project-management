import { build } from "esbuild";
import { mkdirSync, writeFileSync, statSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const outfile = join(__dirname, "..", "dist", "bundle", "pm-mcp-server.mjs");

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
    // Node built-ins. ulid (a transitive dep) calls require("crypto") eagerly at
    // import for its secure PRNG and otherwise throws "secure crypto unusable".
    // Inject a real createRequire so require("crypto") resolves to Node's module.
    js: [
      "#!/usr/bin/env node",
      "import { createRequire as __pmCreateRequire } from 'node:module';",
      "const require = __pmCreateRequire(import.meta.url);",
    ].join("\n"),
  },
  external: [],
  minify: true,
  sourcemap: false,
});

const size = statSync(outfile).size;
const sizeKB = (size / 1024).toFixed(1);
console.log(`Bundled: ${outfile} (${sizeKB} KB)`);
