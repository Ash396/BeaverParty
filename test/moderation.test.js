// Blocking, reporting, and moderation.
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

const lobbyOf = (id) => db.get().prepare(
  "SELECT l.id FROM lobbies l JOIN lobby_members m ON m.lobby_id = l.id WHERE m.anon_id = ? AND l.state <> 'closed'"
).get(id);

async function newLobby(host, slots = 4) {
  return (await call(host, "POST", "/api/lobbies", { game: "Minecraft", slots })).body.id;
}

async function closeAll() {
  for (const id of ["ann", "bob", "cat", "dan", "mod", "mod2"]) {
    const l = lobbyOf(id);
    if (l) await call(id, "POST", `/api/lobbies/${l.id}/leave`);
  }
}

test.before(async () => {
  db.open(":memory:");
  for (const id of ["ann", "bob", "cat", "dan", "mod", "mod2"]) {
    accounts.findOrCreate(id);
    profiles.save(id, { username: `user_${id}`, realName: `Real ${id}`, dorm: "Burton Conner", games: [{ game: "Minecraft", rank: "Gold" }] });
  }
  accounts.setModerator("mod", true);
  accounts.setModerator("mod2", true);
  server = createServer(config);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { events.closeAll(); server.close(); });
test.afterEach(closeAll);

// ---- Blocking ----

test("block and unblock from a username; you can't block yourself", async () => {
  assert.equal((await call("ann", "PUT", "/api/blocks/user_bob")).status, 200);
  assert.deepEqual((await call("ann", "GET", "/api/blocks")).body.blocked, ["user_bob"]);
  assert.equal((await call("ann", "GET", "/api/profiles/user_bob")).body.profile.blockedByMe, true);
  assert.equal((await call("ann", "PUT", "/api/blocks/user_ann")).status, 400);
  assert.equal((await call("ann", "PUT", "/api/blocks/nobody")).status, 400);
  await call("ann", "DELETE", "/api/blocks/user_bob");
  assert.deepEqual((await call("ann", "GET", "/api/blocks")).body.blocked, []);
});

test("a block hides lobbies and stops joining, in both directions", async () => {
  await call("ann", "PUT", "/api/blocks/user_bob");
  const annLobby = await newLobby("ann");
  const seen = async (who) => (await call(who, "GET", "/api/lobbies")).body.lobbies.map((l) => l.id);
  assert.ok(!(await seen("bob")).includes(annLobby));
  assert.ok((await seen("cat")).includes(annLobby));
  const res = await call("bob", "POST", `/api/lobbies/${annLobby}/join`);
  assert.equal(res.status, 400);
  assert.equal(res.body.error, "You can't join this lobby.");
  await call("ann", "POST", `/api/lobbies/${annLobby}/leave`);
  // The other way round: ann can't see or join a lobby bob is in.
  const bobLobby = await newLobby("bob");
  assert.ok(!(await seen("ann")).includes(bobLobby));
  assert.equal((await call("ann", "POST", `/api/lobbies/${bobLobby}/join`)).status, 400);
  await call("ann", "DELETE", "/api/blocks/user_bob");
});

test("blocking someone already in your lobby hides their chat from you only", async () => {
  const id = await newLobby("ann");
  await call("bob", "POST", `/api/lobbies/${id}/join`);
  await call("cat", "POST", `/api/lobbies/${id}/join`);
  await call("bob", "POST", `/api/lobbies/${id}/messages`, { body: "hi from bob" });
  await call("ann", "PUT", "/api/blocks/user_bob");
  const forAnn = (await call("ann", "GET", `/api/lobbies/${id}`)).body.lobby;
  assert.deepEqual(forAnn.messages.map((m) => m.body), []);
  assert.equal(forAnn.roster.find((r) => r.username === "user_bob").blocked, true);
  const forCat = (await call("cat", "GET", `/api/lobbies/${id}`)).body.lobby;
  assert.deepEqual(forCat.messages.map((m) => m.body), ["hi from bob"]);
  await call("ann", "DELETE", "/api/blocks/user_bob");
});

test("no endorsing across a block", async () => {
  const id = await newLobby("ann", 2);
  await call("bob", "POST", `/api/lobbies/${id}/join`);
  await call("ann", "POST", `/api/lobbies/${id}/close`);
  await call("bob", "PUT", "/api/blocks/user_ann");
  const res = await call("ann", "PUT", `/api/lobbies/${id}/endorsements`, { username: "user_bob", badges: ["Good comms"] });
  assert.equal(res.status, 400);
  const pending = (await call("ann", "GET", "/api/endorsements")).body.lobbies.find((l) => l.id === id);
  assert.equal(pending, undefined);
  await call("bob", "DELETE", "/api/blocks/user_ann");
});

// ---- Reports ----

let reportedLobby;

test("reports from a lobby need both students to have been in it", async () => {
  reportedLobby = await newLobby("ann");
  await call("bob", "POST", `/api/lobbies/${reportedLobby}/join`);
  await call("ann", "POST", `/api/lobbies/${reportedLobby}/messages`, { body: "stop that" });
  await call("bob", "POST", `/api/lobbies/${reportedLobby}/messages`, { body: "something nasty" });
  const report = (who, body) => call(who, "POST", "/api/reports", body);
  assert.equal((await report("cat", { username: "user_bob", lobbyId: reportedLobby, reason: "Harassment or hate" })).status, 403);
  assert.equal((await report("ann", { username: "user_cat", lobbyId: reportedLobby, reason: "Harassment or hate" })).status, 400);
  assert.equal((await report("ann", { username: "user_bob", lobbyId: reportedLobby, reason: "Being bad" })).status, 400);
  assert.equal((await report("ann", { username: "user_ann", reason: "Other" })).status, 400);
  const ok = await report("ann", { username: "user_bob", lobbyId: reportedLobby, reason: "Harassment or hate", details: "see chat" });
  assert.equal(ok.status, 201);
  const again = await report("ann", { username: "user_bob", lobbyId: reportedLobby, reason: "Other" });
  assert.equal(again.status, 400);
  assert.match(again.body.error, /already reported/);
});

test("the report keeps its own copy even if the user renames and chat is deleted", async () => {
  profiles.save("bob", { username: "user_bob2", games: [{ game: "Minecraft" }] });
  await call("ann", "POST", `/api/lobbies/${reportedLobby}/close`);
  db.get().prepare("DELETE FROM messages WHERE lobby_id = ?").run(reportedLobby);
  const r = (await call("mod", "GET", "/api/moderation")).body.reports[0];
  assert.equal(r.username, "user_bob2");
  assert.equal(r.usernameWhenReported, "user_bob");
  assert.deepEqual(r.messages.map((m) => [m.who, m.body]), [["Player 1", "stop that"], ["user_bob", "something nasty"]]);
});

test("moderators see usernames and chat, but never real names, dorms, IDs, or the reporter", async () => {
  const res = await call("mod", "GET", "/api/moderation");
  assert.equal(res.status, 200);
  const text = JSON.stringify(res.body);
  for (const secret of ["Real ", "Burton Conner", "\"ann\"", "\"bob\"", "user_ann"]) {
    assert.ok(!text.includes(secret), `moderation view leaked ${secret}`);
  }
  assert.equal(res.body.reports[0].flags.reporterReportsLast30Days, 1);
});

test("students who aren't moderators can't see the queue or act", async () => {
  assert.equal((await call("cat", "GET", "/api/moderation")).status, 403);
  const id = (await call("mod", "GET", "/api/moderation")).body.reports[0].id;
  assert.equal((await call("cat", "POST", `/api/moderation/reports/${id}`, { action: "ban" })).status, 403);
});

test("a moderator doesn't see reports about themselves", async () => {
  const id = await newLobby("cat");
  await call("mod", "POST", `/api/lobbies/${id}/join`);
  await call("cat", "POST", "/api/reports", { username: "user_mod", lobbyId: id, reason: "Spam or scams" });
  const mine = (await call("mod", "GET", "/api/moderation")).body.reports;
  assert.ok(mine.every((r) => r.username !== "user_mod"));
  const other = (await call("mod2", "GET", "/api/moderation")).body.reports;
  const r = other.find((x) => x.username === "user_mod");
  assert.ok(r);
  assert.equal((await call("mod", "POST", `/api/moderation/reports/${r.id}`, { action: "dismiss" })).status, 403);
  assert.equal((await call("mod2", "POST", `/api/moderation/reports/${r.id}`, { action: "dismiss" })).status, 200);
});

test("dismissing deletes the copy and counts against the reporter", async () => {
  await call("cat", "POST", "/api/reports", { username: "user_dan", reason: "Offensive username or profile" });
  const r = (await call("mod", "GET", "/api/moderation")).body.reports.find((x) => x.username === "user_dan");
  await call("mod", "POST", `/api/moderation/reports/${r.id}`, { action: "dismiss" });
  const row = db.get().prepare("SELECT * FROM reports WHERE id = ?").get(r.id);
  assert.equal(row.snapshot, null);
  assert.equal(row.action, "dismissed");
  await call("cat", "POST", "/api/reports", { username: "user_dan", reason: "Other" });
  const next = (await call("mod", "GET", "/api/moderation")).body.reports.find((x) => x.username === "user_dan");
  assert.equal(next.flags.reporterDismissed, 2); // the mod report above was dismissed too
  await call("mod", "POST", `/api/moderation/reports/${next.id}`, { action: "dismiss" });
  const { history } = (await call("mod", "GET", "/api/moderation")).body;
  assert.equal(history[0].action, "dismissed");
  assert.equal(history[0].moderator, "user_mod");
});

test("a warning shows once on the student's next visit", async () => {
  await call("ann", "POST", "/api/reports", { username: "user_dan", reason: "Spam or scams" });
  const r = (await call("mod", "GET", "/api/moderation")).body.reports.find((x) => x.username === "user_dan");
  await call("mod", "POST", `/api/moderation/reports/${r.id}`, { action: "warn" });
  const me = await fetch(`${base}/api/me`, { headers: { Cookie: cookieFor("dan") } }).then((x) => x.json());
  assert.equal(me.warning.reason, "Spam or scams");
  await call("dan", "POST", "/api/warnings/seen");
  const after = await fetch(`${base}/api/me`, { headers: { Cookie: cookieFor("dan") } }).then((x) => x.json());
  assert.equal(after.warning, null);
});

test("a ban signs them out, hides their profile, resolves their reports, and can be lifted", async () => {
  const id = await newLobby("bob");
  await call("cat", "POST", `/api/lobbies/${id}/join`);
  await call("cat", "POST", "/api/reports", { username: "user_bob2", lobbyId: id, reason: "Threats or sharing personal info" });
  const reports = (await call("mod", "GET", "/api/moderation")).body.reports.filter((x) => x.username === "user_bob2");
  assert.equal(reports.length, 2);
  assert.equal(reports[0].flags.openReportsAboutThem, 2);
  assert.equal((await call("mod", "POST", `/api/moderation/reports/${reports[0].id}`, { action: "ban" })).status, 200);

  assert.equal(accounts.find("bob").banned, true);
  assert.equal((await call("bob", "GET", "/api/profile")).status, 401);
  assert.equal((await call("cat", "GET", "/api/profiles/user_bob2")).status, 404);
  assert.equal(lobbyOf("bob"), undefined); // their lobby was closed
  const after = await call("mod", "GET", "/api/moderation");
  assert.ok(after.body.reports.every((x) => x.username !== "user_bob2"));
  assert.deepEqual(after.body.banned, ["user_bob2"]);

  await call("mod", "POST", "/api/moderation/unban", { username: "user_bob2" });
  assert.equal(accounts.find("bob").banned, false);
  assert.equal((await call("bob", "GET", "/api/profile")).status, 200);
});

test("moderators are labeled on profiles and in lobbies", async () => {
  assert.equal((await call("ann", "GET", "/api/profiles/user_mod")).body.profile.isModerator, true);
  assert.equal((await call("ann", "GET", "/api/profiles/user_cat")).body.profile.isModerator, false);
});

test("deleting your account removes your blocks and warnings", async () => {
  await call("dan", "PUT", "/api/blocks/user_ann");
  await call("ann", "PUT", "/api/blocks/user_dan");
  await call("dan", "POST", "/api/account/delete", { confirm: "user_dan" });
  const left = db.get().prepare("SELECT COUNT(*) AS n FROM blocks WHERE blocker_anon_id = 'dan' OR blocked_anon_id = 'dan'").get();
  assert.equal(left.n, 0);
  assert.equal(db.get().prepare("SELECT COUNT(*) AS n FROM warnings WHERE anon_id = 'dan'").get().n, 0);
  assert.deepEqual((await call("ann", "GET", "/api/blocks")).body.blocked, []);
});
