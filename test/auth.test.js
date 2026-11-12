// End-to-end sign-in test against a fake Petrock running on localhost.
// Run with: npm test
const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const crypto = require("node:crypto");
const { loadConfig } = require("../server/config");
const { createServer } = require("../server/index");
const accounts = require("../server/accounts");
const { anonIdFor } = require("../server/auth");
const db = require("../server/db");

const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1", use: "sig", alg: "RS256" };

function jwt(claims, key = privateKey) {
  const h = Buffer.from(JSON.stringify({ alg: "RS256", kid: "k1", typ: "JWT" })).toString("base64url");
  const p = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const s = crypto.sign("RSA-SHA256", Buffer.from(`${h}.${p}`), key).toString("base64url");
  return `${h}.${p}.${s}`;
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

// The fake provider remembers the nonce from /authorize and returns whatever
// user `nextUser` holds.
const fake = { nonce: null, nextUser: null, badSignature: false, lastAuthHeader: null };
let issuer;
const provider = http.createServer(async (req, res) => {
  const url = new URL(req.url, issuer);
  let body = "";
  for await (const chunk of req) body += chunk;
  if (url.pathname === "/touchstone/oidc/authorization") {
    fake.nonce = url.searchParams.get("nonce");
    const back = new URL(url.searchParams.get("redirect_uri"));
    back.searchParams.set("code", "code123");
    back.searchParams.set("state", url.searchParams.get("state"));
    res.writeHead(302, { Location: back.toString() });
    return res.end();
  }
  if (url.pathname === "/oidc/token") {
    fake.lastAuthHeader = req.headers.authorization;
    if (new URLSearchParams(body).get("code") !== "code123") {
      res.writeHead(400);
      return res.end();
    }
    const now = Math.floor(Date.now() / 1000);
    const claims = { iss: issuer, aud: "client1", sub: fake.nextUser.email, exp: now + 300, iat: now, nonce: fake.nonce };
    const key = fake.badSignature ? crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey : privateKey;
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ access_token: "at1", token_type: "Bearer", id_token: jwt(claims, key) }));
  }
  if (url.pathname === "/oidc/userinfo") {
    res.writeHead(200, { "Content-Type": "application/json" });
    const u = fake.nextUser;
    return res.end(JSON.stringify({ sub: u.email, email: u.email, affiliation: u.affiliation, name: "Tim Beaver" }));
  }
  if (url.pathname === "/oidc/jwks") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ keys: [jwk] }));
  }
  res.writeHead(404);
  res.end();
});

let app, base, config;

test.before(async () => {
  db.open(":memory:");
  issuer = `http://127.0.0.1:${await listen(provider)}`;
  // The app reads its config per request, so we can fill it in once the
  // app's port is known.
  config = {};
  app = createServer(config);
  base = `http://127.0.0.1:${await listen(app)}`;
  Object.assign(config, loadConfig({
    BASE_URL: base,
    PETROCK_ISSUER: issuer,
    PETROCK_CLIENT_ID: "client1",
    PETROCK_CLIENT_SECRET: "secret1",
    ANON_ID_KEY: "anon-key",
    SESSION_SECRET: "session-secret",
  }));
});

test.after(() => {
  app.close();
  provider.close();
});

// Walks the browser side of the flow by hand, carrying cookies along.
async function signIn(user) {
  fake.nextUser = user;
  const login = await fetch(`${base}/auth/login`, { redirect: "manual" });
  const loginCookie = login.headers.get("set-cookie").split(";")[0];
  const atProvider = await fetch(login.headers.get("location"), { redirect: "manual" });
  const callback = await fetch(atProvider.headers.get("location"), {
    redirect: "manual",
    headers: { Cookie: loginCookie },
  });
  const session = callback.headers.getSetCookie().find((c) => c.startsWith("bp_session="));
  return { location: callback.headers.get("location"), session: session && session.split(";")[0] };
}

test("a student signs in and gets a 7-day session", async () => {
  const { location, session } = await signIn({ email: "Tim@MIT.edu", affiliation: "student" });
  assert.equal(location, "/app.html");
  assert.ok(session);
  assert.equal(fake.lastAuthHeader, `Basic ${Buffer.from("client1:secret1").toString("base64")}`);
  const me = await (await fetch(`${base}/api/me`, { headers: { Cookie: session } })).json();
  assert.deepEqual(me, { authEnabled: true, signedIn: true, isModerator: false, username: null, warning: null, invisible: false });
  // The account is stored under the HMAC of the lowercased email only.
  assert.ok(accounts.find(await anonIdFor(config, "tim@mit.edu")));
});

test("a non-student is turned away and nothing is stored", async () => {
  const { location, session } = await signIn({ email: "prof@mit.edu", affiliation: "faculty" });
  assert.equal(location, "/students-only.html");
  assert.equal(session, undefined);
  assert.equal(accounts.find(await anonIdFor(config, "prof@mit.edu")), undefined);
});

test("a banned student is refused", async () => {
  accounts.setBanned(await anonIdFor(config, "bad@mit.edu"), true);
  const { location, session } = await signIn({ email: "bad@mit.edu", affiliation: "student" });
  assert.equal(location, "/banned.html");
  assert.equal(session, undefined);
});

test("an ID token with a bad signature is rejected", async () => {
  fake.badSignature = true;
  const { location, session } = await signIn({ email: "tim@mit.edu", affiliation: "student" });
  fake.badSignature = false;
  assert.equal(location, "/signin-failed.html");
  assert.equal(session, undefined);
});

test("a callback without the login cookie is rejected", async () => {
  const res = await fetch(`${base}/auth/callback?code=code123&state=x`, { redirect: "manual" });
  assert.equal(res.headers.get("location"), "/signin-failed.html");
});

test("a tampered session cookie is not signed in", async () => {
  const { session } = await signIn({ email: "tim@mit.edu", affiliation: "student" });
  const tampered = session.slice(0, -2) + (session.endsWith("AA") ? "BB" : "AA");
  const me = await (await fetch(`${base}/api/me`, { headers: { Cookie: tampered } })).json();
  assert.equal(me.signedIn, false);
});

test("with DEBUG_SHOW_IDENTITY on, the test page shows what Petrock sent", async () => {
  config.debugShowIdentity = true;
  try {
    fake.nextUser = { email: "tim@mit.edu", affiliation: "student" };
    const login = await fetch(`${base}/auth/login`, { redirect: "manual" });
    const atProvider = await fetch(login.headers.get("location"), { redirect: "manual" });
    const callback = await fetch(atProvider.headers.get("location"), {
      redirect: "manual",
      headers: { Cookie: login.headers.get("set-cookie").split(";")[0] },
    });
    assert.equal(callback.status, 200);
    const html = await callback.text();
    assert.match(html, /tim@mit\.edu/);
    assert.match(html, /Tim Beaver/);
    assert.match(html, /student/);
    assert.match(html, /signed in/);
    assert.ok(callback.headers.getSetCookie().some((c) => c.startsWith("bp_session=")));
  } finally {
    config.debugShowIdentity = false;
  }
});

test("with a Key Service, the web server needs no ANON_ID_KEY and accounts keep the same ID", async () => {
  const { createKeyServer } = require("../server/keyservice");
  const keys = createKeyServer({ key: "anon-key", token: "tok" });
  const keysUrl = `http://127.0.0.1:${await listen(keys)}`;
  const before = { anonIdKey: config.anonIdKey };
  Object.assign(config, { anonIdKey: undefined, keyServiceUrl: keysUrl, keyServiceToken: "tok" });
  try {
    const { location } = await signIn({ email: "tim@mit.edu", affiliation: "student" });
    assert.equal(location, "/app.html");
    // Same key, same ID as when the web server computed it itself.
    assert.equal(await anonIdFor(config, "tim@mit.edu"), await anonIdFor({ anonIdKey: "anon-key" }, "tim@mit.edu"));

    // If the Key Service refuses, sign-in fails safely.
    config.keyServiceToken = "wrong";
    assert.equal((await signIn({ email: "tim@mit.edu", affiliation: "student" })).location, "/signin-failed.html");
  } finally {
    Object.assign(config, before, { keyServiceUrl: undefined, keyServiceToken: undefined });
    keys.close();
  }
});

test("config wants the Key Service token instead of ANON_ID_KEY when a Key Service is set", () => {
  const base = { PETROCK_CLIENT_ID: "c", PETROCK_CLIENT_SECRET: "s", SESSION_SECRET: "x" };
  assert.deepEqual(loadConfig({ ...base, KEY_SERVICE_URL: "https://k" }).missing, ["KEY_SERVICE_TOKEN"]);
  assert.equal(loadConfig({ ...base, KEY_SERVICE_URL: "https://k", KEY_SERVICE_TOKEN: "t" }).authEnabled, true);
  assert.deepEqual(loadConfig(base).missing, ["ANON_ID_KEY"]);
});
