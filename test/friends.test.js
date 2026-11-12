// Friends: mutual requests, username search, and online status in the list.
const test = require("node:test");
const assert = require("node:assert");
const db = require("../server/db");
const accounts = require("../server/accounts");
const profiles = require("../server/profiles");
const presence = require("../server/presence");
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
const names = (list) => list.map((p) => p.username);

test.before(async () => {
  db.open(":memory:");
  for (const [id, name] of [["ann", "ann_b"], ["bob", "bobcat"], ["cat", "catnip"], ["dan", "bob_ross"], ["eve", "bobXbob"]]) {
    accounts.findOrCreate(id);
    profiles.save(id, { username: name, games: [{ game: "Minecraft" }] });
  }
  accounts.findOrCreate("noprofile");
  server = createServer(config);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { events.closeAll(); presence.reset(); server.close(); });

test("a friend request needs the other student to accept", async () => {
  assert.equal((await call("ann", "POST", "/api/friends", { username: "bobcat" })).body.relation, "sent");
  let mine = (await call("ann", "GET", "/api/friends")).body;
  assert.deepEqual(names(mine.outgoing), ["bobcat"]);
  assert.deepEqual(mine.friends, []);
  const theirs = (await call("bob", "GET", "/api/friends")).body;
  assert.deepEqual(names(theirs.incoming), ["ann_b"]);
  assert.equal((await call("bob", "GET", "/api/me")).body.friendRequests, 1);
  // Only the person asked can accept.
  assert.equal((await call("ann", "POST", "/api/friends/accept", { username: "bobcat" })).status, 400);
  assert.equal((await call("bob", "POST", "/api/friends/accept", { username: "ann_b" })).body.relation, "friend");
  mine = (await call("ann", "GET", "/api/friends")).body;
  assert.deepEqual(names(mine.friends), ["bobcat"]);
  assert.deepEqual(mine.outgoing, []);
  assert.equal((await call("bob", "GET", "/api/me")).body.friendRequests, 0);
});

test("asking someone who already asked you makes you friends", async () => {
  await call("cat", "POST", "/api/friends", { username: "ann_b" });
  assert.equal((await call("ann", "POST", "/api/friends", { username: "catnip" })).body.relation, "friend");
});

test("profiles show how you're related; declining, cancelling and removing delete it", async () => {
  assert.equal((await call("ann", "GET", "/api/profiles/catnip")).body.profile.friend, "friend");
  assert.equal((await call("ann", "GET", "/api/profiles/bob_ross")).body.profile.friend, "none");
  await call("ann", "POST", "/api/friends/remove", { username: "catnip" });
  assert.equal((await call("cat", "GET", "/api/profiles/ann_b")).body.profile.friend, "none");
  await call("dan", "POST", "/api/friends", { username: "ann_b" });
  assert.equal((await call("ann", "GET", "/api/profiles/bob_ross")).body.profile.friend, "received");
  await call("ann", "POST", "/api/friends/remove", { username: "bob_ross" }); // decline
  assert.deepEqual((await call("dan", "GET", "/api/friends")).body.outgoing, []);
});

test("bad requests are refused", async () => {
  assert.equal((await call("ann", "POST", "/api/friends", { username: "ann_b" })).status, 400);
  assert.equal((await call("ann", "POST", "/api/friends", { username: "nobody" })).status, 400);
  assert.equal((await call("ann", "POST", "/api/friends", { username: 5 })).status, 400);
  assert.equal((await call("noprofile", "POST", "/api/friends", { username: "ann_b" })).status, 400);
});

test("search finds usernames by their start only, with 3+ characters", async () => {
  const search = async (q) => names((await call("ann", "GET", `/api/friends/search?q=${encodeURIComponent(q)}`)).body.results);
  assert.deepEqual(await search("bo"), [], "too short");
  assert.deepEqual(await search("bob"), ["bobcat", "bobXbob", "bob_ross"]);
  assert.deepEqual(await search("BOB_"), ["bob_ross"], "_ is matched literally, case doesn't matter");
  assert.deepEqual(await search("cat"), ["catnip"], "not bobcat: only the start matches");
  assert.deepEqual(await search("ann"), [], "never yourself");
  assert.deepEqual(await search("%%%"), []);
  const { results } = (await call("ann", "GET", "/api/friends/search?q=bobc")).body;
  assert.equal(results[0].relation, "friend");
});

test("friends show online, unless they're invisible", async () => {
  presence.connected("bob");
  let list = (await call("ann", "GET", "/api/friends")).body.friends;
  assert.equal(list[0].online, true);
  presence.setInvisible("bob", true);
  list = (await call("ann", "GET", "/api/friends")).body.friends;
  assert.equal(list[0].online, false);
});

test("blocking ends a friendship and keeps you apart, without telling them", async () => {
  await call("cat", "POST", "/api/friends", { username: "ann_b" });
  await call("ann", "POST", "/api/friends/accept", { username: "catnip" });
  assert.equal((await call("cat", "PUT", "/api/blocks/ann_b")).status, 200);
  assert.deepEqual((await call("ann", "GET", "/api/friends")).body.friends.map((p) => p.username), ["bobcat"]);
  // ann can't find cat, and her request looks normal but goes nowhere.
  assert.deepEqual((await call("ann", "GET", "/api/friends/search?q=catn")).body.results, []);
  assert.equal((await call("ann", "POST", "/api/friends", { username: "catnip" })).body.relation, "sent");
  assert.deepEqual((await call("cat", "GET", "/api/friends")).body.incoming, []);
  // cat has to unblock first.
  assert.equal((await call("cat", "POST", "/api/friends", { username: "ann_b" })).status, 400);
  await call("cat", "DELETE", "/api/blocks/ann_b");
  assert.equal((await call("cat", "POST", "/api/friends", { username: "ann_b" })).body.relation, "sent");
});

test("deleting your account removes your friendships", async () => {
  await call("eve", "POST", "/api/friends", { username: "ann_b" });
  await call("eve", "POST", "/api/account/delete", { confirm: "bobXbob" });
  assert.deepEqual(names((await call("ann", "GET", "/api/friends")).body.incoming), ["catnip"]);
  assert.equal(db.get().prepare("SELECT COUNT(*) AS n FROM friends WHERE from_anon_id = 'eve' OR to_anon_id = 'eve'").get().n, 0);
});
