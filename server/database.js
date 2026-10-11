"use strict";
const Database = require("better-sqlite3");
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");

const DEFAULT_SETTINGS = { sound: true, stopOnError: true, unlockAll: false, showKeyboard: true, showHands: true, level: "kid" };
const AVATARS = ["🦊", "🐼", "🦁", "🐸", "🐙", "🦄", "🐯", "🐧", "🦖", "🐨", "🐝", "🐳"];
function fail(message, status = 400) { throw Object.assign(new Error(message), { status }); }
function object(value) { if (!value || typeof value !== "object" || Array.isArray(value)) fail("Expected an object"); return value; }
function fields(value, allowed) { object(value); if (Object.keys(value).some(k => !allowed.includes(k))) fail("Unknown field"); return value; }
function string(value, max = 200) { if (typeof value !== "string" || !value.length || value.length > max) fail("Invalid text"); return value; }
function number(value, max = 1e9, integer = false) { if (!Number.isFinite(value) || value < 0 || value > max || (integer && !Number.isSafeInteger(value))) fail("Invalid number"); return value; }
function id(value) { string(value, 64); if (!/^[a-zA-Z0-9-]+$/.test(value)) fail("Invalid ID"); return value; }
function settings(value) {
  fields(value, Object.keys(DEFAULT_SETTINGS));
  for (const [key, val] of Object.entries(value)) {
    if (key === "level" ? !["little", "kid", "big"].includes(val) : typeof val !== "boolean") fail("Invalid setting");
  }
  return value;
}
function keyStats(value) {
  object(value);
  if (Object.keys(value).length > 200) fail("Too many keys");
  for (const [ch, stats] of Object.entries(value)) {
    if ([...ch].length !== 1) fail("Invalid key");
    fields(stats, ["attempts", "errors"]);
    number(stats.attempts, 1e12, true); number(stats.errors, stats.attempts, true);
  }
  return value;
}
function history(value) {
  fields(value, ["date", "type", "label", "wpm", "acc", "errors", "seconds", "score"]);
  if (!["lesson", "practice", "test", "game"].includes(value.type)) fail("Invalid activity type");
  string(value.label);
  if (value.date !== undefined && (typeof value.date !== "string" || !Number.isFinite(Date.parse(value.date)))) fail("Invalid date");
  for (const key of ["wpm", "acc", "errors", "seconds", "score"]) {
    if (value[key] !== undefined && value[key] !== null) number(value[key], key === "acc" ? 100 : 1e9);
  }
  return value;
}
function operation(value) {
  fields(value, ["operationId", "settings", "keyStats", "lesson", "history", "bests"]);
  id(value.operationId);
  if (value.settings) settings(value.settings);
  if (value.keyStats) keyStats(value.keyStats);
  if (value.lesson) {
    fields(value.lesson, ["id", "stars", "wpm", "accuracy"]);
    number(value.lesson.id, 23, true); number(value.lesson.stars, 3, true);
    number(value.lesson.wpm); number(value.lesson.accuracy, 100);
  }
  if (value.history) history(value.history);
  if (value.bests) {
    fields(value.bests, ["rain", "race", "bubbles"]);
    for (const score of Object.values(value.bests)) number(score);
  }
  return value;
}
function validateProfile(p) {
  fields(p, ["id", "name", "avatar", "created", "settings", "lessons", "keyStats", "history", "bests"]);
  id(p.id); string(p.name, 20);
  if (!AVATARS.includes(p.avatar)) fail("Invalid avatar");
  if (typeof p.created !== "string" || !Number.isFinite(Date.parse(p.created))) fail("Invalid creation date");
  settings(p.settings); keyStats(p.keyStats); object(p.lessons);
  for (const [lessonId, lesson] of Object.entries(p.lessons)) {
    if (!/^(\d|1\d|2[0-3])$/.test(lessonId)) fail("Invalid lesson ID");
    fields(lesson, ["stars", "bestWpm", "bestAcc", "completed"]);
    number(lesson.stars, 3, true); number(lesson.bestWpm); number(lesson.bestAcc, 100); number(lesson.completed, 1e9, true);
  }
  if (!Array.isArray(p.history) || p.history.length > 200) fail("Invalid history");
  p.history.forEach(history);
  fields(p.bests, ["rain", "race", "bubbles"]);
  for (const name of ["rain", "race", "bubbles"]) number(p.bests[name]);
  return p;
}

function openStore(filename) {
  if (filename !== ":memory:") fs.mkdirSync(path.dirname(path.resolve(filename)), { recursive: true });
  const db = new Database(filename);
  db.pragma("foreign_keys = ON");
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  const version = db.pragma("user_version", { simple: true });
  if (version > 1) { db.close(); fail("Database version is newer than this server", 500); }
  if (version === 0) db.transaction(() => {
    db.exec(`
      CREATE TABLE profiles (id TEXT PRIMARY KEY, name TEXT NOT NULL, avatar TEXT NOT NULL, created TEXT NOT NULL, settings TEXT NOT NULL);
      CREATE TABLE lesson_progress (profile_id TEXT REFERENCES profiles(id) ON DELETE CASCADE, lesson_id INTEGER, stars INTEGER NOT NULL, best_wpm REAL NOT NULL, best_acc REAL NOT NULL, completed INTEGER NOT NULL, PRIMARY KEY(profile_id, lesson_id));
      CREATE TABLE key_stats (profile_id TEXT REFERENCES profiles(id) ON DELETE CASCADE, character TEXT, attempts INTEGER NOT NULL, errors INTEGER NOT NULL, PRIMARY KEY(profile_id, character));
      CREATE TABLE history (id INTEGER PRIMARY KEY, profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE, entry TEXT NOT NULL);
      CREATE INDEX history_profile ON history(profile_id, id DESC);
      CREATE TABLE game_bests (profile_id TEXT REFERENCES profiles(id) ON DELETE CASCADE, game TEXT, score REAL NOT NULL, PRIMARY KEY(profile_id, game));
      CREATE TABLE processed_operations (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL);
      PRAGMA user_version = 1;
    `);
  })();
  const query = sql => db.prepare(sql);
  function profile(profileId) {
    const row = query("SELECT * FROM profiles WHERE id = ?").get(profileId);
    if (!row) fail("Typist no longer exists. Refresh the profile list.", 404);
    const p = { id: row.id, name: row.name, avatar: row.avatar, created: row.created, settings: JSON.parse(row.settings), lessons: {}, keyStats: {}, history: [], bests: { rain: 0, race: 0, bubbles: 0 } };
    for (const r of query("SELECT * FROM lesson_progress WHERE profile_id = ?").all(profileId)) p.lessons[r.lesson_id] = { stars: r.stars, bestWpm: r.best_wpm, bestAcc: r.best_acc, completed: r.completed };
    for (const r of query("SELECT * FROM key_stats WHERE profile_id = ?").all(profileId)) p.keyStats[r.character] = { attempts: r.attempts, errors: r.errors };
    p.history = query("SELECT entry FROM history WHERE profile_id = ? ORDER BY id DESC LIMIT 200").all(profileId).map(r => JSON.parse(r.entry));
    for (const r of query("SELECT * FROM game_bests WHERE profile_id = ?").all(profileId)) p.bests[r.game] = r.score;
    return p;
  }
  const profiles = () => query("SELECT id FROM profiles ORDER BY created, id").all().map(r => profile(r.id));
  // Keep operation receipts across reset/restore: a delayed retry must never replay an old write.
  function once(operationId, payload, action) {
    id(operationId);
    const fingerprint = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
    return db.transaction(() => {
      const receipt = query("SELECT fingerprint FROM processed_operations WHERE id = ?").get(operationId);
      if (receipt) {
        if (receipt.fingerprint !== fingerprint) fail("Operation ID was reused with different data", 409);
        return { duplicate: true };
      }
      action();
      query("INSERT INTO processed_operations VALUES (?, ?)").run(operationId, fingerprint);
      return { duplicate: false };
    })();
  }
  function insertProfile(p) {
    query("INSERT INTO profiles VALUES (?, ?, ?, ?, ?)").run(p.id, p.name, p.avatar, p.created, JSON.stringify({ ...DEFAULT_SETTINGS, ...p.settings }));
    for (const [lessonId, r] of Object.entries(p.lessons)) query("INSERT INTO lesson_progress VALUES (?, ?, ?, ?, ?, ?)").run(p.id, Number(lessonId), r.stars, r.bestWpm, r.bestAcc, r.completed);
    for (const [ch, r] of Object.entries(p.keyStats)) query("INSERT INTO key_stats VALUES (?, ?, ?, ?)").run(p.id, ch, r.attempts, r.errors);
    for (const entry of [...p.history].reverse()) query("INSERT INTO history(profile_id, entry) VALUES (?, ?)").run(p.id, JSON.stringify(entry));
    for (const [game, score] of Object.entries(p.bests)) query("INSERT INTO game_bests VALUES (?, ?, ?)").run(p.id, game, score);
  }
  return {
    db, profile, profiles,
    create(body) {
      fields(body, ["operationId", "id", "name", "avatar", "level"]); id(body.id); string(body.name, 20);
      if (!body.name.trim() || !AVATARS.includes(body.avatar) || !["little", "kid", "big"].includes(body.level)) fail("Invalid typist");
      once(body.operationId, ["create", body], () => {
        if (query("SELECT id FROM profiles WHERE id = ?").get(body.id)) fail("Typist ID already exists", 409);
        insertProfile({ id: body.id, name: body.name.trim(), avatar: body.avatar, created: new Date().toISOString(), settings: { ...DEFAULT_SETTINGS, level: body.level }, lessons: {}, keyStats: {}, history: [], bests: { rain: 0, race: 0, bubbles: 0 } });
      });
      return profile(body.id);
    },
    update(profileId, body) {
      id(profileId); operation(body);
      once(body.operationId, ["update", profileId, body], () => {
        const p = profile(profileId);
        if (body.settings) query("UPDATE profiles SET settings = ? WHERE id = ?").run(JSON.stringify({ ...p.settings, ...body.settings }), profileId);
        for (const [ch, s] of Object.entries(body.keyStats || {})) query("INSERT INTO key_stats VALUES (?, ?, ?, ?) ON CONFLICT(profile_id, character) DO UPDATE SET attempts = attempts + excluded.attempts, errors = errors + excluded.errors").run(profileId, ch, s.attempts, s.errors);
        if (body.lesson) {
          const r = body.lesson;
          query("INSERT INTO lesson_progress VALUES (?, ?, ?, ?, ?, 1) ON CONFLICT(profile_id, lesson_id) DO UPDATE SET stars = MAX(stars, excluded.stars), best_wpm = MAX(best_wpm, excluded.best_wpm), best_acc = MAX(best_acc, excluded.best_acc), completed = completed + 1").run(profileId, r.id, r.stars, r.wpm, r.accuracy);
        }
        if (body.history) {
          query("INSERT INTO history(profile_id, entry) VALUES (?, ?)").run(profileId, JSON.stringify({ ...body.history, date: new Date().toISOString() }));
          query("DELETE FROM history WHERE profile_id = ? AND id NOT IN (SELECT id FROM history WHERE profile_id = ? ORDER BY id DESC LIMIT 200)").run(profileId, profileId);
        }
        for (const [game, score] of Object.entries(body.bests || {})) query("INSERT INTO game_bests VALUES (?, ?, ?) ON CONFLICT(profile_id, game) DO UPDATE SET score = MAX(score, excluded.score)").run(profileId, game, score);
      });
      return profile(profileId);
    },
    remove(profileId, operationId) { return once(operationId, ["delete", profileId], () => query("DELETE FROM profiles WHERE id = ?").run(profileId)); },
    reset(operationId) { return once(operationId, ["reset"], () => query("DELETE FROM profiles").run()); },
    backup() { return { format: "keyquest-server", version: 1, exportedAt: new Date().toISOString(), profiles: profiles() }; },
    restore(body) {
      fields(body, ["operationId", "backup"]);
      const backup = fields(body.backup, ["format", "version", "exportedAt", "profiles"]);
      if (backup.format !== "keyquest-server" || backup.version !== 1 || !Array.isArray(backup.profiles) || backup.profiles.length > 1000) fail("Expected a KeyQuest Server backup (version 1). Browser backups are not supported.");
      backup.profiles.forEach(validateProfile);
      if (new Set(backup.profiles.map(p => p.id)).size !== backup.profiles.length) fail("Duplicate typist IDs");
      return once(body.operationId, ["restore", backup], () => {
        query("DELETE FROM profiles").run();
        backup.profiles.forEach(insertProfile);
      });
    },
  };
}
module.exports = { openStore };
