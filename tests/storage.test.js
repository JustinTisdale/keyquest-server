"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { chromium } = require("playwright");
const { createApp } = require("../server");

test("browser storage uses shared server data, preserves selection, and safely retries", { timeout: 60000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keyquest-browser-"));
  const { app, store } = createApp({ dbPath: path.join(dir, "progress.sqlite") });
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  let browser;
  t.after(async () => {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
    store.db.close(); fs.rmSync(dir, { recursive: true, force: true });
  });
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || undefined, args: ["--no-sandbox"] });
  const first = await browser.newContext(), second = await browser.newContext();
  const page = await first.newPage(), other = await second.newPage();
  const errors = [];
  for (const p of [page, other]) p.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => localStorage.setItem("keyquest:v1", JSON.stringify({ profiles: [{ id: "legacy", name: "Old user" }], currentId: "legacy" })));
  await page.goto(url); await page.waitForSelector("#screen-profiles.active");
  assert.equal(await page.locator(".profile-card").count(), 0);
  await page.fill("#new-name", "Ada"); await page.click("#btn-create");
  await page.waitForSelector("#screen-home.active"); await page.evaluate(() => KQ.store.flush());
  const ada = store.profiles()[0].id;
  await other.goto(url); await other.waitForSelector("#screen-profiles.active");
  assert.equal(await other.locator(".profile-card").count(), 1);
  await other.fill("#new-name", "Bo"); await other.click("#btn-create");
  await other.waitForSelector("#screen-home.active"); await other.evaluate(() => KQ.store.flush());
  assert.equal(await page.evaluate(() => KQ.store.current().name), "Ada");
  await page.reload(); await page.waitForSelector("#screen-home.active");
  assert.equal(await page.locator("#chip-name").textContent(), "Ada");
  assert.equal(await other.locator("#chip-name").textContent(), "Bo");

  const addResult = async p => p.evaluate(() => {
    const profile = KQ.store.current();
    KQ.store.mergeKeyStats(profile, { a: { attempts: 4, errors: 1 } });
    KQ.store.recordLesson(profile, KQ.LESSONS[1], { stars: 2, wpm: 30, accuracy: 95, errors: 1, seconds: 10 });
  });
  await addResult(page); await page.evaluate(() => KQ.store.flush());
  assert.equal(store.profile(ada).lessons[1].completed, 1);
  assert.equal(store.profile(ada).keyStats.a.attempts, 4);
  // Select Ada on the second device and submit two independent results concurrently.
  await other.click("#btn-profile"); await other.getByRole("button", { name: /Ada/ }).click();
  await Promise.all([addResult(page), addResult(other)]);
  await Promise.all([page.evaluate(() => KQ.store.flush()), other.evaluate(() => KQ.store.flush())]);
  assert.equal(store.profile(ada).lessons[1].completed, 3);
  assert.equal(store.profile(ada).keyStats.a.attempts, 12);

  // Simulate a response lost AFTER the transaction committed.
  await page.route("**/api/profiles/*/operations", async route => { await route.fetch(); await route.abort(); });
  await addResult(page);
  await page.waitForSelector('#storage-status[data-status="error"]');
  assert.equal(store.profile(ada).lessons[1].completed, 4);
  assert.equal(await page.evaluate(() => KQ.store.hasPending()), true);
  await page.unroute("**/api/profiles/*/operations");
  await page.click("#btn-retry-save");
  await page.waitForSelector('#storage-status[data-status="saved"]');
  assert.equal(store.profile(ada).lessons[1].completed, 4);
  assert.equal(store.profile(ada).keyStats.a.attempts, 16);
  assert.equal(await page.evaluate(() => KQ.store.hasPending()), false);

  // Unavailable server: the result stays in memory and can be retried.
  await page.route("**/api/profiles/*/operations", route => route.abort());
  await addResult(page); await page.waitForSelector('#storage-status[data-status="error"]');
  assert.equal(store.profile(ada).lessons[1].completed, 4);
  await page.unroute("**/api/profiles/*/operations");
  await page.click("#btn-retry-save"); await page.waitForSelector('#storage-status[data-status="saved"]');
  assert.equal(store.profile(ada).lessons[1].completed, 5);

  // JSON export reads the committed server state; restore accepts only the new format.
  const backup = await page.evaluate(() => KQ.store.exportJson());
  assert.equal(JSON.parse(backup).profiles.find(p => p.id === ada).lessons[1].completed, 5);
  const legacyError = await page.evaluate(async () => { try { await KQ.store.importJson('{"profiles":[]}'); } catch (e) { return e.message; } });
  assert.match(legacyError, /Old browser backups/);
  await page.evaluate(() => KQ.store.resetAll());
  assert.equal(store.profiles().length, 0);
  await page.evaluate(text => KQ.store.importJson(text), backup);
  assert.equal(store.profile(ada).lessons[1].completed, 5);
  await page.reload(); await page.waitForSelector("#screen-profiles.active");
  assert.equal(await page.locator(".profile-card").count(), 2);
  assert.deepEqual(errors, []);

  // Initial API failure leaves a recoverable loading screen, not an empty writable store.
  const offline = await first.newPage();
  await offline.route("**/api/profiles", route => route.abort());
  await offline.goto(url); await offline.waitForSelector('#storage-status[data-status="error"]');
  assert.equal(await offline.locator("#app").evaluate(el => el.inert), true);
  await offline.unroute("**/api/profiles");
  await offline.click("#btn-retry-save"); await offline.waitForSelector("#screen-profiles.active");
  assert.equal(await offline.locator("#app").evaluate(el => el.inert), false);
});
