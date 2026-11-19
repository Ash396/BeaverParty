// Moderator list from the MODERATORS setting.
const test = require("node:test");
const assert = require("node:assert");
const db = require("../server/db");
const accounts = require("../server/accounts");
const moderators = require("../server/moderators");
const { computeAnonId } = require("../server/keyservice");
const { loadConfig } = require("../server/config");

const configWith = (env) => loadConfig({ ANON_ID_KEY: "k", ...env });
const idOf = (email) => computeAnonId("k", email);
const isMod = (email) => Boolean(accounts.find(idOf(email))?.isModerator);

test.before(() => db.open(":memory:"));

test("unset leaves moderators alone", async () => {
  accounts.setModerator(idOf("old@mit.edu"), true);
  assert.strictEqual(await moderators.sync(configWith({})), null);
  assert.ok(isMod("old@mit.edu"));
});

test("the list adds everyone on it and removes everyone else", async () => {
  accounts.setModerator(idOf("old@mit.edu"), true);
  const n = await moderators.sync(configWith({ MODERATORS: " Ann@MIT.edu, bob@mit.edu ,," }));
  assert.strictEqual(n, 2);
  assert.ok(isMod("ann@mit.edu"));
  assert.ok(isMod("bob@mit.edu"));
  assert.ok(!isMod("old@mit.edu"));
});

test("an empty list removes all moderators", async () => {
  await moderators.sync(configWith({ MODERATORS: "" }));
  assert.ok(!isMod("ann@mit.edu"));
  assert.ok(!isMod("bob@mit.edu"));
});

test("a failed lookup changes nothing", async () => {
  accounts.setModerator(idOf("ann@mit.edu"), true);
  const config = loadConfig({ KEY_SERVICE_URL: "http://127.0.0.1:1", KEY_SERVICE_TOKEN: "t", MODERATORS: "bob@mit.edu" });
  await assert.rejects(moderators.sync(config));
  assert.ok(isMod("ann@mit.edu"));
  assert.ok(!isMod("bob@mit.edu"));
});
