// Endorsement tests: who can endorse whom, when, and what profiles show.
const test = require("node:test");
const assert = require("node:assert");
const db = require("../server/db");
const accounts = require("../server/accounts");
const profiles = require("../server/profiles");
const events = require("../server/events");
const { loadConfig } = require("../server/config");
const { createServer } = require("../server/index");
const { sign } = require("../server/session");

let base, server;
const config = loadConfig({
  PETROCK_CLIENT_ID: "c", PETROCK_CLIENT_SECRET: "s", ANON_ID_KEY: "k", SESSION_SECRET: "secret",
});
const cookieFor = (id) => `bp_session=${sign("secret", { anonId: id, exp: Date.now() + 60_000 })}`;

async function call(anonId, method, path, body) {
  const headers = { Cookie: cookieFor(anonId) };
  if (method !== "GET") headers["Content-Type"] = "application/json";
  const res = await fetch(base + path, { method, headers, body: method === "GET" ? undefined : JSON.stringify(body || {}) });
  return { status: res.status, body: await res.json() };
}

const endorse = (from, lobby, to, badges) =>
  call(from, "PUT", `/api/lobbies/${lobby}/endorsements`, { username: `user_${to}`, badges });

async function playedLobby(host, others) {
  const { body } = await call(host, "POST", "/api/lobbies", { game: "Minecraft", slots: others.length + 1 });
  for (const o of others) await call(o, "POST", `/api/lobbies/${body.id}/join`);
  return body.id;
}

test.before(async () => {
  db.open(":memory:");
  for (const id of ["host", "ann", "bob", "out"]) {
    accounts.findOrCreate(id);
    profiles.save(id, { username: `user_${id}`, games: [{ game: "Minecraft" }] });
  }
  server = createServer(config);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { events.closeAll(); server.close(); });

let lobbyId;

test("you can't endorse until the lobby closes", async () => {
  lobbyId = await playedLobby("host", ["ann", "bob"]);
  const res = await endorse("ann", lobbyId, "bob", ["Good comms"]);
  assert.equal(res.status, 400);
  assert.match(res.body.error, /closes/);
  assert.deepEqual((await call("ann", "GET", "/api/endorsements")).body.lobbies, []);
});

test("after it closes, members see each other and can give badges", async () => {
  await call("host", "POST", `/api/lobbies/${lobbyId}/close`);
  const { body } = await call("ann", "GET", "/api/endorsements");
  assert.deepEqual(body.badges, ["Good teammate", "Good comms", "Chill vibes"]);
  assert.equal(body.lobbies.length, 1);
  assert.deepEqual(body.lobbies[0].players.map((p) => p.username), ["user_host", "user_bob"]);

  assert.equal((await endorse("ann", lobbyId, "bob", ["Good comms", "Chill vibes"])).status, 200);
  const again = (await call("ann", "GET", "/api/endorsements")).body.lobbies[0].players[1];
  assert.deepEqual(again.given.sort(), ["Chill vibes", "Good comms"]);
});

test("badges can be changed or taken back", async () => {
  await endorse("ann", lobbyId, "bob", ["Good comms"]);
  const bob = (await call("ann", "GET", "/api/endorsements")).body.lobbies[0].players[1];
  assert.deepEqual(bob.given, ["Good comms"]);
});

test("no self-endorsing, no outsiders, no made-up badges", async () => {
  assert.equal((await endorse("ann", lobbyId, "ann", ["Good comms"])).status, 400);
  assert.equal((await endorse("out", lobbyId, "bob", ["Good comms"])).status, 403);
  assert.equal((await endorse("ann", lobbyId, "out", ["Good comms"])).status, 400);
  assert.equal((await endorse("ann", lobbyId, "bob", ["Best player"])).status, 400);
  assert.equal((await endorse("ann", 9999, "bob", ["Good comms"])).status, 404);
});

test("profiles count different students, not repeat games with the same friend", async () => {
  await endorse("host", lobbyId, "bob", ["Good comms", "Good teammate"]);
  const second = await playedLobby("ann", ["bob"]);
  await call("ann", "POST", `/api/lobbies/${second}/close`);
  await endorse("ann", second, "bob", ["Good comms"]);

  const { body } = await call("out", "GET", "/api/profiles/user_bob");
  assert.deepEqual(body.profile.badges, [
    { badge: "Good teammate", count: 1 },
    { badge: "Good comms", count: 2 },
    { badge: "Chill vibes", count: 0 },
  ]);
  assert.ok(!JSON.stringify(body).includes("user_ann"), "givers are never shown");
});

test("endorsing ends 7 days after the lobby closed", async () => {
  db.get().prepare("UPDATE lobbies SET closed_at = datetime('now', '-8 days') WHERE id = ?").run(lobbyId);
  assert.equal((await endorse("ann", lobbyId, "host", ["Chill vibes"])).status, 400);
  const ids = (await call("ann", "GET", "/api/endorsements")).body.lobbies.map((l) => l.id);
  assert.ok(!ids.includes(lobbyId));
});
