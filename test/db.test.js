// Checks the database schema and the accounts module.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const db = require("../server/db");
const accounts = require("../server/accounts");

test("migrations run once and survive reopening the file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bp-"));
  const file = path.join(dir, "sub", "test.db");
  db.open(file);
  accounts.setBanned("a1", true);
  db.open(file);
  assert.equal(db.get().prepare("PRAGMA user_version").get().user_version, 1);
  assert.equal(accounts.find("a1").banned, true);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("usernames are unique regardless of case", () => {
  db.open(":memory:");
  accounts.findOrCreate("a1");
  accounts.findOrCreate("a2");
  const add = db.get().prepare("INSERT INTO profiles (anon_id, username) VALUES (?, ?)");
  add.run("a1", "TimTheBeaver");
  assert.throws(() => add.run("a2", "timthebeaver"), /UNIQUE/);
});

test("rows must point at a real account", () => {
  db.open(":memory:");
  assert.throws(
    () => db.get().prepare("INSERT INTO profiles (anon_id, username) VALUES ('ghost', 'x')").run(),
    /FOREIGN KEY/
  );
});

test("moderator flag round-trips", () => {
  db.open(":memory:");
  assert.equal(accounts.findOrCreate("m1").isModerator, false);
  accounts.setModerator("m1", true);
  assert.equal(accounts.find("m1").isModerator, true);
});
