// Accounts keyed only by anonymous ID. No kerb, email, or name is stored.
const db = require("./db");

function toAccount(row) {
  if (!row) return undefined;
  return {
    anonId: row.anon_id,
    createdAt: row.created_at,
    banned: Boolean(row.banned),
    isModerator: Boolean(row.is_moderator),
  };
}

function find(anonId) {
  return toAccount(db.get().prepare("SELECT * FROM accounts WHERE anon_id = ?").get(anonId));
}

function findOrCreate(anonId) {
  db.get().prepare("INSERT INTO accounts (anon_id) VALUES (?) ON CONFLICT DO NOTHING").run(anonId);
  return find(anonId);
}

function setBanned(anonId, banned) {
  findOrCreate(anonId);
  db.get().prepare("UPDATE accounts SET banned = ? WHERE anon_id = ?").run(banned ? 1 : 0, anonId);
}

function setModerator(anonId, isModerator) {
  findOrCreate(anonId);
  db.get().prepare("UPDATE accounts SET is_moderator = ? WHERE anon_id = ?").run(isModerator ? 1 : 0, anonId);
}

module.exports = { find, findOrCreate, setBanned, setModerator };
