// Accounts keyed only by anonymous ID. No kerb, email, or name is stored.
// For now this lives in memory and resets when the server restarts; it will
// move to the database once we pick one.
const accounts = new Map();

function findOrCreate(anonId) {
  let account = accounts.get(anonId);
  if (!account) {
    account = { anonId, createdAt: new Date().toISOString(), banned: false };
    accounts.set(anonId, account);
  }
  return account;
}

function find(anonId) {
  return accounts.get(anonId);
}

function setBanned(anonId, banned) {
  findOrCreate(anonId).banned = banned;
}

module.exports = { findOrCreate, find, setBanned };
