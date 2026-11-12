// Key Service tests: it needs the token, returns the HMAC, and rate-limits.
const test = require("node:test");
const assert = require("node:assert");
const crypto = require("node:crypto");
const { createKeyServer } = require("../server/keyservice");

let server, url;
test.before(async () => {
  server = createKeyServer({ key: "k", token: "secret-token", maxPerMinute: 3 });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${server.address().port}/anon-id`;
});
test.after(() => server.close());

const ask = (token, body) => fetch(url, {
  method: "POST",
  headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify(body),
});

test("refuses requests without the right token", async () => {
  assert.equal((await ask(null, { email: "a@mit.edu" })).status, 401);
  assert.equal((await ask("wrong", { email: "a@mit.edu" })).status, 401);
});

test("returns HMAC-SHA256(key, lowercased email)", async () => {
  const res = await ask("secret-token", { email: "A@MIT.edu" });
  assert.equal(res.status, 200);
  const expected = crypto.createHmac("sha256", "k").update("a@mit.edu").digest("hex");
  assert.deepEqual(await res.json(), { anonId: expected });
  assert.equal((await ask("secret-token", { email: "nope" })).status, 400);
});

test("limits how many lookups it does per minute", async () => {
  // The test above used 2 of the 3 allowed; bad-token requests don't count.
  assert.equal((await ask("secret-token", { email: "b@mit.edu" })).status, 200);
  assert.equal((await ask("secret-token", { email: "c@mit.edu" })).status, 429);
});
