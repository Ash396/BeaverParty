// Key Service: the only place the anonymous-ID key lives in production.
//
// The web server sends it an email it just got from Petrock and gets back
// HMAC-SHA256(ANON_ID_KEY, email). So someone who copies the web server's
// settings and database still can't turn a kerb into an account ID, or test
// guesses offline, without also breaking into this service.
//
//   POST /anon-id   Authorization: Bearer KEY_SERVICE_TOKEN
//                   {"email": "..."}  ->  {"anonId": "..."}
//
// It never logs or stores emails, and it rate-limits requests so a stolen
// token can't be used to look up thousands of kerbs quickly.
//
// Run it with ROLE=keys (see server/index.js) and these settings:
//   ANON_ID_KEY        the key (same value the web server used before)
//   KEY_SERVICE_TOKEN  a long random string the web server also has
//   PORT               default 4000
const http = require("node:http");
const crypto = require("node:crypto");

const MAX_PER_MINUTE = 60;

function computeAnonId(key, email) {
  return crypto.createHmac("sha256", key).update(String(email).trim().toLowerCase()).digest("hex");
}

function sameSecret(a, b) {
  const x = crypto.createHash("sha256").update(String(a)).digest();
  const y = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}

function createKeyServer({ key, token, maxPerMinute = MAX_PER_MINUTE }) {
  if (!key || !token) throw new Error("Key Service needs ANON_ID_KEY and KEY_SERVICE_TOKEN.");
  let windowStart = Date.now();
  let count = 0;

  return http.createServer(async (req, res) => {
    const send = (status, body) => {
      res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify(body));
    };
    if (req.method === "GET" && req.url === "/health") return send(200, { status: "ok" });
    if (req.method !== "POST" || req.url !== "/anon-id") return send(404, { error: "Not found." });

    const auth = String(req.headers.authorization || "");
    if (!auth.startsWith("Bearer ") || !sameSecret(auth.slice(7), token)) {
      return send(401, { error: "Bad token." });
    }
    if (Date.now() - windowStart > 60_000) { windowStart = Date.now(); count = 0; }
    if (++count > maxPerMinute) return send(429, { error: "Too many requests." });

    let body = "";
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 1024) return send(413, { error: "Too large." });
    }
    let email;
    try { email = JSON.parse(body).email; } catch { email = null; }
    if (typeof email !== "string" || !email.includes("@")) return send(400, { error: "Expected an email." });
    send(200, { anonId: computeAnonId(key, email) });
  });
}

function start(env = process.env) {
  const server = createKeyServer({ key: env.ANON_ID_KEY, token: env.KEY_SERVICE_TOKEN });
  const port = Number(env.PORT || 4000);
  server.listen(port, () => console.log(`BeaverParty Key Service running on port ${port}`));
  return server;
}

module.exports = { computeAnonId, createKeyServer, start };
