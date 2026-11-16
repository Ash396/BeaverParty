// Lobbies and lobby chat. A host can open a lobby now or schedule it for
// later (up to a week ahead, one at a time); a scheduled lobby is listed as
// upcoming and opens at its time if the host isn't in another lobby then.
// Others can reserve a spot in a scheduled lobby. When it opens, reservers
// who have the app open and aren't in another lobby are added right away;
// everyone else's seat is held for HOLD_MINUTES, then opens up to anyone.
// A lobby is open until it has as many members as
// slots (full), and closed when the host closes or leaves it. Members see
// each other's in-game names for the lobby's game; the Discord invite is
// shown to members once the lobby fills. Each student can be in one open
// or full lobby at a time.
const db = require("./db");
const { GAMES } = require("./catalog");
const { ValidationError, avatarOf } = require("./profiles");
const blocks = require("./blocks");
const presence = require("./presence");
const chatfilter = require("./chatfilter");

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

const MIN_LEAD_MINUTES = 5;
const MAX_LEAD_DAYS = 7;
// If the host is still in another lobby at start time, we keep trying for
// this long, then drop the scheduled lobby.
const GRACE_MINUTES = 30;
const HOLD_MINUTES = 10;
const MAX_RESERVATIONS = 3; // per student, across upcoming lobbies

const sqlTime = (date) => date.toISOString().slice(0, 19).replace("T", " ");

// Returns the start time as SQL UTC text, or null to open now.
function parseStart(value, now = new Date()) {
  if (value === undefined || value === null || value === "") return null;
  const start = new Date(value);
  if (typeof value !== "string" || Number.isNaN(start.getTime())) throw new ValidationError("Pick a start time.");
  if (start - now < MIN_LEAD_MINUTES * 60_000) {
    throw new ValidationError(`Pick a time at least ${MIN_LEAD_MINUTES} minutes from now, or open the lobby now.`);
  }
  if (start - now > MAX_LEAD_DAYS * 86_400_000) throw new ValidationError(`You can schedule up to ${MAX_LEAD_DAYS} days ahead.`);
  return sqlTime(start);
}

// Creates a lobby now (returns { id }) or schedules one (returns { scheduledId }).
function create(anonId, input) {
  if (!input || typeof input !== "object") throw new ValidationError("Expected a lobby.");
  const startsAt = parseStart(input.startsAt);
  if (startsAt) {
    if (!usernameOf(anonId)) throw new ValidationError("Create your profile first.");
  } else requireReady(anonId);
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
  const fields = { game, slots, vibe, rank: text(input.rank, 30, "Rank"), voice: input.voice ? 1 : 0, discord };
  if (startsAt) {
    if (db.get().prepare("SELECT 1 FROM scheduled_lobbies WHERE host_anon_id = ?").get(anonId)) {
      throw new ValidationError("You already have a lobby scheduled. Cancel it first.");
    }
    const { lastInsertRowid } = db.get().prepare(`
      INSERT INTO scheduled_lobbies (host_anon_id, game, slots, vibe, rank, voice, discord_invite, starts_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(anonId, game, slots, vibe, fields.rank, fields.voice, discord, startsAt);
    return { scheduledId: Number(lastInsertRowid) };
  }
  return { id: insertLobby(anonId, fields) };
}

function insertLobby(anonId, { game, slots, vibe, rank, voice, discord }) {
  const conn = db.get();
  conn.exec("BEGIN");
  try {
    const { lastInsertRowid: id } = conn.prepare(`
      INSERT INTO lobbies (host_anon_id, game, slots, vibe, rank, voice, discord_invite)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(anonId, game, slots, vibe, rank, voice, discord);
    conn.prepare("INSERT INTO lobby_members (lobby_id, anon_id) VALUES (?, ?)").run(id, anonId);
    conn.exec("COMMIT");
    return Number(id);
  } catch (err) {
    conn.exec("ROLLBACK");
    throw err;
  }
}

// Upcoming scheduled lobbies, soonest first. Like open lobbies, ones hosted
// by someone the viewer has a block with are left out, and so are banned hosts.
// Upcoming scheduled lobbies, soonest first. Like open lobbies, ones where
// the viewer has a block with the host or anyone who reserved are left out,
// and so are banned hosts. Reservers are listed by username, like a roster.
function upcoming(viewer = null) {
  const hide = viewer ? blocks.related(viewer) : new Set();
  return db.get().prepare(`
    SELECT s.* FROM scheduled_lobbies s JOIN accounts a ON a.anon_id = s.host_anon_id
    WHERE a.banned = 0 ORDER BY s.starts_at, s.id LIMIT 50
  `).all()
    .map((s) => ({ s, reservers: reserverIds(s.id) }))
    .filter(({ s, reservers }) => ![s.host_anon_id, ...reservers].some((m) => hide.has(m)))
    .map(({ s, reservers }) => ({
      id: s.id, game: s.game, slots: s.slots, vibe: s.vibe, rank: s.rank, voice: Boolean(s.voice),
      host: usernameOf(s.host_anon_id), avatar: avatarOf(s.host_anon_id), startsAt: s.starts_at,
      isMine: s.host_anon_id === viewer,
      reserved: reservers.map(usernameOf),
      reservedAvatars: reservers.map(avatarOf),
      isReserved: reservers.includes(viewer),
    }));
}

function reserverIds(scheduledId) {
  return db.get().prepare(`
    SELECT r.anon_id FROM scheduled_reservations r JOIN accounts a ON a.anon_id = r.anon_id
    WHERE r.scheduled_id = ? AND a.banned = 0 ORDER BY r.created_at, r.rowid
  `).all(scheduledId).map((r) => r.anon_id);
}

// Anon IDs with a seat held in this lobby right now.
function heldIds(lobbyId) {
  return db.get().prepare("SELECT anon_id FROM lobby_holds WHERE lobby_id = ? AND held_until > datetime('now')")
    .all(lobbyId).map((r) => r.anon_id);
}

function reserve(anonId, scheduledId) {
  if (!usernameOf(anonId)) throw new ValidationError("Create your profile first.");
  const s = db.get().prepare("SELECT * FROM scheduled_lobbies WHERE id = ?").get(scheduledId);
  if (!s) throw new NotFoundError("No such scheduled lobby.");
  if (s.host_anon_id === anonId) throw new ValidationError("You're hosting this one, so your spot is saved.");
  const reservers = reserverIds(scheduledId);
  if (reservers.includes(anonId)) return;
  // Same wording as a full lobby would get, so nobody learns about a block.
  const related = blocks.related(anonId);
  if ([s.host_anon_id, ...reservers].some((m) => related.has(m))) throw new ValidationError("You can't reserve a spot here.");
  if (reservers.length + 1 >= s.slots) throw new ValidationError("Every spot is already reserved.");
  const { n } = db.get().prepare("SELECT COUNT(*) AS n FROM scheduled_reservations WHERE anon_id = ?").get(anonId);
  if (n >= MAX_RESERVATIONS) throw new ValidationError(`You can reserve up to ${MAX_RESERVATIONS} upcoming lobbies at a time.`);
  db.get().prepare("INSERT INTO scheduled_reservations (scheduled_id, anon_id) VALUES (?, ?)").run(scheduledId, anonId);
}

function unreserve(anonId, scheduledId) {
  db.get().prepare("DELETE FROM scheduled_reservations WHERE scheduled_id = ? AND anon_id = ?").run(scheduledId, anonId);
}

// Open lobbies where you have a seat held, for the "your spot is held" banner.
function holdsFor(anonId) {
  return db.get().prepare(`
    SELECT l.id, l.game, h.held_until AS heldUntil FROM lobby_holds h JOIN lobbies l ON l.id = h.lobby_id
    WHERE h.anon_id = ? AND h.held_until > datetime('now') AND l.state = 'open'
    ORDER BY h.held_until
  `).all(anonId).map((r) => ({ ...r }));
}

function cancelScheduled(anonId, id) {
  const row = db.get().prepare("SELECT host_anon_id FROM scheduled_lobbies WHERE id = ?").get(id);
  if (!row) throw new NotFoundError("No such scheduled lobby.");
  if (row.host_anon_id !== anonId) throw new ForbiddenError("Only the host can cancel it.");
  db.get().prepare("DELETE FROM scheduled_lobbies WHERE id = ?").run(id);
}

// For a ban: their scheduled lobby, reservations, and held seats go.
function dropScheduledFor(anonId) {
  db.get().prepare("DELETE FROM scheduled_lobbies WHERE host_anon_id = ?").run(anonId);
  db.get().prepare("DELETE FROM scheduled_reservations WHERE anon_id = ?").run(anonId);
  db.get().prepare("DELETE FROM lobby_holds WHERE anon_id = ?").run(anonId);
}

// Opens scheduled lobbies whose time has come. Runs every 30 seconds (and
// before listing lobbies). Returns how many lobbies changed, so the caller
// knows whether to tell clients.
function startDue(now = new Date()) {
  const conn = db.get();
  const due = conn.prepare("SELECT * FROM scheduled_lobbies WHERE starts_at <= ? ORDER BY starts_at").all(sqlTime(now));
  let changed = 0;
  for (const s of due) {
    const banned = conn.prepare("SELECT banned FROM accounts WHERE anon_id = ?").get(s.host_anon_id);
    const late = now - new Date(s.starts_at.replace(" ", "T") + "Z") > GRACE_MINUTES * 60_000;
    if (!banned || banned.banned || !usernameOf(s.host_anon_id) || late) {
      conn.prepare("DELETE FROM scheduled_lobbies WHERE id = ?").run(s.id);
      changed++;
      continue;
    }
    if (activeLobbyId(s.host_anon_id)) continue; // host is busy; try again next time
    const lobbyId = insertLobby(s.host_anon_id, {
      game: s.game, slots: s.slots, vibe: s.vibe, rank: s.rank, voice: s.voice, discord: s.discord_invite,
    });
    // Reservers: in now if they have the app open and are free, else a held seat.
    const holdUntil = sqlTime(new Date(now.getTime() + HOLD_MINUTES * 60_000));
    const addMember = conn.prepare("INSERT INTO lobby_members (lobby_id, anon_id) VALUES (?, ?)");
    const addHold = conn.prepare("INSERT INTO lobby_holds (lobby_id, anon_id, held_until) VALUES (?, ?, ?)");
    const placed = [s.host_anon_id];
    for (const r of reserverIds(s.id)) {
      const related = blocks.related(r);
      if (placed.some((m) => related.has(m))) continue; // a block since they reserved
      if (presence.isConnected(r) && !activeLobbyId(r)) addMember.run(lobbyId, r);
      else addHold.run(lobbyId, r, holdUntil);
      placed.push(r);
    }
    updateFullness(lobbyId);
    conn.prepare("DELETE FROM scheduled_lobbies WHERE id = ?").run(s.id);
    changed++;
  }
  return changed;
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
    held: heldIds(lobby.id).length,
    avatars: members.map(avatarOf),
    online: members.map(presence.isOnline),
    createdAt: lobby.created_at,
  };
}

// Open lobbies, newest first, with optional filters. Lobbies with someone
// the viewer has a block with (either way) are left out.
//   rank: the lobby's rank contains this text (ignoring case), e.g. "gold"
//         finds "Gold+" and "Gold 2". Lobbies with no rank set are left out.
//   open: at least this many free slots, e.g. 3 for a group of three.
function list({ game, vibe, voice, rank, open } = {}, viewer = null) {
  const where = ["state = 'open'"];
  const args = [];
  if (game) { where.push("game = ?"); args.push(game); }
  if (vibe) { where.push("vibe = ?"); args.push(vibe); }
  if (voice === "on" || voice === "off") { where.push("voice = ?"); args.push(voice === "on" ? 1 : 0); }
  const r = typeof rank === "string" ? rank.trim().slice(0, 30).toLowerCase() : "";
  if (r) { where.push("instr(lower(rank), ?) > 0"); args.push(r); }
  const minOpen = Number(open);
  if (Number.isInteger(minOpen) && minOpen > 1) {
    where.push(`slots - (SELECT COUNT(*) FROM lobby_members m WHERE m.lobby_id = lobbies.id)
      - (SELECT COUNT(*) FROM lobby_holds h WHERE h.lobby_id = lobbies.id AND h.held_until > datetime('now')) >= ?`);
    args.push(minOpen);
  }
  return db.get()
    .prepare(`SELECT * FROM lobbies WHERE ${where.join(" AND ")} ORDER BY id DESC LIMIT 100`)
    .all(...args)
    .filter((lobby) => !viewer || !hasBlockWith(viewer, lobby.id))
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
    const mine = blocks.blockedBy(anonId);
    const related = blocks.related(anonId);
    out.roster = memberIds(id).map((m) => ({
      username: usernameOf(m),
      avatar: avatarOf(m),
      online: presence.isOnline(m) && !related.has(m), // blocks always look offline
      inGameName: (ign.get(m, lobby.game) || {}).in_game_name || null,
      isModerator: isModerator(m),
      blocked: mine.has(m),
    }));
    out.discordInvite = lobby.state !== "open" ? lobby.discord_invite : null;
    out.hasDiscordInvite = Boolean(lobby.discord_invite);
    out.messages = messages(id, mine);
  }
  return out;
}

function hasBlockWith(anonId, id) {
  const others = blocks.related(anonId);
  return memberIds(id).some((m) => others.has(m));
}

function isModerator(anonId) {
  const row = db.get().prepare("SELECT is_moderator FROM accounts WHERE anon_id = ?").get(anonId);
  return Boolean(row && row.is_moderator);
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
  // Same wording as a missing lobby, so nobody learns they've been blocked.
  if (hasBlockWith(anonId, id)) throw new ValidationError("You can't join this lobby.");
  // Seats held for people who reserved them count as taken, except your own.
  const held = heldIds(id).filter((h) => h !== anonId);
  if (memberIds(id).length + held.length >= lobby.slots) {
    const until = db.get().prepare("SELECT MIN(held_until) AS t FROM lobby_holds WHERE lobby_id = ? AND held_until > datetime('now')").get(id).t;
    throw Object.assign(new ValidationError("The open spots are held for players who reserved them. Try again when the hold ends."), { heldUntil: until });
  }
  db.get().prepare("INSERT INTO lobby_members (lobby_id, anon_id) VALUES (?, ?)").run(id, anonId);
  db.get().prepare("DELETE FROM lobby_holds WHERE lobby_id = ? AND anon_id = ?").run(id, anonId);
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

const MESSAGE_SQL = `
  SELECT m.id, m.anon_id, p.username, m.body, m.created_at AS createdAt, a.is_moderator
  FROM messages m LEFT JOIN profiles p ON p.anon_id = m.anon_id LEFT JOIN accounts a ON a.anon_id = m.anon_id`;

function toMessage(m) {
  return { id: m.id, username: m.username, body: m.body, createdAt: m.createdAt, isModerator: Boolean(m.is_moderator) };
}

// A lobby's chat, leaving out messages from anyone in `hide` (anon IDs).
function messages(id, hide = new Set()) {
  return db.get().prepare(`${MESSAGE_SQL} WHERE m.lobby_id = ? ORDER BY m.id`).all(id)
    .filter((m) => !hide.has(m.anon_id))
    .map(toMessage);
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
  const hit = chatfilter.check(clean);
  if (hit) {
    // Required here, not at the top: moderation.js requires this file.
    if (hit.queue) require("./moderation").flagMessage(anonId, id, clean, hit.reason);
    throw new ValidationError(hit.category === "contact"
      ? "Not sent: phone numbers and email addresses can't go in lobby chat. Share contact details on Discord instead."
      : "Not sent: this message looks like it breaks the community rules. Moderators will take a look.");
  }
  const { lastInsertRowid } = db.get()
    .prepare("INSERT INTO messages (lobby_id, anon_id, body) VALUES (?, ?, ?)")
    .run(id, anonId, clean);
  return toMessage(db.get().prepare(`${MESSAGE_SQL} WHERE m.id = ?`).get(lastInsertRowid));
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
  create, list, upcoming, reserve, unreserve, holdsFor, cancelScheduled, dropScheduledFor, startDue, detail, join, leave, close, postMessage, deleteOldChats,
  activeLobbyId, isMember, usernameOf, NotFoundError, ForbiddenError, VIBES,
};
