// Online status. You count as online while you have BeaverParty open: each
// open tab keeps one live-updates connection (see events.js), and we count
// them here. Nothing about it is written to the database, so there is no
// "last seen" history; a restart forgets everyone until they reconnect.
//
// Invisible is a saved setting (profiles.invisible). While it's on, everyone
// else sees you as offline, exactly as if you had the app closed.
const db = require("./db");

// A tab reconnects when you switch lobbies or the network blips, so wait a
// little before announcing that someone went offline.
const options = { graceMs: 15_000 }; // tests shorten this

const connections = new Map(); // anonId -> number of open connections
const offlineTimers = new Map(); // anonId -> pending "went offline" timer
let onChange = () => {};

// Called with (anonId, online) whenever what other people see changes.
function setListener(fn) {
  onChange = fn;
}

function isInvisible(anonId) {
  const row = db.get().prepare("SELECT invisible FROM profiles WHERE anon_id = ?").get(anonId);
  return Boolean(row && row.invisible);
}

function isConnected(anonId) {
  return connections.has(anonId) || offlineTimers.has(anonId);
}

// What other students see.
function isOnline(anonId) {
  return isConnected(anonId) && !isInvisible(anonId);
}

function connected(anonId) {
  const wasConnected = isConnected(anonId);
  clearTimeout(offlineTimers.get(anonId));
  offlineTimers.delete(anonId);
  connections.set(anonId, (connections.get(anonId) || 0) + 1);
  if (!wasConnected && !isInvisible(anonId)) onChange(anonId, true);
}

function disconnected(anonId) {
  const left = (connections.get(anonId) || 1) - 1;
  if (left > 0) return connections.set(anonId, left);
  connections.delete(anonId);
  const timer = setTimeout(() => {
    offlineTimers.delete(anonId);
    if (!isConnected(anonId) && !isInvisible(anonId)) onChange(anonId, false);
  }, options.graceMs);
  timer.unref();
  offlineTimers.set(anonId, timer);
}

// Saves the setting and tells others if you appear or disappear.
function setInvisible(anonId, invisible) {
  const before = isOnline(anonId);
  db.get().prepare("UPDATE profiles SET invisible = ? WHERE anon_id = ?").run(invisible ? 1 : 0, anonId);
  const after = isOnline(anonId);
  if (before !== after) onChange(anonId, after);
}

// Forget someone at once, e.g. after they delete their account.
function forget(anonId) {
  clearTimeout(offlineTimers.get(anonId));
  offlineTimers.delete(anonId);
  connections.delete(anonId);
}

function reset() {
  for (const t of offlineTimers.values()) clearTimeout(t);
  offlineTimers.clear();
  connections.clear();
}

module.exports = { connected, disconnected, isOnline, isInvisible, setInvisible, setListener, forget, reset, options };
