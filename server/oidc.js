// Talks to Petrock (MIT Touchstone via OpenID Connect).
// Flow: send the browser to Petrock -> get a one-time code back ->
// exchange the code server-to-server for tokens -> check the ID token ->
// ask Petrock's userinfo endpoint for email and affiliation.
const crypto = require("node:crypto");

function authorizationUrl(config, { state, nonce }) {
  const url = new URL(config.authorizationEndpoint);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    scope: "openid email profile",
    state,
    nonce,
  }).toString();
  return url.toString();
}

async function exchangeCode(config, code) {
  // Petrock only supports client_secret_basic.
  const basic = Buffer.from(
    `${encodeURIComponent(config.clientId)}:${encodeURIComponent(config.clientSecret)}`
  ).toString("base64");
  const res = await fetch(config.tokenEndpoint, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: config.redirectUri,
    }).toString(),
  });
  if (!res.ok) throw new Error(`token endpoint returned ${res.status}`);
  const tokens = await res.json();
  if (!tokens.id_token || !tokens.access_token) throw new Error("token response missing tokens");
  return tokens;
}

let jwksCache = { uri: null, keys: [], fetchedAt: 0 };

async function getKey(config, kid, { refresh = false } = {}) {
  const fresh = jwksCache.uri === config.jwksUri && Date.now() - jwksCache.fetchedAt < 3600_000;
  if (refresh || !fresh) {
    const res = await fetch(config.jwksUri, { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`jwks endpoint returned ${res.status}`);
    const { keys = [] } = await res.json();
    jwksCache = { uri: config.jwksUri, keys, fetchedAt: Date.now() };
  }
  const usable = jwksCache.keys.filter((k) => k.kty === "RSA" && (!k.use || k.use === "sig"));
  return kid ? usable.find((k) => k.kid === kid) : usable.length === 1 ? usable[0] : undefined;
}

function b64urlJson(part) {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
}

async function verifyIdToken(config, idToken, expectedNonce) {
  const parts = idToken.split(".");
  if (parts.length !== 3) throw new Error("malformed ID token");
  const header = b64urlJson(parts[0]);
  if (header.alg !== "RS256") throw new Error(`unexpected ID token alg ${header.alg}`);

  // Refetch keys once if the key ID is unknown (Petrock may have rotated keys).
  const jwk = (await getKey(config, header.kid)) || (await getKey(config, header.kid, { refresh: true }));
  if (!jwk) throw new Error("no matching signing key");
  const ok = crypto.verify(
    "RSA-SHA256",
    Buffer.from(`${parts[0]}.${parts[1]}`),
    crypto.createPublicKey({ key: jwk, format: "jwk" }),
    Buffer.from(parts[2], "base64url")
  );
  if (!ok) throw new Error("bad ID token signature");

  const claims = b64urlJson(parts[1]);
  const now = Math.floor(Date.now() / 1000);
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.iss !== config.issuer) throw new Error("wrong ID token issuer");
  if (!aud.includes(config.clientId)) throw new Error("wrong ID token audience");
  if (typeof claims.exp !== "number" || claims.exp < now - 60) throw new Error("expired ID token");
  if (claims.nonce !== expectedNonce) throw new Error("wrong ID token nonce");
  if (!claims.sub) throw new Error("ID token missing sub");
  return claims;
}

async function fetchUserinfo(config, accessToken) {
  const res = await fetch(config.userinfoEndpoint, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`userinfo endpoint returned ${res.status}`);
  return res.json();
}

// Returns { email, affiliation, name } for the person who just signed in.
async function completeSignIn(config, code, expectedNonce) {
  const tokens = await exchangeCode(config, code);
  const idClaims = await verifyIdToken(config, tokens.id_token, expectedNonce);
  const info = await fetchUserinfo(config, tokens.access_token);
  if (info.sub !== idClaims.sub) throw new Error("userinfo sub does not match ID token");
  const email = String(info.email || idClaims.email || "").trim().toLowerCase();
  if (!email) throw new Error("no email returned");
  const affiliation = String(info.affiliation || idClaims.affiliation || "").trim().toLowerCase();
  const name = String(info.name || idClaims.name || "");
  return { email, affiliation, name };
}

module.exports = { authorizationUrl, completeSignIn };
