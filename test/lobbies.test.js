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

test("filter by rank (ignoring case) and by open slots", async () => {
  for (const id of ["eve", "fay", "gus"]) student(id);
  const gold = (await call("eve", "POST", "/api/lobbies", { ...valorant, slots: 5, rank: "Gold+" })).body.id;
  const plat = (await call("fay", "POST", "/api/lobbies", { ...valorant, slots: 2, rank: "Platinum 1" })).body.id;
  const games = async (q) => (await call("gus", "GET", `/api/lobbies?${q}`)).body.lobbies.map((l) => l.id);
  assert.deepEqual(await games("rank=gold"), [gold]);
  assert.deepEqual(await games("rank=PLAT"), [plat]);
  assert.deepEqual(await games("rank=diamond"), []);
  // eve's lobby has 4 open slots, fay's 1, dan's Balatro lobby 2.
  assert.deepEqual(await games("open=3"), [gold]);
  assert.ok((await games("open=2")).includes(gold));
  assert.ok(!(await games("open=2")).includes(plat));
  assert.equal((await games("open=nonsense")).length, (await games("")).length);
  await call("eve", "POST", `/api/lobbies/${gold}/close`);
  await call("fay", "POST", `/api/lobbies/${plat}/close`);
});

test("schedule a lobby: listed as upcoming, then opens at its time", async () => {
  for (const id of ["hal", "ivy"]) student(id);
  const inAnHour = new Date(Date.now() + 3600_000).toISOString();
  assert.equal((await call("hal", "POST", "/api/lobbies", { ...valorant, startsAt: new Date(Date.now() + 60_000).toISOString() })).status, 400, "too soon");
  assert.equal((await call("hal", "POST", "/api/lobbies", { ...valorant, startsAt: new Date(Date.now() + 8 * 86_400_000).toISOString() })).status, 400, "too far");
  assert.equal((await call("hal", "POST", "/api/lobbies", { ...valorant, startsAt: "soon" })).status, 400);
  const res = await call("hal", "POST", "/api/lobbies", { ...valorant, rank: "Gold", startsAt: inAnHour });
  assert.equal(res.status, 201);
  const scheduledId = res.body.scheduledId;
  assert.ok(scheduledId);
  assert.equal((await call("hal", "POST", "/api/lobbies", { ...valorant, startsAt: inAnHour })).status, 400, "one at a time");

  // Scheduling doesn't put you in a lobby; you can still play now.
  const now = await call("hal", "GET", "/api/lobbies");
  assert.equal(now.body.myLobbyId, null);
  const seen = (await call("ivy", "GET", "/api/lobbies")).body.upcoming.find((u) => u.id === scheduledId);
  assert.equal(seen.host, "user_hal");
  assert.equal(seen.isMine, false);
  assert.equal(seen.rank, "Gold");

  // Someone with a block doesn't see it.
  await call("ivy", "PUT", "/api/blocks/user_hal");
  assert.ok(!(await call("ivy", "GET", "/api/lobbies")).body.upcoming.some((u) => u.id === scheduledId));
  await call("ivy", "DELETE", "/api/blocks/user_hal");

  // Not due yet: nothing happens. At its time it opens with hal as host.
  assert.equal(lobbies.startDue(), 0);
  assert.equal(lobbies.startDue(new Date(Date.now() + 3601_000)), 1);
  const after = await call("hal", "GET", "/api/lobbies");
  assert.ok(after.body.myLobbyId);
  assert.ok(!after.body.upcoming.some((u) => u.id === scheduledId));
  const lobby = (await call("hal", "GET", `/api/lobbies/${after.body.myLobbyId}`)).body.lobby;
  assert.equal(lobby.rank, "Gold");
  assert.equal(lobby.isHost, true);
  await call("hal", "POST", `/api/lobbies/${after.body.myLobbyId}/close`);
});

test("a scheduled lobby waits while its host is busy, then gives up; hosts can cancel", async () => {
  const inAnHour = new Date(Date.now() + 3600_000).toISOString();
  const scheduledId = (await call("hal", "POST", "/api/lobbies", { ...valorant, startsAt: inAnHour })).body.scheduledId;
  const busy = (await call("hal", "POST", "/api/lobbies", valorant)).body.id;
  assert.equal(lobbies.startDue(new Date(Date.now() + 3610_000)), 0, "host busy: wait");
  assert.equal(lobbies.startDue(new Date(Date.now() + 3600_000 + 31 * 60_000)), 1, "dropped after 30 minutes");
  assert.equal((await call("hal", "GET", "/api/lobbies")).body.myLobbyId, busy);
  await call("hal", "POST", `/api/lobbies/${busy}/close`);
  assert.equal((await call("hal", "DELETE", `/api/scheduled/${scheduledId}`)).status, 404);

  const again = (await call("hal", "POST", "/api/lobbies", { ...valorant, startsAt: inAnHour })).body.scheduledId;
  assert.equal((await call("ivy", "DELETE", `/api/scheduled/${again}`)).status, 403);
  assert.equal((await call("hal", "DELETE", `/api/scheduled/${again}`)).status, 200);
  assert.ok(!(await call("ivy", "GET", "/api/lobbies")).body.upcoming.length);
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
