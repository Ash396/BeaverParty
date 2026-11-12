// Avatars and deleting an account.
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
  return { status: res.status, body: await res.json(), headers: res.headers };
}

function student(id) {
  accounts.findOrCreate(id);
  profiles.save(id, { username: `user_${id}`, games: [{ game: "Minecraft" }] });
}

test.before(async () => {
  db.open(":memory:");
  for (const id of ["ann", "bob", "cat"]) student(id);
  server = createServer(config);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { events.closeAll(); server.close(); });

test("new profiles get the classic beaver; avatars come from the fixed lists", async () => {
  assert.deepEqual((await call("ann", "GET", "/api/profile")).body.profile.avatar, { color: "brown", item: "none" });
  const save = (avatar) => call("ann", "PUT", "/api/profile", { username: "user_ann", games: [{ game: "Minecraft" }], avatar });
  assert.equal((await save({ color: "mint", item: "headset" })).status, 200);
  assert.deepEqual((await call("bob", "GET", "/api/profiles/user_ann")).body.profile.avatar, { color: "mint", item: "headset" });
  assert.equal((await save({ color: "rainbow", item: "none" })).status, 400);
  assert.equal((await save({ color: "mint", item: "https://example.com/pic.png" })).status, 400);
});

test("lobby cards and rosters carry avatars", async () => {
  const { body } = await call("ann", "POST", "/api/lobbies", { game: "Minecraft", slots: 3 });
  await call("bob", "POST", `/api/lobbies/${body.id}/join`);
  const list = (await call("cat", "GET", "/api/lobbies")).body.lobbies[0];
  assert.deepEqual(list.avatars, [{ color: "mint", item: "headset" }, { color: "brown", item: "none" }]);
  const detail = (await call("bob", "GET", `/api/lobbies/${body.id}`)).body.lobby;
  assert.deepEqual(detail.roster.map((r) => r.avatar.color), ["mint", "brown"]);
});

test("deleting needs your username typed in", async () => {
  const res = await call("bob", "POST", "/api/account/delete", { confirm: "user_ann" });
  assert.equal(res.status, 400);
  assert.ok(profiles.getOwn("bob"));
});

test("deleting removes everything, closes your lobby, and signs you out", async () => {
  const lobbyId = (await call("ann", "GET", "/api/lobbies")).body.myLobbyId;
  await call("ann", "POST", `/api/lobbies/${lobbyId}/messages`, { body: "hi" });
  await call("bob", "POST", `/api/lobbies/${lobbyId}/messages`, { body: "hey" });

  const res = await call("ann", "POST", "/api/account/delete", { confirm: "USER_ANN" });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("set-cookie"), /bp_session=;.*Max-Age=0/);

  const conn = db.get();
  for (const table of ["accounts", "profiles", "profile_games", "lobby_members", "messages"]) {
    assert.equal(conn.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE anon_id = 'ann'`).get().n, 0, table);
  }
  assert.equal(conn.prepare("SELECT COUNT(*) AS n FROM lobbies WHERE host_anon_id = 'ann'").get().n, 0);
  // The old cookie no longer works, and the username is free again.
  assert.equal((await call("ann", "GET", "/api/profile")).status, 401);
  assert.equal((await call("bob", "GET", "/api/profiles/user_ann")).status, 404);
  // Bob is fine and out of the lobby that went away.
  assert.equal((await call("bob", "GET", "/api/lobbies")).body.myLobbyId, null);
});

test("with an open report, only the bare account row stays (so a ban still works)", async () => {
  db.get().prepare("INSERT INTO reports (reporter_anon_id, reported_anon_id, reason) VALUES ('bob', 'cat', 'spam')").run();
  const res = await call("cat", "POST", "/api/account/delete", { confirm: "user_cat" });
  assert.equal(res.status, 200);
  assert.ok(accounts.find("cat"), "row kept");
  assert.equal(profiles.getOwn("cat"), null);
  accounts.setBanned("cat", true);
  assert.equal(accounts.find("cat").banned, true);
});
