import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { initializeDatabase, closeDb } from "./db/index.js";

// Initialize the database before starting the server
initializeDatabase();

const app = new Hono();

app.get("/health", (c) => {
  return c.json({ status: "ok", timestamp: new Date().toISOString() });
});

const port = parseInt(process.env.PM_PORT || "3000", 10);
const host = process.env.PM_HOST || "127.0.0.1";

console.log(`Server starting on http://${host}:${port}`);

serve({
  fetch: app.fetch,
  port,
  hostname: host,
});

// Graceful shutdown
function shutdown() {
  console.log("Shutting down...");
  closeDb();
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

export { app };
