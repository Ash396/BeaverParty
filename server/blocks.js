// Blocking. The blocked student is never told. A block, in either direction,
// keeps the two students apart:
//   - neither sees lobbies the other is in, and neither can join them
//   - neither can endorse the other
// And the student who blocked someone no longer sees that person's chat
// messages, even in a lobby they were already sharing.
// Blocking doesn't hide public profiles (any student can see those) and has
// no effect on reports or moderation.
const db = require("./db");
const { ValidationError } = require("./profiles");

const MAX_BLOCKS = 500;

function anonIdOf(username) {
  if (typeof username !== "string") return null;
  const row = db.get().prepare("SELECT anon_id FROM profiles WHERE username = ?").get(username.trim());
  return row ? row.anon_id : null;
}

function block(anonId, username) {
  const target = anonIdOf(username);
  if (!target) throw new ValidationError("No student with that username.");
  if (target === anonId) throw new ValidationError("You can't block yourself.");
  const conn = db.get();
  const { n } = conn.prepare("SELECT COUNT(*) AS n FROM blocks WHERE blocker_anon_id = ?").get(anonId);
  if (n >= MAX_BLOCKS) throw new ValidationError("You've blocked too many students.");
  conn.prepare("INSERT INTO blocks (blocker_anon_id, blocked_anon_id) VALUES (?, ?) ON CONFLICT DO NOTHING")
    .run(anonId, target);
}

function unblock(anonId, username) {
  const target = anonIdOf(username);
  if (target) db.get().prepare("DELETE FROM blocks WHERE blocker_anon_id = ? AND blocked_anon_id = ?").run(anonId, target);
}

// Usernames you've blocked, A-Z.
function list(anonId) {
  return db.get().prepare(`
    SELECT p.username FROM blocks b JOIN profiles p ON p.anon_id = b.blocked_anon_id
    WHERE b.blocker_anon_id = ? ORDER BY p.username
  `).all(anonId).map((r) => r.username);
}

// Anon IDs you blocked.
function blockedBy(anonId) {
  return new Set(db.get().prepare("SELECT blocked_anon_id AS id FROM blocks WHERE blocker_anon_id = ?")
    .all(anonId).map((r) => r.id));
}

// Anon IDs who blocked you.
function blockers(anonId) {
  return new Set(db.get().prepare("SELECT blocker_anon_id AS id FROM blocks WHERE blocked_anon_id = ?")
    .all(anonId).map((r) => r.id));
}

// Everyone you have a block with, in either direction.
function related(anonId) {
  return new Set([...blockedBy(anonId), ...blockers(anonId)]);
}

function between(a, b) {
  return Boolean(db.get().prepare(`
    SELECT 1 FROM blocks WHERE (blocker_anon_id = ? AND blocked_anon_id = ?) OR (blocker_anon_id = ? AND blocked_anon_id = ?)
  `).get(a, b, b, a));
}

module.exports = { block, unblock, list, blockedBy, blockers, related, between };
