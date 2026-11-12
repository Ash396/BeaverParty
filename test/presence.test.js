// Online / invisible status tests.
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
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(anonId, method, path, body) {
  const headers = { Cookie: cookieFor(anonId) };
  if (method !== "GET") headers["Content-Type"] = "application/json";
  const res = await fetch(base + path, { method, headers, body: method === "GET" ? undefined : JSON.stringify(body || {}) });
  return { status: res.status, body: await res.json() };
}

// Opens the live-updates stream (what an open app tab does) and collects
// "presence" events from it.
async function openTab(anonId) {
  const controller = new AbortController();
  const res = await fetch(`${base}/api/events`, { headers: { Cookie: cookieFor(anonId) }, signal: controller.signal });
  const seen = [];
  (async () => {
    const decoder = new TextDecoder();
    let buf = "";
    try {
      for await (const chunk of res.body) {
        buf += decoder.decode(chunk, { stream: true });
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const event = /^event: (.*)$/m.exec(block);
          const data = /^data: (.*)$/m.exec(block);
          if (event && event[1] === "presence") seen.push(JSON.parse(data[1]));
        }
      }
    } catch {}
  })();
  await wait(30);
  return { seen, close: () => controller.abort() };
}

const online = async (viewer, username) => (await call(viewer, "GET", `/api/profiles/${username}`)).body.profile.online;

test.before(async () => {
  presence.options.graceMs = 50;
  db.open(":memory:");
  for (const id of ["ann", "bob", "cat"]) {
    accounts.findOrCreate(id);
    profiles.save(id, { username: `user_${id}`, games: [{ game: "Valorant" }] });
  }
  server = createServer(config);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { events.closeAll(); presence.reset(); server.close(); });

test("you show as online while the app is open, and offline a moment after closing it", async () => {
  assert.equal(await online("bob", "user_ann"), false);
  const watcher = await openTab("bob");
  const tab = await openTab("ann");
  assert.equal(await online("bob", "user_ann"), true);
  assert.deepEqual(watcher.seen.at(-1), { username: "user_ann", online: true });

  tab.close();
  await wait(10);
  assert.equal(await online("bob", "user_ann"), true, "a quick reconnect shouldn't flicker");
  await wait(100);
  assert.equal(await online("bob", "user_ann"), false);
  assert.deepEqual(watcher.seen.at(-1), { username: "user_ann", online: false });
  watcher.close();
});

test("two tabs: closing one keeps you online", async () => {
  const a = await openTab("cat");
  const b = await openTab("cat");
  a.close();
  await wait(100);
  assert.equal(await online("ann", "user_cat"), true);
  b.close();
  await wait(100);
  assert.equal(await online("ann", "user_cat"), false);
});

test("invisible students look offline to everyone, and toggling announces it", async () => {
  const watcher = await openTab("bob");
  const tab = await openTab("ann");
  const res = await call("ann", "PUT", "/api/status", { invisible: true });
  assert.equal(res.status, 200);
  assert.equal(await online("bob", "user_ann"), false);
  assert.deepEqual(watcher.seen.at(-1), { username: "user_ann", online: false });
  assert.equal((await call("ann", "GET", "/api/me")).body.invisible, true);

  // The setting is saved, so it survives closing and reopening the app.
  tab.close();
  await wait(100);
  const count = watcher.seen.length;
  const again = await openTab("ann");
  assert.equal(await online("bob", "user_ann"), false);
  assert.equal(watcher.seen.length, count, "an invisible student coming back isn't announced");

  await call("ann", "PUT", "/api/status", { invisible: false });
  assert.equal(await online("bob", "user_ann"), true);
  assert.deepEqual(watcher.seen.at(-1), { username: "user_ann", online: true });
  again.close();
  watcher.close();
  await wait(100);
});

test("lobby cards and rosters say who's online", async () => {
  const tab = await openTab("bob");
  const { body } = await call("bob", "POST", "/api/lobbies", { game: "Valorant", slots: 3, vibe: "casual" });
  await call("cat", "POST", `/api/lobbies/${body.id}/join`);
  const list = (await call("ann", "GET", "/api/lobbies")).body.lobbies;
  assert.deepEqual(list[0].members, ["user_bob", "user_cat"]);
  assert.deepEqual(list[0].online, [true, false]);
  const { lobby } = (await call("cat", "GET", `/api/lobbies/${body.id}`)).body;
  assert.deepEqual(lobby.roster.map((r) => r.online), [true, false]);
  tab.close();
  await wait(100);
});

test("the status setting needs a profile and a true/false value", async () => {
  accounts.findOrCreate("noprofile");
  assert.equal((await call("noprofile", "PUT", "/api/status", { invisible: true })).status, 400);
  assert.equal((await call("ann", "PUT", "/api/status", { invisible: "yes" })).status, 400);
  // Other students never learn whether someone is invisible, only that they're offline.
  const { profile } = (await call("bob", "GET", "/api/profiles/user_ann")).body;
  assert.equal("invisible" in profile, false);
});
