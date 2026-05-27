import { serve } from "@hono/node-server";
import { initializeDatabase, closeDb } from "./db/index.js";
import { createApp } from "./app.js";

// ── Configuration ─────────────────────────────────────────────────
const port = parseInt(process.env.PM_PORT || "3000", 10);
const host = process.env.PM_HOST || "127.0.0.1";

// ── Initialize database ───────────────────────────────────────────
initializeDatabase({
  dbPath: process.env.PM_DB_PATH,
});

// ── Create and start the app ──────────────────────────────────────
const app = createApp();

console.log(`Server starting on http://${host}:${port}`);
console.log(`  Health:   http://${host}:${port}/health`);
console.log(`  API docs: http://${host}:${port}/api/v1/docs`);
console.log(`  OpenAPI:  http://${host}:${port}/api/v1/openapi.json`);

serve({
  fetch: app.fetch,
  port,
  hostname: host,
});

// ── Graceful shutdown ─────────────────────────────────────────────
function shutdown() {
  console.log("Shutting down...");
  closeDb();
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

export { app };
