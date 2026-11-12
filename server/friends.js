// Friends. Friending is mutual: you send a request and the other student
// accepts it. Only then can either of you see the other in your friends list
// with their online status (invisible students still show as offline).
// Declining, cancelling, and unfriending all just delete the row, and the
// other person is never told which one happened.
//
// Finding people is by username only: a search needs at least 3 characters
// and returns a handful of usernames that start with it, so there is no
// browsable list of everyone who uses BeaverParty.
const db = require("./db");
const presence = require("./presence");
const { ValidationError, avatarOf } = require("./profiles");

const MAX_PENDING = 20; // outgoing requests waiting at once
const MAX_FRIENDS = 200;
const SEARCH_MIN = 3;
const SEARCH_LIMIT = 8;

function anonIdOf(username) {
  if (typeof username !== "string") return null;
  const row = db.get().prepare("SELECT anon_id FROM profiles WHERE username = ?").get(username.trim());
  return row ? row.anon_id : null;
}

function usernameOf(anonId) {
  const row = db.get().prepare("SELECT username FROM profiles WHERE anon_id = ?").get(anonId);
  return row ? row.username : null;
}

// The row between two students, whichever of them sent it.
function between(a, b) {
  return db.get().prepare(`
    SELECT from_anon_id, to_anon_id, accepted FROM friends
    WHERE (from_anon_id = ? AND to_anon_id = ?) OR (from_anon_id = ? AND to_anon_id = ?)
  `).get(a, b, b, a);
}

// How you relate to someone: "friend", "sent", "received", or "none".
function relation(anonId, otherId) {
  const row = between(anonId, otherId);
  if (!row) return "none";
  if (row.accepted) return "friend";
  return row.from_anon_id === anonId ? "sent" : "received";
}

function requireOther(anonId, username) {
  const otherId = anonIdOf(username);
  if (!otherId) throw new ValidationError("No student with that username.");
  if (otherId === anonId) throw new ValidationError("That's you!");
  return otherId;
}

function count(sql, anonId) {
  return db.get().prepare(sql).get(anonId, anonId).n;
}

// Sends a request, or accepts theirs if they already asked you.
// Returns the other student's anon ID and the new relation.
function request(anonId, username) {
  if (!usernameOf(anonId)) throw new ValidationError("Create your profile first.");
  const otherId = requireOther(anonId, username);
  const now = relation(anonId, otherId);
  if (now === "received") return accept(anonId, username);
  if (now !== "none") return { otherId, relation: now };
  const pending = db.get().prepare("SELECT COUNT(*) AS n FROM friends WHERE from_anon_id = ? AND accepted = 0").get(anonId).n;
  if (pending >= MAX_PENDING) throw new ValidationError("You have too many requests waiting. Cancel some first.");
  db.get().prepare("INSERT INTO friends (from_anon_id, to_anon_id) VALUES (?, ?)").run(anonId, otherId);
  return { otherId, relation: "sent" };
}

function accept(anonId, username) {
  const otherId = requireOther(anonId, username);
  if (relation(anonId, otherId) !== "received") throw new ValidationError("No request from that student.");
  const total = "SELECT COUNT(*) AS n FROM friends WHERE accepted = 1 AND (from_anon_id = ? OR to_anon_id = ?)";
  if (count(total, anonId) >= MAX_FRIENDS) throw new ValidationError(`You can have at most ${MAX_FRIENDS} friends.`);
  db.get().prepare("UPDATE friends SET accepted = 1, accepted_at = datetime('now') WHERE from_anon_id = ? AND to_anon_id = ?")
    .run(otherId, anonId);
  return { otherId, relation: "friend" };
}

// Decline, cancel, or unfriend.
function remove(anonId, username) {
  const otherId = requireOther(anonId, username);
  db.get().prepare(`
    DELETE FROM friends WHERE (from_anon_id = ? AND to_anon_id = ?) OR (from_anon_id = ? AND to_anon_id = ?)
  `).run(anonId, otherId, otherId, anonId);
  return { otherId, relation: "none" };
}

function card(otherId, extra = {}) {
  return { username: usernameOf(otherId), avatar: avatarOf(otherId), ...extra };
}

// Your friends (online first, then A to Z) and requests both ways.
function list(anonId) {
  const rows = db.get().prepare(`
    SELECT from_anon_id, to_anon_id, accepted FROM friends WHERE from_anon_id = ? OR to_anon_id = ?
    ORDER BY created_at DESC
  `).all(anonId, anonId);
  const friends = [], incoming = [], outgoing = [];
  for (const r of rows) {
    const otherId = r.from_anon_id === anonId ? r.to_anon_id : r.from_anon_id;
    if (!usernameOf(otherId)) continue;
    if (r.accepted) friends.push(card(otherId, { online: presence.isOnline(otherId) }));
    else if (r.from_anon_id === anonId) outgoing.push(card(otherId));
    else incoming.push(card(otherId));
  }
  friends.sort((a, b) => (b.online - a.online) || a.username.localeCompare(b.username));
  return { friends, incoming, outgoing };
}

function incomingCount(anonId) {
  return db.get().prepare("SELECT COUNT(*) AS n FROM friends WHERE to_anon_id = ? AND accepted = 0").get(anonId).n;
}

// Usernames starting with what you typed. Shows how you relate to each, but
// online status only for people who are already your friends.
function search(anonId, query) {
  const q = typeof query === "string" ? query.trim() : "";
  if (q.length < SEARCH_MIN) return [];
  if (!/^[A-Za-z0-9_-]+$/.test(q)) return [];
  const rows = db.get().prepare(`
    SELECT anon_id FROM profiles WHERE username LIKE ? ESCAPE '\\' AND anon_id <> ?
    ORDER BY (username = ? COLLATE NOCASE) DESC, length(username), username LIMIT ?
  `).all(`${q.replace(/_/g, "\\_")}%`, anonId, q, SEARCH_LIMIT); // "_" is a LIKE wildcard
  return rows.map((r) => {
    const rel = relation(anonId, r.anon_id);
    return card(r.anon_id, rel === "friend" ? { relation: rel, online: presence.isOnline(r.anon_id) } : { relation: rel });
  });
}

module.exports = { request, accept, remove, list, search, relation, incomingCount, anonIdOf, SEARCH_MIN };
