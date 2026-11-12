// Lobbies and lobby chat. A lobby is open until it has as many members as
// slots (full), and closed when the host closes or leaves it. Members see
// each other's in-game names for the lobby's game; the Discord invite is
// shown to members once the lobby fills. Each student can be in one open
// or full lobby at a time.
const db = require("./db");
const { GAMES } = require("./catalog");
const { ValidationError, avatarOf } = require("./profiles");

const VIBES = ["casual", "competitive"];
const MAX_SLOTS = 10;
const MAX_MESSAGE = 500;
// Only real Discord invite links, so the field can't be used for phishing links.
const DISCORD_RE = /^https:\/\/(discord\.gg|(www\.)?discord\.com\/invite)\/[A-Za-z0-9-]{2,32}$/;

class NotFoundError extends Error {}
class ForbiddenError extends Error {}

function text(value, max, label) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new ValidationError(`${label} must be text.`);
  const v = value.trim();
  if (v.length > max) throw new ValidationError(`${label} must be at most ${max} characters.`);
  return v || null;
}

function usernameOf(anonId) {
  const row = db.get().prepare("SELECT username FROM profiles WHERE anon_id = ?").get(anonId);
  return row ? row.username : null;
}

function activeLobbyId(anonId) {
  const row = db.get().prepare(`
    SELECT l.id FROM lobbies l JOIN lobby_members m ON m.lobby_id = l.id
    WHERE m.anon_id = ? AND l.state IN ('open', 'full')
  `).get(anonId);
  return row ? row.id : null;
}

function requireReady(anonId) {
  if (!usernameOf(anonId)) throw new ValidationError("Create your profile first.");
  if (activeLobbyId(anonId)) throw new ValidationError("Leave your current lobby first.");
}

function load(id) {
  const lobby = db.get().prepare("SELECT * FROM lobbies WHERE id = ?").get(id);
  if (!lobby) throw new NotFoundError("No such lobby.");
  return lobby;
}

function memberIds(id) {
  return db.get()
    .prepare("SELECT anon_id FROM lobby_members WHERE lobby_id = ? ORDER BY joined_at, rowid")
    .all(id)
    .map((r) => r.anon_id);
}

function isMember(anonId, id) {
  return Boolean(db.get()
    .prepare("SELECT 1 FROM lobby_members WHERE lobby_id = ? AND anon_id = ?")
    .get(id, anonId));
}

function create(anonId, input) {
  requireReady(anonId);
  if (!input || typeof input !== "object") throw new ValidationError("Expected a lobby.");
  let game = text(input.game, 60, "Game");
  if (game === "Other") game = text(input.otherGame, 40, "Game name");
  else if (!GAMES.includes(game)) throw new ValidationError("Pick a game.");
  if (!game) throw new ValidationError("Type the game's name.");
  const slots = Number(input.slots);
  if (!Number.isInteger(slots) || slots < 2 || slots > MAX_SLOTS) {
    throw new ValidationError(`Players must be between 2 and ${MAX_SLOTS}.`);
  }
  const vibe = text(input.vibe, 20, "Vibe") || "casual";
  if (!VIBES.includes(vibe)) throw new ValidationError("Vibe must be casual or competitive.");
  const discord = text(input.discordInvite, 100, "Discord invite");
  if (discord && !DISCORD_RE.test(discord)) {
    throw new ValidationError("Discord invite must look like https://discord.gg/abc123.");
  }
  const conn = db.get();
  conn.exec("BEGIN");
  try {
    const { lastInsertRowid: id } = conn.prepare(`
      INSERT INTO lobbies (host_anon_id, game, slots, vibe, rank, voice, discord_invite)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(anonId, game, slots, vibe, text(input.rank, 30, "Rank"), input.voice ? 1 : 0, discord);
    conn.prepare("INSERT INTO lobby_members (lobby_id, anon_id) VALUES (?, ?)").run(id, anonId);
    conn.exec("COMMIT");
    return Number(id);
  } catch (err) {
    conn.exec("ROLLBACK");
    throw err;
  }
}

function summary(lobby) {
  const members = memberIds(lobby.id);
  return {
    id: lobby.id,
    game: lobby.game,
    slots: lobby.slots,
    vibe: lobby.vibe,
    rank: lobby.rank,
    voice: Boolean(lobby.voice),
    state: lobby.state,
    host: usernameOf(lobby.host_anon_id),
    members: members.map(usernameOf),
    avatars: members.map(avatarOf),
    createdAt: lobby.created_at,
  };
}

// Open lobbies, newest first, with optional filters.
function list({ game, vibe, voice } = {}) {
  const where = ["state = 'open'"];
  const args = [];
  if (game) { where.push("game = ?"); args.push(game); }
  if (vibe) { where.push("vibe = ?"); args.push(vibe); }
  if (voice === "on" || voice === "off") { where.push("voice = ?"); args.push(voice === "on" ? 1 : 0); }
  return db.get()
    .prepare(`SELECT * FROM lobbies WHERE ${where.join(" AND ")} ORDER BY id DESC LIMIT 100`)
    .all(...args)
    .map(summary);
}

// Everyone can see the summary; members also get in-game names, chat, and
// (once full) the Discord invite.
function detail(anonId, id) {
  const lobby = load(id);
  const out = summary(lobby);
  out.isMember = isMember(anonId, id);
  out.isHost = lobby.host_anon_id === anonId;
  if (out.isMember) {
    const ign = db.get().prepare("SELECT in_game_name FROM profile_games WHERE anon_id = ? AND game = ?");
    out.roster = memberIds(id).map((m) => ({
      username: usernameOf(m),
      avatar: avatarOf(m),
      inGameName: (ign.get(m, lobby.game) || {}).in_game_name || null,
    }));
    out.discordInvite = lobby.state !== "open" ? lobby.discord_invite : null;
    out.hasDiscordInvite = Boolean(lobby.discord_invite);
    out.messages = messages(id);
  }
  return out;
}

function updateFullness(id) {
  const lobby = load(id);
  if (lobby.state === "closed") return;
  const count = memberIds(id).length;
  const state = count >= lobby.slots ? "full" : "open";
  if (state !== lobby.state) db.get().prepare("UPDATE lobbies SET state = ? WHERE id = ?").run(state, id);
}

function join(anonId, id) {
  const lobby = load(id);
  if (isMember(anonId, id)) return;
  requireReady(anonId);
  if (lobby.state !== "open") throw new ValidationError("This lobby isn't open.");
  db.get().prepare("INSERT INTO lobby_members (lobby_id, anon_id) VALUES (?, ?)").run(id, anonId);
  updateFullness(id);
}

function close(anonId, id) {
  const lobby = load(id);
  if (lobby.host_anon_id !== anonId) throw new ForbiddenError("Only the host can close the lobby.");
  if (lobby.state === "closed") return;
  db.get().prepare("UPDATE lobbies SET state = 'closed', closed_at = datetime('now') WHERE id = ?").run(id);
}

// Leaving as host closes the lobby. Members stay on the roster of a closed
// lobby so they can endorse or report each other afterwards.
function leave(anonId, id) {
  const lobby = load(id);
  if (!isMember(anonId, id)) return;
  if (lobby.host_anon_id === anonId) return close(anonId, id);
  if (lobby.state === "closed") return;
  db.get().prepare("DELETE FROM lobby_members WHERE lobby_id = ? AND anon_id = ?").run(id, anonId);
  updateFullness(id);
}

function messages(id) {
  return db.get().prepare(`
    SELECT m.id, p.username, m.body, m.created_at AS createdAt
    FROM messages m LEFT JOIN profiles p ON p.anon_id = m.anon_id
    WHERE m.lobby_id = ? ORDER BY m.id
  `).all(id).map((m) => ({ ...m }));
}

const recentPosts = new Map(); // anonId -> timestamps, for a simple rate limit

function postMessage(anonId, id, body) {
  const lobby = load(id);
  if (!isMember(anonId, id)) throw new ForbiddenError("Join the lobby to chat.");
  if (lobby.state === "closed") throw new ValidationError("This lobby is closed.");
  const clean = text(body, MAX_MESSAGE, "Message");
  if (!clean) throw new ValidationError("Message is empty.");
  const now = Date.now();
  const times = (recentPosts.get(anonId) || []).filter((t) => now - t < 10_000);
  if (times.length >= 8) throw new ValidationError("Slow down a little.");
  recentPosts.set(anonId, [...times, now]);
  const { lastInsertRowid } = db.get()
    .prepare("INSERT INTO messages (lobby_id, anon_id, body) VALUES (?, ?, ?)")
    .run(id, anonId, clean);
  return db.get().prepare(`
    SELECT m.id, p.username, m.body, m.created_at AS createdAt
    FROM messages m LEFT JOIN profiles p ON p.anon_id = m.anon_id WHERE m.id = ?
  `).get(lastInsertRowid);
}

// Deletes chat from lobbies that closed more than `days` days ago.
// (Reports will keep their own copy of any reported messages.)
function deleteOldChats(days) {
  const { changes } = db.get().prepare(`
    DELETE FROM messages WHERE lobby_id IN (
      SELECT id FROM lobbies WHERE state = 'closed' AND closed_at <= datetime('now', ?)
    )
  `).run(`-${Number(days)} days`);
  return Number(changes);
}

module.exports = {
  create, list, detail, join, leave, close, postMessage, deleteOldChats,
  activeLobbyId, isMember, NotFoundError, ForbiddenError, VIBES,
};
