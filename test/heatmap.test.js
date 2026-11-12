// Heat map tests: opt-in, the k rule, campus-time grid, and the API.
const test = require("node:test");
const assert = require("node:assert");
const db = require("../server/db");
const accounts = require("../server/accounts");
const profiles = require("../server/profiles");
const lobbies = require("../server/lobbies");
const presence = require("../server/presence");
const heatmap = require("../server/heatmap");
const events = require("../server/events");
const { loadConfig } = require("../server/config");
const { createServer } = require("../server/index");
const { sign } = require("../server/session");

const HOUR = 3600_000;
const config = loadConfig({ PETROCK_CLIENT_ID: "c", PETROCK_CLIENT_SECRET: "s", ANON_ID_KEY: "k", SESSION_SECRET: "secret" });
const cookieFor = (id) => `bp_session=${sign("secret", { anonId: id, exp: Date.now() + 60_000 })}`;
let base, server;

async function call(anonId, method, path, body) {
  const headers = { Cookie: cookieFor(anonId) };
  if (method !== "GET") headers["Content-Type"] = "application/json";
  const res = await fetch(base + path, { method, headers, body: method === "GET" ? undefined : JSON.stringify(body || {}) });
  return { status: res.status, body: await res.json() };
}

const IDS = ["p1", "p2", "p3", "p4"];

function fresh() {
  db.open(":memory:");
  heatmap.reset();
  for (const id of [...IDS, "nope"]) {
    accounts.findOrCreate(id);
    profiles.save(id, { username: `user_${id}`, games: [{ game: "Valorant" }] });
  }
}

// Everyone in IDS (opted in) joins one Valorant lobby; "nope" hosts Minecraft without opting in.
function fillLobbies() {
  for (const id of IDS) heatmap.setOptIn(id, true);
  const v = lobbies.create("p1", { game: "Valorant", slots: 6 });
  for (const id of IDS.slice(1)) lobbies.join(id, v);
  lobbies.create("nope", { game: "Minecraft", slots: 4 });
}

// Tuesday 2026-11-10, 9 PM in Boston (EST, UTC-5) = 02:00 UTC Wednesday.
const TUE_9PM = Date.UTC(2026, 10, 11, 2, 30);

test.before(async () => {
  heatmap.options.k = 3;
  fresh();
  server = createServer(config);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { events.closeAll(); presence.reset(); server.close(); });

test("counts only opted-in players in lobbies, and saves the hour's total when it ends", () => {
  fresh();
  fillLobbies();
  heatmap.sample(TUE_9PM);
  assert.equal(heatmap.currentCount("Valorant"), 4);
  assert.equal(heatmap.currentCount("Minecraft"), 0, "not opted in");
  assert.equal(heatmap.currentCount(heatmap.ALL), 4);
  heatmap.sample(TUE_9PM + 10 * 60_000);
  assert.equal(heatmap.currentCount("Valorant"), 4, "the same people aren't counted twice");

  heatmap.sample(TUE_9PM + HOUR); // next hour: the last one is saved
  const rows = db.get().prepare("SELECT * FROM heatmap_hours ORDER BY game").all();
  assert.deepEqual(rows.map((r) => [r.game, r.players]), [["*", 4], ["Valorant", 4]]);
  assert.ok(!Object.keys(rows[0]).some((c) => /anon/.test(c)), "no IDs are stored");
});

test("hours with fewer than k players are thrown away", () => {
  fresh();
  heatmap.setOptIn("p1", true);
  heatmap.setOptIn("p2", true);
  const v = lobbies.create("p1", { game: "Valorant", slots: 4 });
  lobbies.join("p2", v);
  heatmap.sample(TUE_9PM);
  heatmap.sample(TUE_9PM + HOUR);
  assert.equal(db.get().prepare("SELECT COUNT(*) AS n FROM heatmap_hours").get().n, 0);
});

test("invisible, opted-out, and closed-lobby players aren't counted", () => {
  fresh();
  fillLobbies();
  presence.setInvisible("p2", true);
  heatmap.setOptIn("p3", false);
  heatmap.sample(TUE_9PM);
  assert.equal(heatmap.currentCount("Valorant"), 2);
  heatmap.setOptIn("p4", false); // opting out mid-hour removes you from it
  assert.equal(heatmap.currentCount("Valorant"), 1);
  lobbies.close("p1", lobbies.activeLobbyId("p1"));
  heatmap.reset();
  heatmap.sample(TUE_9PM);
  assert.equal(heatmap.currentCount(heatmap.ALL), 0);
});

test("the grid is in Boston time, averages over weeks, and hides the current hour", () => {
  fresh();
  fillLobbies();
  heatmap.sample(TUE_9PM);
  let g = heatmap.grid("Valorant", TUE_9PM + 5 * 60_000);
  assert.equal(g.cells[1][21], null, "current hour isn't shown");

  heatmap.sample(TUE_9PM + HOUR);
  g = heatmap.grid("Valorant", TUE_9PM + HOUR);
  assert.equal(g.weeks, 1);
  assert.equal(g.cells[1][21], 4, "Tuesday 9 PM");
  assert.equal(g.cells.flat().filter((v) => v !== null).length, 1);

  const later = heatmap.grid("Valorant", TUE_9PM + 14 * 24 * HOUR);
  assert.equal(later.weeks, 2);
  assert.equal(later.cells[1][21], 2, "4 players over 2 weeks");
  assert.equal(heatmap.grid("Not a game").game, heatmap.ALL);
});

test("saved hours older than four weeks are deleted", () => {
  fresh();
  fillLobbies();
  heatmap.sample(TUE_9PM);
  heatmap.sample(TUE_9PM + HOUR);
  heatmap.sample(TUE_9PM + 30 * 24 * HOUR);
  heatmap.sample(TUE_9PM + 30 * 24 * HOUR + HOUR);
  const hours = db.get().prepare("SELECT DISTINCT hour FROM heatmap_hours").all();
  assert.equal(hours.length, 1);
});

test("API: opt in and out, and read the grid", async () => {
  fresh();
  let res = await call("p1", "GET", "/api/heatmap");
  assert.equal(res.status, 200);
  assert.equal(res.body.optedIn, false);
  assert.equal(res.body.game, "*");
  assert.equal(res.body.cells.length, 7);
  assert.equal(res.body.cells[0].length, 24);
  assert.equal(res.body.k, 3);

  res = await call("p1", "PUT", "/api/heatmap/opt-in", { optIn: true });
  assert.deepEqual(res.body, { optedIn: true });
  assert.equal((await call("p1", "GET", "/api/heatmap?game=Valorant")).body.optedIn, true);
  assert.equal((await call("p1", "PUT", "/api/heatmap/opt-in", { optIn: "yes" })).status, 400);
  accounts.findOrCreate("noprofile");
  assert.equal((await call("noprofile", "PUT", "/api/heatmap/opt-in", { optIn: true })).status, 400);
  res = await call("p1", "PUT", "/api/heatmap/opt-in", { optIn: false });
  assert.equal(profiles.getOwn("p1") && heatmap.isOptedIn("p1"), false);

  // Saving your profile doesn't reset the setting.
  heatmap.setOptIn("p2", true);
  profiles.save("p2", { username: "user_p2", games: [{ game: "Minecraft" }] });
  assert.equal(heatmap.isOptedIn("p2"), true);
});
