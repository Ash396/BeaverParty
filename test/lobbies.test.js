// Lobby and chat API tests.
const test = require("node:test");
const assert = require("node:assert");
const db = require("../server/db");
const accounts = require("../server/accounts");
const profiles = require("../server/profiles");
const lobbies = require("../server/lobbies");
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

function student(id, games = [{ game: "Valorant", inGameName: `${id}#ign` }]) {
  accounts.findOrCreate(id);
  profiles.save(id, { username: `user_${id}`, games });
}

const valorant = { game: "Valorant", slots: 3, vibe: "casual", voice: true, discordInvite: "https://discord.gg/abc123" };

test.before(async () => {
  db.open(":memory:");
  for (const id of ["host", "ann", "bob", "cat", "dan"]) student(id);
  accounts.findOrCreate("noprofile");
  server = createServer(config);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { events.closeAll(); server.close(); });

let lobbyId;

test("a student with a profile can create a lobby and is its first member", async () => {
  const res = await call("host", "POST", "/api/lobbies", valorant);
  assert.equal(res.status, 201);
  lobbyId = res.body.id;
  const { body } = await call("host", "GET", "/api/lobbies");
  assert.equal(body.myLobbyId, lobbyId);
  assert.deepEqual(body.lobbies[0].members, ["user_host"]);
});

test("you need a profile, and can only be in one lobby at a time", async () => {
  assert.equal((await call("noprofile", "POST", "/api/lobbies", valorant)).status, 400);
  const again = await call("host", "POST", "/api/lobbies", valorant);
  assert.equal(again.status, 400);
  assert.match(again.body.error, /current lobby/);
});

test("bad lobbies are rejected", async () => {
  for (const bad of [
    { ...valorant, game: "Not A Game" },
    { ...valorant, game: "Other", otherGame: "" },
    { ...valorant, slots: 1 },
    { ...valorant, slots: 11 },
    { ...valorant, vibe: "chaotic" },
    { ...valorant, discordInvite: "https://evil.example/login" },
  ]) {
    assert.equal((await call("ann", "POST", "/api/lobbies", bad)).status, 400, JSON.stringify(bad));
  }
});

test("outsiders see the summary but not in-game names, chat, or the invite", async () => {
  const { body } = await call("ann", "GET", `/api/lobbies/${lobbyId}`);
  assert.equal(body.lobby.isMember, false);
  assert.equal(body.lobby.roster, undefined);
  assert.equal(body.lobby.messages, undefined);
  assert.ok(!JSON.stringify(body).includes("discord.gg"));
  assert.ok(!JSON.stringify(body).includes("#ign"));
});

test("members see in-game names; the invite appears only once the lobby is full", async () => {
  await call("ann", "POST", `/api/lobbies/${lobbyId}/join`);
  let { body } = await call("ann", "GET", `/api/lobbies/${lobbyId}`);
  assert.deepEqual(body.lobby.roster.map((r) => r.inGameName), ["host#ign", "ann#ign"]);
  assert.equal(body.lobby.discordInvite, null);
  await call("bob", "POST", `/api/lobbies/${lobbyId}/join`);
  ({ body } = await call("ann", "GET", `/api/lobbies/${lobbyId}`));
  assert.equal(body.lobby.state, "full");
  assert.equal(body.lobby.discordInvite, "https://discord.gg/abc123");
  assert.equal((await call("cat", "POST", `/api/lobbies/${lobbyId}/join`)).status, 400);
  const list = await call("cat", "GET", "/api/lobbies");
  assert.ok(!list.body.lobbies.some((l) => l.id === lobbyId), "full lobbies leave the open list");
});

test("leaving a full lobby reopens it", async () => {
  await call("bob", "POST", `/api/lobbies/${lobbyId}/leave`);
  const { body } = await call("ann", "GET", `/api/lobbies/${lobbyId}`);
  assert.equal(body.lobby.state, "open");
  assert.deepEqual(body.lobby.members, ["user_host", "user_ann"]);
});

test("only members can chat, and messages reach members live", async () => {
  assert.equal((await call("cat", "POST", `/api/lobbies/${lobbyId}/messages`, { body: "hi" })).status, 403);
  assert.equal((await call("cat", "GET", `/api/events?lobby=${lobbyId}`)).status, 403);

  const stream = await fetch(`${base}/api/events?lobby=${lobbyId}`, { headers: { Cookie: cookieFor("host") } });
  const reader = stream.body.getReader();
  const sent = await call("ann", "POST", `/api/lobbies/${lobbyId}/messages`, { body: "  gg wp  " });
  assert.equal(sent.status, 201);
  assert.equal(sent.body.message.body, "gg wp");
  let received = "";
  while (!received.includes("event: message")) received += new TextDecoder().decode((await reader.read()).value);
  assert.match(received, /gg wp/);
  assert.match(received, /user_ann/);
  await reader.cancel();

  const { body } = await call("host", "GET", `/api/lobbies/${lobbyId}`);
  assert.deepEqual(body.lobby.messages.map((m) => m.body), ["gg wp"]);
  assert.equal((await call("ann", "POST", `/api/lobbies/${lobbyId}/messages`, { body: "x".repeat(501) })).status, 400);
});

test("only the host can close; closed lobbies refuse chat", async () => {
  assert.equal((await call("ann", "POST", `/api/lobbies/${lobbyId}/close`)).status, 403);
  assert.equal((await call("host", "POST", `/api/lobbies/${lobbyId}/close`)).status, 200);
  assert.equal((await call("ann", "POST", `/api/lobbies/${lobbyId}/messages`, { body: "hi" })).status, 400);
  const { body } = await call("ann", "GET", "/api/lobbies");
  assert.equal(body.myLobbyId, null, "a closed lobby frees you to join another");
});

test("Other games and filters work", async () => {
  await call("dan", "POST", "/api/lobbies", { ...valorant, game: "Other", otherGame: "Balatro", voice: false, discordInvite: "" });
  assert.deepEqual((await call("ann", "GET", "/api/lobbies?game=Balatro")).body.lobbies.map((l) => l.game), ["Balatro"]);
  assert.equal((await call("ann", "GET", "/api/lobbies?voice=on")).body.lobbies.length, 0);
});

test("old chat from closed lobbies is deleted", () => {
  db.get().prepare("UPDATE lobbies SET closed_at = datetime('now', '-8 days') WHERE id = ?").run(lobbyId);
  assert.equal(lobbies.deleteOldChats(7), 1);
  assert.equal(db.get().prepare("SELECT COUNT(*) AS n FROM messages").get().n, 0);
});

test("lobby actions need a JSON request", async () => {
  const res = await fetch(`${base}/api/lobbies/${lobbyId}/join`, {
    method: "POST",
    headers: { Cookie: cookieFor("cat"), "Content-Type": "application/x-www-form-urlencoded" },
  });
  assert.equal(res.status, 400);
});

test("leaving while connected doesn't crash later broadcasts", async () => {
  const id = (await call("bob", "POST", "/api/lobbies", { ...valorant, discordInvite: "" })).body.id;
  await call("cat", "POST", `/api/lobbies/${id}/join`);
  const stream = await fetch(`${base}/api/events?lobby=${id}`, { headers: { Cookie: cookieFor("cat") } });
  await call("cat", "POST", `/api/lobbies/${id}/leave`);
  // These publish to the "lobbies" channel the kicked stream was also on.
  await call("bob", "POST", `/api/lobbies/${id}/messages`, { body: "still here" });
  await call("bob", "POST", `/api/lobbies/${id}/close`);
  assert.equal((await call("bob", "GET", "/api/lobbies")).status, 200);
  await stream.body.cancel().catch(() => {});
});
