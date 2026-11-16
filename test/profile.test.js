// Profile API tests. Signs session cookies directly instead of going
// through Petrock.
const test = require("node:test");
const assert = require("node:assert");
const db = require("../server/db");
const accounts = require("../server/accounts");
const profiles = require("../server/profiles");
const { loadConfig } = require("../server/config");
const { createServer } = require("../server/index");
const { sign } = require("../server/session");

let base, server;
const config = loadConfig({
  PETROCK_CLIENT_ID: "c", PETROCK_CLIENT_SECRET: "s", ANON_ID_KEY: "k", SESSION_SECRET: "secret",
});

function cookieFor(anonId) {
  return `bp_session=${sign("secret", { anonId, exp: Date.now() + 60_000 })}`;
}

async function call(anonId, method, path, body) {
  const headers = anonId ? { Cookie: cookieFor(anonId) } : {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}

const tim = {
  username: "TimBeaver",
  realName: "Tim Beaver",
  dorm: "Simmons",
  majors: ["6-3", "18"],
  games: [
    { game: "Valorant", rank: "Gold 2", inGameName: "tim#mit" },
    { game: "Minecraft" },
  ],
};

test.before(async () => {
  db.open(":memory:");
  accounts.findOrCreate("tim");
  accounts.findOrCreate("ann");
  server = createServer(config);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

test("signed-out requests are refused", async () => {
  assert.equal((await call(null, "GET", "/api/profile")).status, 401);
});

test("a new account has no profile until it saves one", async () => {
  assert.deepEqual((await call("tim", "GET", "/api/profile")).body, { profile: null });
  // Real name, dorm, majors, and a rank that nobody else shares: warned first.
  const warned = await call("tim", "PUT", "/api/profile", tim);
  assert.equal(warned.status, 409);
  assert.deepEqual(warned.body.warning, { k: 5, realName: true, fields: ["dorm", "majors", "rank"] });
  assert.deepEqual((await call("tim", "GET", "/api/profile")).body, { profile: null }, "nothing saved yet");
  const saved = await call("tim", "PUT", "/api/profile", { ...tim, acknowledgeRisk: true });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.profile.username, "TimBeaver");
  assert.equal(saved.body.profile.games.length, 2);
  const me = await (await fetch(`${base}/api/me`, { headers: { Cookie: cookieFor("tim") } })).json();
  assert.equal(me.username, "TimBeaver");
});

test("other students see the public view without in-game names", async () => {
  const { status, body } = await call("ann", "GET", "/api/profiles/timbeaver");
  assert.equal(status, 200);
  assert.equal(body.profile.realName, "Tim Beaver");
  assert.deepEqual(body.profile.majors, ["6-3", "18"]);
  assert.deepEqual(body.profile.games.find((g) => g.game === "Valorant"), { game: "Valorant", rank: "Gold 2" });
  assert.ok(!JSON.stringify(body).includes("tim#mit"));
  assert.ok(!JSON.stringify(body).includes('"tim"'));
});

test("clearing an opt-in field removes it", async () => {
  await call("tim", "PUT", "/api/profile", { ...tim, realName: "", dorm: null, majors: [] });
  const { body } = await call("ann", "GET", "/api/profiles/TimBeaver");
  assert.equal(body.profile.realName, null);
  assert.equal(body.profile.dorm, null);
  assert.deepEqual(body.profile.majors, []);
});

test("majors keep the order the student picked", async () => {
  await call("tim", "PUT", "/api/profile", { ...tim, majors: ["21M", "6"], acknowledgeRisk: true });
  const { body } = await call("ann", "GET", "/api/profiles/TimBeaver");
  assert.deepEqual(body.profile.majors, ["21M", "6"]);
  await call("tim", "PUT", "/api/profile", { ...tim, acknowledgeRisk: true });
});

test("the re-identification warning counts other students who share the same fields", async () => {
  const base = { games: [{ game: "Minecraft" }], dorm: "Baker" };
  // Saving again without changing dorm, majors, or ranks doesn't warn again.
  assert.equal((await call("tim", "PUT", "/api/profile", { ...tim, avatar: { color: "mint", item: "none" } })).status, 200);
  // Baker alone: nobody else yet, so warn; once 5 others show Baker, no warning.
  accounts.findOrCreate("bk0");
  assert.equal((await call("bk0", "PUT", "/api/profile", { ...base, username: "baker0" })).status, 409);
  for (let i = 1; i <= 5; i++) {
    accounts.findOrCreate(`bk${i}`);
    profiles.save(`bk${i}`, { ...base, username: `baker${i}` });
  }
  assert.equal((await call("bk0", "PUT", "/api/profile", { ...base, username: "baker0" })).status, 200);
  // Adding a major nobody else in Baker has narrows it back down.
  const narrower = await call("bk0", "PUT", "/api/profile", { ...base, username: "baker0", majors: ["22"] });
  assert.equal(narrower.status, 409);
  assert.deepEqual(narrower.body.warning.fields, ["dorm", "major"]);
  // No opt-in fields at all: never warned.
  accounts.findOrCreate("plain");
  assert.equal((await call("plain", "PUT", "/api/profile", { username: "plainjane", games: [{ game: "Tetris" }] })).status, 200);
  // The warning never says how many share it.
  assert.ok(!("shared" in narrower.body.warning));
});

test("usernames are unique regardless of case", async () => {
  const res = await call("ann", "PUT", "/api/profile", { ...tim, username: "timbeaver" });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /taken/);
});

test("bad input is rejected", async () => {
  for (const bad of [
    { ...tim, username: "x" },
    { ...tim, username: "has space" },
    { ...tim, games: [] },
    { ...tim, games: [{ game: "Some Rare Game" }] },
    { ...tim, games: [{ game: "Minecraft" }, { game: "Minecraft" }] },
    { ...tim, dorm: "Hogwarts" },
    { ...tim, majors: ["Course 6-3"] },
    { ...tim, majors: "6-3" },
    { ...tim, majors: ["6-3", "18", "8"] },
    { ...tim, majors: ["6", "6-3"] },
    { ...tim, majors: ["6-3", "6-4"] },
    { ...tim, majors: ["6-3", "6-3"] },
    { ...tim, majors: ["Undeclared", "8"] },
    { ...tim, realName: "x".repeat(61) },
  ]) {
    assert.equal((await call("ann", "PUT", "/api/profile", bad)).status, 400, JSON.stringify(bad));
  }
});

test("non-JSON bodies are rejected", async () => {
  const res = await fetch(`${base}/api/profile`, {
    method: "PUT",
    headers: { Cookie: cookieFor("ann"), "Content-Type": "text/plain" },
    body: JSON.stringify(tim),
  });
  assert.equal(res.status, 400);
});

test("a banned student can't use the API", async () => {
  accounts.findOrCreate("bad");
  accounts.setBanned("bad", true);
  assert.equal((await call("bad", "GET", "/api/profile")).status, 401);
});
