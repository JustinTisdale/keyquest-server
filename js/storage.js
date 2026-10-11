// Shared persistence through the server. Only the selected typist ID stays in this browser.
window.KQ = window.KQ || {};
const SELECTION_KEY = "keyquest-server:selected-profile";
KQ.MASTERY_STARS = 2;
KQ.DEFAULT_SETTINGS = { sound: true, stopOnError: true, unlockAll: false, showKeyboard: true, showHands: true, level: "kid" };

KQ.store = {
  data: { profiles: [], currentId: null },
  queue: [],
  pending: new Map(),
  running: null,
  error: null,
  status: "loading",
  revision: 0,
  loadSequence: 0,
  // getRandomValues also works on a household HTTP address, unlike randomUUID.
  newId() { return Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, "0")).join(""); },
  notify(status, error = null) {
    this.status = status;
    this.error = error;
    window.dispatchEvent(new CustomEvent("storage-status", { detail: { status, message: error?.message } }));
  },
  hasPending() { return this.queue.length > 0 || this.pending.size > 0; },
  async request(url, body, method = "POST") {
    let response;
    try {
      response = await fetch(url, { method, headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000), cache: "no-store" });
    } catch { throw new Error("Cannot reach the server. Keep this page open and retry to save your changes."); }
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "The server could not complete the request.");
    return data;
  },
  async load() {
    // Never replace optimistic results with an earlier server snapshot.
    if (this.hasPending()) return this.data;
    const revision = this.revision, sequence = ++this.loadSequence;
    const result = await this.request("/api/profiles", null, "GET");
    if (this.hasPending() || revision !== this.revision || sequence !== this.loadSequence) return this.data;
    this.data.profiles = result.profiles.map(p => {
      const existing = this.data.profiles.find(old => old.id === p.id);
      return existing ? Object.assign(existing, p) : p;
    });
    if (!this.data.currentId) {
      try { this.data.currentId = localStorage.getItem(SELECTION_KEY); } catch { /* selection is optional */ }
    }
    if (!this.current()) this.setCurrent(null);
    this.notify("saved");
    return this.data;
  },
  enqueue(url, body, method = "POST") {
    this.revision++;
    this.queue.push({ url, body: structuredClone(body), method });
    if (!this.error) this.drain();
  },
  drain() {
    if (this.running) return this.running;
    this.running = (async () => {
      this.notify("saving");
      try {
        while (this.queue.length) {
          const job = this.queue[0];
          const result = await this.request(job.url, job.body, job.method);
          this.queue.shift();
          if (result.id && !this.pending.has(result.id) && !this.queue.some(j => j.body.id === result.id || j.url.includes("/" + result.id))) {
            const p = this.data.profiles.find(p => p.id === result.id);
            if (p) Object.assign(p, result);
          }
        }
        this.notify("saved");
      } catch (error) { this.notify("error", error); }
    })().finally(() => { this.running = null; });
    return this.running;
  },
  buffer(profile) {
    this.revision++;
    if (!this.pending.has(profile.id)) this.pending.set(profile.id, { operationId: this.newId() });
    this.save();
    return this.pending.get(profile.id);
  },
  save() {
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => { this.scheduled = false; this.commitPending(); });
  },
  commitPending() {
    for (const [id, operation] of this.pending) this.queue.push({ url: `/api/profiles/${id}/operations`, body: structuredClone(operation), method: "POST" });
    this.pending.clear();
    if (this.queue.length && !this.error) this.drain();
  },
  async flush() {
    this.commitPending();
    if (this.running) await this.running;
    if (this.hasPending() || this.error) throw this.error || new Error("Changes are still waiting to be saved.");
  },
  async retry() {
    this.error = null;
    this.commitPending();
    if (this.queue.length) await this.drain();
    if (!this.error) await this.load();
  },
  async discard() {
    if (this.running) return;
    this.queue = []; this.pending.clear(); this.error = null;
    await this.load();
  },
  profiles() { return this.data.profiles; },
  current() { return this.data.profiles.find(p => p.id === this.data.currentId) || null; },
  setCurrent(id) {
    this.data.currentId = id;
    try { if (id) localStorage.setItem(SELECTION_KEY, id); else localStorage.removeItem(SELECTION_KEY); } catch { /* selection is optional */ }
  },
  createProfile(name, avatar, level) {
    const profile = { id: this.newId(), name: name.trim().slice(0, 20) || "Typist", avatar, created: new Date().toISOString(), settings: { ...KQ.DEFAULT_SETTINGS, level: level || "kid" }, lessons: {}, keyStats: {}, history: [], bests: { rain: 0, race: 0, bubbles: 0 } };
    this.data.profiles.push(profile);
    this.setCurrent(profile.id);
    this.enqueue("/api/profiles", { operationId: this.newId(), id: profile.id, name: profile.name, avatar, level: profile.settings.level });
    return profile;
  },
  async deleteProfile(id) {
    await this.flush();
    this.data.profiles = this.data.profiles.filter(p => p.id !== id);
    if (this.data.currentId === id) this.setCurrent(null);
    this.enqueue(`/api/profiles/${id}`, { operationId: this.newId() }, "DELETE");
    await this.flush();
  },
  settings(profile) { return profile.settings; },
  updateSettings(profile, changes) {
    Object.assign(profile.settings, changes);
    const operation = this.buffer(profile);
    operation.settings = { ...operation.settings, ...changes };
  },
  mergeKeyStats(profile, stats) {
    const operation = this.buffer(profile);
    operation.keyStats ||= {};
    for (const [ch, s] of Object.entries(stats)) {
      const cur = (profile.keyStats[ch] ||= { attempts: 0, errors: 0 });
      cur.attempts += s.attempts; cur.errors += s.errors;
      const delta = (operation.keyStats[ch] ||= { attempts: 0, errors: 0 });
      delta.attempts += s.attempts; delta.errors += s.errors;
    }
  },
  addHistory(profile, entry) {
    profile.history.unshift({ date: new Date().toISOString(), ...entry });
    if (profile.history.length > 200) profile.history.length = 200;
    this.buffer(profile).history = entry;
  },
  recordLesson(profile, lesson, result) {
    const cur = profile.lessons[lesson.id] || { stars: 0, bestWpm: 0, bestAcc: 0, completed: 0 };
    cur.stars = Math.max(cur.stars, result.stars); cur.bestWpm = Math.max(cur.bestWpm, result.wpm); cur.bestAcc = Math.max(cur.bestAcc, result.accuracy); cur.completed++;
    profile.lessons[lesson.id] = cur;
    this.buffer(profile).lesson = { id: lesson.id, stars: result.stars, wpm: result.wpm, accuracy: result.accuracy };
    this.addHistory(profile, { type: "lesson", label: lesson.title, wpm: result.wpm, acc: result.accuracy, errors: result.errors, seconds: result.seconds });
  },
  recordGame(profile, name, label, score) {
    profile.bests[name] = Math.max(profile.bests[name], score);
    this.buffer(profile).bests = { [name]: score };
    this.addHistory(profile, { type: "game", label, wpm: null, acc: null, errors: null, seconds: null, score });
  },
  mastered(profile, lesson) {
    const rec = profile.lessons[lesson.id];
    return !!rec && rec.stars >= (lesson.kind === "intro" ? 1 : KQ.MASTERY_STARS);
  },
  unlockedIndex(profile) {
    if (this.settings(profile).unlockAll) return KQ.LESSONS.length - 1;
    let idx = 0;
    for (const lesson of KQ.LESSONS) {
      if (this.mastered(profile, lesson)) idx = Math.min(lesson.index + 1, KQ.LESSONS.length - 1);
      else break;
    }
    return idx;
  },
  allowedKeys(profile) { return KQ.LESSONS[this.unlockedIndex(profile)].allowed; },
  async exportJson() { await this.flush(); return JSON.stringify(await this.request("/api/backup", null, "GET"), null, 2); },
  async importJson(text) {
    const backup = JSON.parse(text);
    if (backup.format !== "keyquest-server" || backup.version !== 1) throw new Error("Choose a KeyQuest Server backup. Old browser backups are not supported.");
    await this.flush();
    this.enqueue("/api/restore", { operationId: this.newId(), backup });
    await this.flush();
    await this.load();
  },
  async resetAll() {
    await this.flush();
    this.enqueue("/api/reset", { operationId: this.newId() });
    await this.flush();
    this.setCurrent(null);
    await this.load();
  },
};
window.addEventListener("beforeunload", event => {
  if (KQ.store.hasPending()) { event.preventDefault(); event.returnValue = ""; }
});
