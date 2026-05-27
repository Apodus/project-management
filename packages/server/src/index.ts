import { Hono } from "hono";
import { serve } from "@hono/node-server";

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

export { app };
