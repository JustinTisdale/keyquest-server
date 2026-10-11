"use strict";
const express = require("express");
const path = require("node:path");
const { openStore } = require("./database");

function createApp({ dbPath = process.env.DATABASE_PATH || path.join(__dirname, "../data/keyquest.sqlite") } = {}) {
  const store = openStore(dbPath);
  const app = express();
  app.disable("x-powered-by");
  app.use((req, res, next) => { res.set("X-Content-Type-Options", "nosniff"); next(); });
  app.use("/api", (req, res, next) => {
    res.set("Cache-Control", "no-store");
    if (!["GET", "HEAD"].includes(req.method)) {
      const origin = req.get("origin");
      let sameOrigin = true;
      try { if (origin) sameOrigin = new URL(origin).host === req.get("host"); } catch { sameOrigin = false; }
      if (!sameOrigin || req.get("sec-fetch-site") === "cross-site") return res.status(403).json({ error: "Cross-origin writes are not allowed" });
      if (!req.is("application/json")) return res.status(415).json({ error: "Use application/json" });
    }
    next();
  });
  app.use("/api", express.json({ limit: "10mb" }));
  app.get("/api/health", (req, res) => { store.db.prepare("SELECT 1").get(); res.json({ status: "ok" }); });
  app.get("/api/profiles", (req, res) => res.json({ profiles: store.profiles() }));
  app.get("/api/profiles/:id", (req, res) => res.json(store.profile(req.params.id)));
  app.post("/api/profiles", (req, res) => res.status(201).json(store.create(req.body)));
  app.post("/api/profiles/:id/operations", (req, res) => res.json(store.update(req.params.id, req.body)));
  app.delete("/api/profiles/:id", (req, res) => res.json(store.remove(req.params.id, req.body?.operationId)));
  app.post("/api/reset", (req, res) => res.json(store.reset(req.body?.operationId)));
  app.get("/api/backup", (req, res) => res.json(store.backup()));
  app.post("/api/restore", (req, res) => res.json(store.restore(req.body)));
  app.use("/api", (req, res) => res.status(404).json({ error: "Unknown endpoint" }));
  const root = path.join(__dirname, "..");
  for (const directory of ["css", "js"]) app.use("/" + directory, express.static(path.join(root, directory), { dotfiles: "deny", index: false, redirect: false, maxAge: 0 }));
  for (const file of ["index.html", "manifest.webmanifest"]) app.get("/" + file, (req, res) => { res.set("Cache-Control", "no-cache"); res.sendFile(path.join(root, file)); });
  app.get("/", (req, res) => { res.set("Cache-Control", "no-cache"); res.sendFile(path.join(root, "index.html")); });
  app.use((req, res) => res.status(404).send("Not found"));
  app.use((error, req, res, next) => {
    const status = error.status || (error.type === "entity.too.large" ? 413 : 500);
    if (status >= 500) console.error("Server request failed:", error.message);
    res.status(status).json({ error: status >= 500 ? "Could not save or read server data. Please retry." : error.message });
  });
  return { app, store };
}
if (require.main === module) {
  const { app, store } = createApp();
  const server = app.listen(Number(process.env.PORT || 8080), "0.0.0.0", () => console.log(`KeyQuest listening on port ${server.address().port}`));
  let closing = false;
  for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => {
    if (closing) return;
    closing = true;
    server.close(() => { store.db.close(); process.exit(0); });
    setTimeout(() => process.exit(1), 10000).unref();
  });
}
module.exports = { createApp };
