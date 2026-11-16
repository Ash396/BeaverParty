// Chat text filter. Every lobby message is checked before it's saved:
//   - slurs (chatfilter-words.txt) and telling someone to kill themselves
//     are blocked and sent to the moderation queue, the same queue as
//     student reports;
//   - phone numbers and email addresses are blocked but not queued, since
//     the sender is usually sharing their own, and queuing would show it to
//     moderators. The sender is told to use Discord instead.
// The blocked message is never shown to anyone in the lobby.
const fs = require("node:fs");
const path = require("node:path");

const LEET = { 0: "o", 1: "i", 3: "e", 4: "a", 5: "s", 7: "t", 8: "b", "@": "a", $: "s", "!": "i", "|": "i" };

// Lowercase, strip accents, undo common letter swaps; anything else that
// isn't a letter becomes a space.
function normalize(text) {
  return text.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[0134578@$!|]/g, (c) => LEET[c])
    .replace(/[^a-z]+/g, " ").trim();
}

// Words, with runs of single letters joined, so "n i g" is caught too.
function words(normalized) {
  const out = [];
  let run = "";
  for (const w of normalized.split(" ")) {
    if (w.length === 1) { run += w; continue; }
    if (run) { out.push(run); run = ""; }
    if (w) out.push(w);
  }
  if (run) out.push(run);
  return out;
}

// "nigger" -> /^n+i+g{2,}e+r+(s|z|es)?$/: each letter may be stretched, but a
// doubled letter must stay doubled, so a different real word doesn't match.
function wordPattern(word) {
  const runs = word.match(/(.)\1*/g);
  const body = runs.map((r) => `${r[0]}${r.length > 1 ? `{${r.length},}` : "+"}`).join("");
  return new RegExp(`^${body}(s|z|es)?$`);
}

function loadWords(file) {
  return fs.readFileSync(file, "utf8").split("\n").map((l) => l.trim().toLowerCase())
    .filter((l) => l && !l.startsWith("#")).map(wordPattern);
}

let patterns = loadWords(path.join(__dirname, "chatfilter-words.txt"));

const SELF_HARM = /\b(kys|kill (yo)?(ur|you|your|yo) ?self|neck (ur|your|yo) ?self|hang (ur|your|yo) ?self|unalive (ur|your|yo) ?self)\b/;
const PHONE = /(\+?1[\s.-]?)?\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

const CATEGORIES = {
  hate: { reason: "Chat filter: slur", queue: true },
  selfHarm: { reason: "Chat filter: telling someone to hurt themselves", queue: true },
  contact: { reason: "Chat filter: phone number or email", queue: false },
};

// Returns null if the message is fine, else { category, reason, queue }.
function check(text) {
  if (PHONE.test(text) || EMAIL.test(text)) return { category: "contact", ...CATEGORIES.contact };
  const normalized = normalize(text);
  if (SELF_HARM.test(normalized)) return { category: "selfHarm", ...CATEGORIES.selfHarm };
  if (words(normalized).some((w) => patterns.some((p) => p.test(w)))) return { category: "hate", ...CATEGORIES.hate };
  return null;
}

module.exports = { check, normalize, CATEGORIES, _setWords: (list) => { patterns = list.map(wordPattern); } };
