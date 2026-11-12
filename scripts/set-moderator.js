// Makes someone a moderator (or removes them with --remove).
// Usage: npm run set-moderator -- someone@mit.edu [--remove]
// The email is only used to compute the anonymous ID; it isn't stored.
const { loadConfig } = require("../server/config");
const { anonIdFor } = require("../server/auth");
const db = require("../server/db");
const accounts = require("../server/accounts");

const email = (process.argv[2] || "").trim().toLowerCase();
const remove = process.argv.includes("--remove");
if (!email.includes("@")) {
  console.error("Usage: npm run set-moderator -- someone@mit.edu [--remove]");
  process.exit(1);
}
const config = loadConfig();
if (!config.anonIdKey) {
  console.error("ANON_ID_KEY is not set. Use the same value as the running server.");
  process.exit(1);
}
db.open(config.dbPath);
accounts.setModerator(anonIdFor(config, email), !remove);
console.log(remove ? "Removed moderator." : "Added moderator.");
