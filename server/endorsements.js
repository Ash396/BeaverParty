// Endorsements: after a lobby closes, the students who were still in it can
// give each other badges for a few days. Profiles show, for each badge, how
// many different students have given it, so playing many lobbies with the
// same friend doesn't inflate the count. Who gave a badge is never shown.
const db = require("./db");
const { ValidationError } = require("./profiles");
const { NotFoundError, ForbiddenError } = require("./lobbies");
const blocks = require("./blocks");

const BADGES = ["Good teammate", "Good comms", "Chill vibes"];
const WINDOW_DAYS = 7;

function anonIdOf(username) {
  const row = db.get().prepare("SELECT anon_id FROM profiles WHERE username = ?").get(username);
  return row ? row.anon_id : null;
}

// Closed lobbies you were in that you can still endorse from, newest first,
// with the other players and the badges you've already given each of them.
function pending(anonId) {
  const conn = db.get();
  const lobbies = conn.prepare(`
    SELECT l.id, l.game, l.closed_at AS closedAt FROM lobbies l
    JOIN lobby_members m ON m.lobby_id = l.id AND m.anon_id = ?
    WHERE l.state = 'closed' AND l.closed_at > datetime('now', ?)
    ORDER BY l.closed_at DESC, l.id DESC LIMIT 20
  `).all(anonId, `-${WINDOW_DAYS} days`);
  const players = conn.prepare(`
    SELECT m.anon_id, p.username FROM lobby_members m JOIN profiles p ON p.anon_id = m.anon_id
    WHERE m.lobby_id = ? AND m.anon_id <> ? ORDER BY m.joined_at, m.rowid
  `);
  const given = conn.prepare(`
    SELECT badge FROM endorsements WHERE from_anon_id = ? AND to_anon_id = ? AND lobby_id = ?
  `);
  const hidden = blocks.related(anonId);
  return lobbies
    .map((l) => ({
      id: l.id,
      game: l.game,
      closedAt: l.closedAt,
      players: players.all(l.id, anonId).filter((p) => !hidden.has(p.anon_id)).map((p) => ({
        username: p.username,
        given: given.all(anonId, p.anon_id, l.id).map((g) => g.badge),
      })),
    }))
    .filter((l) => l.players.length > 0);
}

// Replaces the badges you give `username` for this lobby with `badges`
// (an empty list takes them all back).
function set(anonId, lobbyId, username, badges) {
  if (!Array.isArray(badges) || badges.some((b) => !BADGES.includes(b))) {
    throw new ValidationError(`Badges must be from: ${BADGES.join(", ")}.`);
  }
  const conn = db.get();
  const lobby = conn.prepare("SELECT state, closed_at FROM lobbies WHERE id = ?").get(lobbyId);
  if (!lobby) throw new NotFoundError("No such lobby.");
  const toId = typeof username === "string" ? anonIdOf(username) : null;
  const member = conn.prepare("SELECT 1 FROM lobby_members WHERE lobby_id = ? AND anon_id = ?");
  if (!member.get(lobbyId, anonId)) throw new ForbiddenError("You weren't in this lobby.");
  if (!toId || !member.get(lobbyId, toId)) throw new ValidationError("That student wasn't in this lobby.");
  if (toId === anonId) throw new ValidationError("You can't endorse yourself.");
  if (blocks.between(anonId, toId)) throw new ValidationError("You can't endorse this student.");
  if (lobby.state !== "closed") throw new ValidationError("You can endorse players once the lobby closes.");
  const open = conn.prepare("SELECT ? > datetime('now', ?) AS ok").get(lobby.closed_at, `-${WINDOW_DAYS} days`);
  if (!open.ok) throw new ValidationError(`Endorsements close ${WINDOW_DAYS} days after the lobby.`);

  conn.exec("BEGIN");
  try {
    conn.prepare("DELETE FROM endorsements WHERE from_anon_id = ? AND to_anon_id = ? AND lobby_id = ?")
      .run(anonId, toId, lobbyId);
    const add = conn.prepare("INSERT INTO endorsements (from_anon_id, to_anon_id, lobby_id, badge) VALUES (?, ?, ?, ?)");
    for (const badge of new Set(badges)) add.run(anonId, toId, lobbyId, badge);
    conn.exec("COMMIT");
  } catch (err) {
    conn.exec("ROLLBACK");
    throw err;
  }
  return [...new Set(badges)];
}

// For a profile: each badge with the number of different students who gave it.
function counts(username) {
  const anonId = anonIdOf(username);
  const rows = db.get().prepare(`
    SELECT badge, COUNT(DISTINCT from_anon_id) AS n FROM endorsements WHERE to_anon_id = ? GROUP BY badge
  `).all(anonId);
  const byBadge = new Map(rows.map((r) => [r.badge, Number(r.n)]));
  return BADGES.map((badge) => ({ badge, count: byBadge.get(badge) || 0 }));
}

module.exports = { BADGES, WINDOW_DAYS, pending, set, counts };
