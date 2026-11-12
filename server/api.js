// JSON API for signed-in students.
//   GET /api/catalog            -> games and dorms to choose from
//   GET /api/profile            -> your own profile (or null)
//   PUT /api/profile            -> create or update your profile
//   GET /api/profiles/:username -> another student's public profile
//   GET  /api/lobbies?game=&vibe=&voice=  -> open lobbies (+ your current lobby id)
//   POST /api/lobbies                     -> create a lobby
//   GET  /api/lobbies/:id                 -> lobby details (more for members)
//   POST /api/lobbies/:id/join | leave | close
//   POST /api/lobbies/:id/messages        -> send a chat message
//   GET  /api/events?lobby=:id            -> live updates (Server-Sent Events)
const { GAMES, DORMS } = require("./catalog");
const profiles = require("./profiles");
const lobbies = require("./lobbies");
const events = require("./events");
const { currentAnonId } = require("./auth");

const MAX_BODY = 16 * 1024;

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  // Requiring JSON also blocks cross-site form posts (browsers can't send
  // this content type cross-site without a CORS preflight we never allow).
  if (!String(req.headers["content-type"] || "").startsWith("application/json")) {
    throw new profiles.ValidationError("Expected JSON.");
  }
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > MAX_BODY) throw new profiles.ValidationError("Request too large.");
  }
  try {
    return body ? JSON.parse(body) : {};
  } catch {
    throw new profiles.ValidationError("Invalid JSON.");
  }
}

// Returns true if it handled the request.
async function handle(config, req, res, url) {
  const p = url.pathname;
  if (!p.startsWith("/api/") || p === "/api/me" || p === "/api/health") return false;

  const anonId = currentAnonId(config, req);
  if (!anonId) {
    json(res, 401, { error: "Not signed in." });
    return true;
  }

  try {
    // Every change must be sent as JSON (see readJson) so other sites can't
    // trigger it with a plain form.
    const body = req.method === "GET" ? null : await readJson(req);
    const lobbyMatch = p.match(/^\/api\/lobbies\/(\d+)(?:\/(join|leave|close|messages))?$/);

    if (req.method === "GET" && p === "/api/catalog") {
      json(res, 200, { games: GAMES, dorms: DORMS, vibes: lobbies.VIBES });
    } else if (req.method === "GET" && p === "/api/profile") {
      json(res, 200, { profile: profiles.getOwn(anonId) });
    } else if (req.method === "PUT" && p === "/api/profile") {
      json(res, 200, { profile: profiles.save(anonId, body) });
    } else if (req.method === "GET" && p.startsWith("/api/profiles/")) {
      const profile = profiles.getPublic(decodeURIComponent(p.slice("/api/profiles/".length)));
      if (profile) json(res, 200, { profile });
      else json(res, 404, { error: "No such user." });
    } else if (req.method === "GET" && p === "/api/lobbies") {
      const q = url.searchParams;
      json(res, 200, {
        lobbies: lobbies.list({ game: q.get("game"), vibe: q.get("vibe"), voice: q.get("voice") }),
        myLobbyId: lobbies.activeLobbyId(anonId),
      });
    } else if (req.method === "POST" && p === "/api/lobbies") {
      const id = lobbies.create(anonId, body);
      events.publish("lobbies", "changed");
      json(res, 201, { id });
    } else if (req.method === "GET" && lobbyMatch && !lobbyMatch[2]) {
      json(res, 200, { lobby: lobbies.detail(anonId, Number(lobbyMatch[1])) });
    } else if (req.method === "POST" && lobbyMatch && lobbyMatch[2] === "messages") {
      const id = Number(lobbyMatch[1]);
      const message = lobbies.postMessage(anonId, id, body && body.body);
      events.publish(`lobby:${id}`, "message", message);
      json(res, 201, { message });
    } else if (req.method === "POST" && lobbyMatch && lobbyMatch[2]) {
      const id = Number(lobbyMatch[1]);
      lobbies[lobbyMatch[2]](anonId, id);
      if (lobbyMatch[2] === "leave") events.kick(`lobby:${id}`, anonId);
      events.publish("lobbies", "changed");
      events.publish(`lobby:${id}`, "changed");
      json(res, 200, { lobby: lobbies.detail(anonId, id) });
    } else if (req.method === "GET" && p === "/api/events") {
      const channels = ["lobbies"];
      const lobbyId = Number(url.searchParams.get("lobby"));
      if (lobbyId && !lobbies.isMember(anonId, lobbyId)) {
        json(res, 403, { error: "Not a member." });
      } else {
        if (lobbyId) channels.push(`lobby:${lobbyId}`);
        events.subscribe(res, anonId, channels);
      }
    } else {
      json(res, 404, { error: "Not found." });
    }
  } catch (err) {
    if (err instanceof profiles.ValidationError) json(res, 400, { error: err.message });
    else if (err instanceof lobbies.NotFoundError) json(res, 404, { error: err.message });
    else if (err instanceof lobbies.ForbiddenError) json(res, 403, { error: err.message });
    else throw err;
  }
  return true;
}

module.exports = { handle };
