/**
 * Export the OpenAPI spec to a static JSON file.
 *
 * Usage: tsx packages/server/src/scripts/export-openapi.ts
 *
 * This creates the app without starting a server, fetches the OpenAPI
 * spec from the internal route, and writes it to packages/server/openapi.json.
 */
import { createApp } from "../app.js";
import { initializeDatabase, closeDb } from "../db/index.js";
import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main() {
  // Initialize an in-memory DB just for schema purposes
  initializeDatabase({ inMemory: true });

  const app = createApp();

  // Make an internal request to get the OpenAPI spec
  const res = await app.request("/api/v1/openapi.json");
  const spec = await res.json();

  // Write to packages/server/openapi.json
  const outPath = resolve(__dirname, "../../openapi.json");
  writeFileSync(outPath, JSON.stringify(spec, null, 2), "utf-8");

  console.log(`OpenAPI spec written to ${outPath}`);

  closeDb();
}

main().catch((err) => {
  console.error("Failed to export OpenAPI spec:", err);
  process.exit(1);
});
