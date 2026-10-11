"use strict";
// Uses an isolated Compose project and removes only the test project's volume.
const { execFileSync } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const project = "keyquest-test-" + randomUUID().slice(0, 8);
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), project));
const override = path.join(temporary, "compose.test.yml");
// !override prevents merging the normal published port into this isolated test.
fs.writeFileSync(override, 'services:\n  keyquest:\n    ports: !override\n      - "127.0.0.1::8080"\n');
const args = ["compose", "-p", project, "-f", "docker-compose.yml", "-f", override];
function compose(...command) { return execFileSync("docker", [...args, ...command], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim(); }
const newId = () => randomUUID();
async function run() {
  try {
    compose("config", "--quiet");
    console.log(compose("up", "--build", "--wait", "--wait-timeout", "120"));
    const port = compose("port", "keyquest", "8080").split(":").pop();
    let url = `http://127.0.0.1:${port}`;
    const request = async (endpoint, body) => {
      const response = await fetch(url + endpoint, { method: body ? "POST" : "GET", headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
      assert.ok(response.ok, `${endpoint}: ${response.status}`);
      return response.json();
    };
    assert.equal((await fetch(url)).status, 200);
    const id = newId();
    await request("/api/profiles", { operationId: newId(), id, name: "Persistence test", avatar: "🦊", level: "kid" });
    await request(`/api/profiles/${id}/operations`, { operationId: newId(), keyStats: { a: { attempts: 5, errors: 1 } }, lesson: { id: 1, stars: 2, wpm: 30, accuracy: 95 } });
    assert.notEqual(compose("exec", "-T", "keyquest", "id", "-u"), "0");
    // Remove and recreate the container, keeping its named volume.
    compose("down");
    compose("up", "-d", "--wait", "--wait-timeout", "120");
    url = `http://127.0.0.1:${compose("port", "keyquest", "8080").split(":").pop()}`;
    const saved = await request(`/api/profiles/${id}`);
    assert.equal(saved.lessons[1].completed, 1);
    assert.deepEqual(saved.keyStats.a, { attempts: 5, errors: 1 });
    console.log("Container health, non-root user, HTTP serving, and volume persistence passed.");
  } finally {
    try { compose("down", "--volumes", "--remove-orphans"); }
    finally { fs.rmSync(temporary, { recursive: true, force: true }); }
  }
}
run().catch(error => { console.error(error.message); process.exitCode = 1; });
