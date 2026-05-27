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
    js: "#!/usr/bin/env node\n",
  },
  external: [],
  minify: true,
  sourcemap: false,
});

const size = statSync(outfile).size;
const sizeKB = (size / 1024).toFixed(1);
console.log(`Bundled: ${outfile} (${sizeKB} KB)`);
