"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { createApp } = require("../server");
const { openStore } = require("../server/database");
const newProfile = () => ({ operationId: randomUUID(), id: randomUUID(), name: "Ada", avatar: "🦊", level: "kid" });
const result = () => ({ operationId: randomUUID(), keyStats: { a: { attempts: 10, errors: 2 } }, lesson: { id: 1, stars: 2, wpm: 30, accuracy: 95 }, history: { type: "lesson", label: "Lesson 1", wpm: 30, acc: 95 }, bests: { race: 30 } });

async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keyquest-test-"));
  const dbPath = path.join(dir, "keyquest.sqlite");
  const { app, store } = createApp({ dbPath });
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const request = async (endpoint, body, method = "POST", headers = {}) => {
    const response = await fetch(url + endpoint, { method, headers: { "Content-Type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  };
  t.after(async () => { await new Promise(resolve => server.close(resolve)); store.db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { store, dbPath, url, request };
}

test("API combines concurrent results and deduplicates retried writes", async t => {
  const { request } = await fixture(t);
  const p = newProfile();
  assert.equal((await request("/api/profiles", p)).status, 201);
  assert.equal((await request("/api/profiles", p)).status, 201);
  const a = result(), b = result(); b.lesson.stars = 3; b.lesson.wpm = 40;
  const endpoint = `/api/profiles/${p.id}/operations`;
  await Promise.all([request(endpoint, a), request(endpoint, b), request(endpoint, a)]);
  const saved = (await request(`/api/profiles/${p.id}`, undefined, "GET")).data;
  assert.deepEqual(saved.keyStats.a, { attempts: 20, errors: 4 });
  assert.deepEqual(saved.lessons[1], { stars: 3, bestWpm: 40, bestAcc: 95, completed: 2 });
  assert.equal(saved.history.length, 2);
  assert.equal((await request(endpoint, { ...a, bests: { race: 99 } })).status, 409);
  await Promise.all([
    request(endpoint, { operationId: randomUUID(), settings: { sound: false } }),
    request(endpoint, { operationId: randomUUID(), settings: { level: "big" } }),
  ]);
  const settings = (await request(`/api/profiles/${p.id}`, undefined, "GET")).data.settings;
  assert.equal(settings.sound, false); assert.equal(settings.level, "big");
});

test("validation, cross-origin protection, and static file boundaries", async t => {
  const { request, url } = await fixture(t);
  const p = newProfile(); await request("/api/profiles", p);
  const endpoint = `/api/profiles/${p.id}/operations`;
  const invalid = result(); invalid.keyStats.a.errors = 100;
  assert.equal((await request(endpoint, invalid)).status, 400);
  assert.equal((await request(endpoint, result(), "POST", { Origin: "https://untrusted.example" })).status, 403);
  assert.equal((await request("/api/profiles", { ...newProfile(), avatar: '<img onerror="alert(1)">' })).status, 400);
  assert.equal((await request(endpoint, JSON.parse('{"operationId":"test","settings":{"__proto__":{}}}'))).status, 400);
  const saved = (await request(`/api/profiles/${p.id}`, undefined, "GET")).data;
  assert.deepEqual(saved.lessons, {}); assert.deepEqual(saved.keyStats, {});
  for (const asset of ["/", "/index.html", "/css/style.css", "/js/app.js", "/manifest.webmanifest"]) assert.equal((await fetch(url + asset)).status, 200);
  for (const hidden of ["/data/keyquest.sqlite", "/server/database.js", "/package.json", "/.git/config", "/tests/e2e.js"]) assert.equal((await fetch(url + hidden)).status, 404);
});

test("history is bounded, backups restore transactionally, and data survives reopening SQLite", async t => {
  const { store, request, dbPath } = await fixture(t);
  const p = newProfile(); store.create(p);
  for (let i = 0; i < 205; i++) store.update(p.id, result());
  assert.equal(store.profile(p.id).history.length, 200);
  const backup = (await request("/api/backup", undefined, "GET")).data;
  assert.equal(backup.format, "keyquest-server");
  const invalid = structuredClone(backup); invalid.profiles[0].lessons[1].completed = -1;
  assert.equal((await request("/api/restore", { operationId: randomUUID(), backup: invalid })).status, 400);
  assert.equal(store.profile(p.id).lessons[1].completed, 205);
  assert.equal((await request("/api/restore", { operationId: randomUUID(), backup: { profiles: [] } })).status, 400);
  const resetId = randomUUID(); await request("/api/reset", { operationId: resetId });
  assert.equal(store.profiles().length, 0);
  const restoreBody = { operationId: randomUUID(), backup };
  assert.equal((await request("/api/restore", restoreBody)).status, 200);
  const newer = result(); store.update(p.id, newer);
  await request("/api/restore", restoreBody); // lost response retry must not roll back newer progress
  await request("/api/reset", { operationId: resetId });
  assert.equal(store.profile(p.id).lessons[1].completed, 206);
  const reopened = openStore(dbPath);
  assert.equal(reopened.profile(p.id).lessons[1].completed, 206);
  reopened.db.close();
  await request(`/api/profiles/${p.id}`, { operationId: randomUUID() }, "DELETE");
  assert.equal((await request(`/api/profiles/${p.id}/operations`, result())).status, 404);
  for (const table of ["lesson_progress", "key_stats", "history", "game_bests"]) assert.equal(store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0);
});
