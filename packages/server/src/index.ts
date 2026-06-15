import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { initializeDatabase, closeDb } from "./db/index.js";
import { createApp } from "./app.js";

// ── Configuration ─────────────────────────────────────────────────
const port = parseInt(process.env.PM_PORT || "3000", 10);
const host = process.env.PM_HOST || "127.0.0.1";
const isProduction = process.env.NODE_ENV === "production";

// ── Initialize database ───────────────────────────────────────────
initializeDatabase({
  dbPath: process.env.PM_DB_PATH,
});

// ── Create and start the app ──────────────────────────────────────
const app = createApp();

// ── Production: serve static web UI ───────────────────────────────
if (isProduction) {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  // Resolve web dist relative to server package: dist/ -> ../ -> ../../web/dist
  const defaultWebDist = path.resolve(__dirname, "../../web/dist");
  const webDistPath = process.env.PM_WEB_DIST_PATH || defaultWebDist;

  if (!existsSync(webDistPath)) {
    console.warn(
      `WARNING: Web dist directory not found at ${webDistPath}. ` +
        `Run "pnpm build" first or set PM_WEB_DIST_PATH.`,
    );
  } else {
    console.log(`Serving static files from ${webDistPath}`);

    const indexHtmlPath = path.join(webDistPath, "index.html");

    // Static file serving — serves JS, CSS, images, etc.
    app.use(
      "*",
      serveStatic({
        root: webDistPath,
        rewriteRequestPath: (reqPath) => reqPath,
        onFound: (_filePath, c) => {
          // Cache immutable hashed assets aggressively
          if (_filePath.includes("/assets/")) {
            c.header("Cache-Control", "public, immutable, max-age=31536000");
          }
        },
      }),
    );

    // SPA fallback — any GET not matching /api/*, /health, or a static file
    // returns index.html so client-side routing works.
    if (existsSync(indexHtmlPath)) {
      app.get("*", (c) => {
        // Do NOT fall back to index.html for asset-like requests (anything with
        // a file extension). serveStatic already missed them, so they are
        // genuinely absent — return a clean 404 instead of HTML. Serving
        // text/html for a `.js`/`.css` request triggers the browser's strict
        // module MIME check and blanks the whole SPA.
        if (/\.[a-zA-Z0-9]+$/.test(c.req.path)) {
          return c.notFound();
        }
        // Read index.html FRESH per request (never cached at startup). A dist
        // rebuilt while the server is running otherwise leaves the fallback
        // serving stale HTML that points at deleted hashed assets — which is
        // exactly the blank-page-on-deep-route-refresh bug (root worked because
        // serveStatic served the fresh on-disk index.html for "/").
        const indexHtml = readFileSync(indexHtmlPath, "utf-8");
        // Never let a browser cache the HTML shell, or it will keep requesting
        // stale asset hashes after a deploy.
        c.header("Cache-Control", "no-cache");
        return c.html(indexHtml);
      });
    }
  }
}

console.log(`Server starting on http://${host}:${port}`);
console.log(`  Mode:     ${isProduction ? "production" : "development"}`);
console.log(`  Health:   http://${host}:${port}/health`);
console.log(`  API docs: http://${host}:${port}/api/v1/docs`);
console.log(`  OpenAPI:  http://${host}:${port}/api/v1/openapi.json`);
if (isProduction) {
  console.log(`  Web UI:   http://${host}:${port}/`);
}

const server = serve({
  fetch: app.fetch,
  port,
  hostname: host,
});

server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    console.error("");
    console.error(`  ERROR: Port ${port} is already in use.`);
    console.error("");
    console.error("  To fix this, either:");
    console.error(`    1. Stop the other process using port ${port}`);
    console.error(`    2. Use a different port:  set PM_PORT=3001  (then re-run)`);
    console.error(`       Or on Linux/Mac:       PM_PORT=3001 ./run.sh`);
    console.error(`       Or with run.bat:       .\\run.bat 3001`);
    console.error("");
  } else {
    console.error("Server error:", err.message);
  }
  closeDb();
  process.exit(1);
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
