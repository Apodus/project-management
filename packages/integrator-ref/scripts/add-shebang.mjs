import { readFileSync, writeFileSync, chmodSync } from "node:fs";
const path = "dist/index.js";
const src = readFileSync(path, "utf8");
if (!src.startsWith("#!")) {
  writeFileSync(path, `#!/usr/bin/env node\n${src}`);
}
try {
  chmodSync(path, 0o755);
} catch {
  // Windows: no-op.
}
