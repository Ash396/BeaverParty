// App shell: checks sign-in, shows the page named after # in the URL, and
// highlights it in the sidebar. New users must create a profile first.
const PAGES = ["lobbies", "profile", "heatmap", "moderation", "user"];
let me = { isModerator: false, username: null };
let catalog = null;

async function api(method, path, body) {
  // Changes are always sent as JSON; the server rejects anything else.
  const send = method !== "GET";
  const res = await fetch(path, {
    method,
    headers: send ? { "Content-Type": "application/json" } : {},
    body: send ? JSON.stringify(body || {}) : undefined,
  });
  if (res.status === 401) location.replace("/");
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Something went wrong.");
  return data;
}

function el(tag, props = {}, ...children) {
  const { dataset, ...rest } = props;
  const node = Object.assign(document.createElement(tag), rest);
  if (dataset) Object.assign(node.dataset, dataset);
  node.append(...children);
  return node;
}

function showPage() {
  const [page, arg] = location.hash.slice(1).split("/");
  let target = PAGES.includes(page) ? page : "lobbies";
  if (target === "moderation" && !me.isModerator) target = "lobbies";
  if (!me.username) target = "profile"; // finish setup first
  for (const node of document.querySelectorAll("[data-page]")) node.hidden = node.dataset.page !== target;
  for (const link of document.querySelectorAll(".sidebar nav a")) {
    if (link.getAttribute("href") === `#${target}`) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
  if (target === "lobbies") loadLobbies();
  if (target === "profile") loadProfile();
  if (target === "user") loadUser(decodeURIComponent(arg || ""));
}

// ---- My profile ----

async function loadProfile() {
  if (!catalog) catalog = await api("GET", "/api/catalog");
  const { profile } = await api("GET", "/api/profile");
  const form = document.getElementById("profile-form");
  document.getElementById("setup-note").hidden = Boolean(profile);
  document.getElementById("profile-error").hidden = true;
  document.getElementById("profile-saved").hidden = true;

  const dorm = form.elements.dorm;
  if (dorm.options.length === 1) for (const d of catalog.dorms) dorm.append(el("option", { value: d, textContent: d }));

  const mine = new Map((profile ? profile.games : []).map((g) => [g.game, g]));
  const list = document.getElementById("game-list");
  list.replaceChildren(...catalog.games.map((game) => {
    const g = mine.get(game) || {};
    const check = el("input", { type: "checkbox", checked: mine.has(game), value: game });
    const rank = el("input", { type: "text", placeholder: "Rank", maxLength: 30, value: g.rank || "" });
    const ign = el("input", { type: "text", placeholder: "In-game name", maxLength: 40, value: g.inGameName || "" });
    const sync = () => { rank.hidden = ign.hidden = !check.checked; };
    check.addEventListener("change", sync);
    sync();
    return el("div", { className: "game-row" }, el("label", {}, check, game), rank, ign);
  }));

  form.elements.username.value = profile ? profile.username : "";
  form.elements.realName.value = (profile && profile.realName) || "";
  dorm.value = (profile && profile.dorm) || "";
  const preview = document.getElementById("preview-link");
  preview.hidden = !profile;
  if (profile) preview.querySelector("a").href = `#user/${encodeURIComponent(profile.username)}`;
}

document.getElementById("profile-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.target;
  const games = [...document.querySelectorAll("#game-list .game-row")]
    .map((row) => {
      const [check, rank, ign] = row.querySelectorAll("input");
      return check.checked ? { game: check.value, rank: rank.value, inGameName: ign.value } : null;
    })
    .filter(Boolean);
  const error = document.getElementById("profile-error");
  try {
    const { profile } = await api("PUT", "/api/profile", {
      username: form.elements.username.value,
      realName: form.elements.realName.value,
      dorm: form.elements.dorm.value,
      games,
    });
    const firstTime = !me.username;
    me.username = profile.username;
    error.hidden = true;
    if (firstTime) {
      history.replaceState(null, "", "#lobbies");
      return showPage();
    }
    document.getElementById("profile-saved").hidden = false;
    loadProfile();
  } catch (err) {
    error.textContent = err.message;
    error.hidden = false;
  }
});

// ---- Lobbies ----

let myLobbyId = null;
let stream = null;
let streamLobby = undefined;

function userLink(username) {
  return el("a", { href: `#user/${encodeURIComponent(username)}`, textContent: username });
}

function showError(id, err) {
  const node = document.getElementById(id);
  node.textContent = err ? err.message : "";
  node.hidden = !err;
}

// One live connection: the lobby list, plus your lobby's chat if you're in one.
function connect() {
  if (stream && streamLobby === myLobbyId) return;
  if (stream) stream.close();
  streamLobby = myLobbyId;
  stream = new EventSource(myLobbyId ? `/api/events?lobby=${myLobbyId}` : "/api/events");
  stream.addEventListener("changed", () => loadLobbies());
  stream.addEventListener("message", (e) => addMessage(JSON.parse(e.data)));
}

async function loadLobbies() {
  if (!me.username || document.querySelector('[data-page="lobbies"]').hidden) return;
  if (!catalog) catalog = await api("GET", "/api/catalog");
  fillGameSelects();
  const filters = new URLSearchParams(new FormData(document.getElementById("filter-form")));
  for (const [k, v] of [...filters]) if (!v) filters.delete(k);
  const data = await api("GET", `/api/lobbies?${filters}`);
  myLobbyId = data.myLobbyId;
  document.getElementById("my-lobby").hidden = !myLobbyId;
  document.getElementById("browse-lobbies").hidden = Boolean(myLobbyId);
  if (myLobbyId) await renderMyLobby();
  else {
    renderList(data.lobbies);
    await loadRecent();
  }
  connect();
}

function fillGameSelects() {
  const create = document.querySelector("#create-form select[name=game]");
  if (create.options.length) return;
  for (const g of [...catalog.games, "Other"]) create.append(el("option", { value: g, textContent: g }));
  const filter = document.querySelector("#filter-form select[name=game]");
  for (const g of catalog.games) filter.append(el("option", { value: g, textContent: g }));
}

function describe(lobby) {
  const bits = [`${lobby.members.length}/${lobby.slots} players`, lobby.vibe, lobby.voice ? "voice on" : "no voice"];
  if (lobby.rank) bits.push(`rank: ${lobby.rank}`);
  return bits.join(" · ");
}

function renderList(list) {
  document.getElementById("lobby-empty").hidden = list.length > 0;
  document.getElementById("lobby-list").replaceChildren(...list.map((lobby) => {
    const join = el("button", { type: "button", textContent: "Join" });
    join.addEventListener("click", async () => {
      try {
        await api("POST", `/api/lobbies/${lobby.id}/join`);
        showError("join-error", null);
        loadLobbies();
      } catch (err) { showError("join-error", err); }
    });
    const members = el("p", { className: "small" }, "Players: ");
    lobby.members.forEach((m, i) => members.append(i ? ", " : "", userLink(m)));
    return el("div", { className: "lobby-card" },
      el("div", {}, el("h3", { textContent: lobby.game }), el("p", { className: "muted", textContent: describe(lobby) }), members),
      join);
  }));
}

async function renderMyLobby() {
  const { lobby } = await api("GET", `/api/lobbies/${myLobbyId}`);
  document.getElementById("lobby-state").textContent = lobby.state;
  document.getElementById("lobby-title").textContent = lobby.game;
  document.getElementById("lobby-meta").textContent = `Hosted by ${lobby.host} · ${describe(lobby)}`;
  document.getElementById("lobby-roster").replaceChildren(...lobby.roster.map((r) =>
    el("li", {}, userLink(r.username), r.inGameName ? ` (in game: ${r.inGameName})` : "")));
  const discord = document.getElementById("lobby-discord");
  if (lobby.discordInvite) {
    discord.replaceChildren("Discord: ", el("a", { href: lobby.discordInvite, textContent: lobby.discordInvite, target: "_blank", rel: "noopener noreferrer" }));
  } else {
    discord.replaceChildren(el("span", { className: "muted", textContent:
      lobby.hasDiscordInvite ? "The Discord invite will appear here once the lobby fills." : "No Discord invite for this lobby." }));
  }
  document.getElementById("close-lobby").hidden = !lobby.isHost;
  document.getElementById("leave-lobby").textContent = lobby.isHost ? "Leave (closes the lobby)" : "Leave lobby";
  const log = document.getElementById("chat-log");
  log.replaceChildren();
  lobby.messages.forEach(addMessage);
}

// Each username always gets the same palette color in chat.
function playerColor(username) {
  let h = 2166136261; // FNV-1a, then mixed so similar names spread out
  for (const c of username || "") { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); }
  h ^= h >>> 16; h = Math.imul(h, 0x45d9f3b); h ^= h >>> 16;
  return `p${(h >>> 0) % 4}`;
}

function addMessage(m) {
  const log = document.getElementById("chat-log");
  if (log.querySelector(`[data-id="${m.id}"]`)) return;
  const time = new Date(m.createdAt.replace(" ", "T") + "Z").toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  log.append(el("p", { dataset: { id: m.id } },
    el("span", { className: `who ${playerColor(m.username)}`, textContent: m.username || "(deleted)" }), m.body, el("span", { className: "when", textContent: time })));
  log.scrollTop = log.scrollHeight;
}
document.getElementById("chat-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = event.target.elements.body;
  if (!input.value.trim()) return;
  try {
    const { message } = await api("POST", `/api/lobbies/${myLobbyId}/messages`, { body: input.value });
    input.value = "";
    addMessage(message);
    showError("lobby-error", null);
  } catch (err) { showError("lobby-error", err); }
});

for (const action of ["leave", "close"]) {
  document.getElementById(`${action}-lobby`).addEventListener("click", async () => {
    if (action === "close" && !confirm("Close this lobby for everyone?")) return;
    try {
      await api("POST", `/api/lobbies/${myLobbyId}/${action}`);
      loadLobbies();
    } catch (err) { showError("lobby-error", err); }
  });
}

document.querySelector("#create-form select[name=game]").addEventListener("change", (e) => {
  document.getElementById("other-game").hidden = e.target.value !== "Other";
});

document.getElementById("create-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const f = event.target.elements;
  try {
    await api("POST", "/api/lobbies", {
      game: f.game.value, otherGame: f.otherGame.value, slots: Number(f.slots.value), vibe: f.vibe.value,
      rank: f.rank.value, voice: f.voice.checked, discordInvite: f.discordInvite.value,
    });
    event.target.reset();
    document.getElementById("create-box").open = false;
    showError("create-error", null);
    loadLobbies();
  } catch (err) { showError("create-error", err); }
});

document.getElementById("filter-form").addEventListener("change", () => loadLobbies());

// ---- Endorsements for recently closed lobbies ----

async function loadRecent() {
  const { badges, lobbies } = await api("GET", "/api/endorsements");
  document.getElementById("recent-games").hidden = lobbies.length === 0;
  document.getElementById("recent-list").replaceChildren(...lobbies.map((lobby) => {
    const closed = new Date(lobby.closedAt.replace(" ", "T") + "Z").toLocaleDateString([], { month: "short", day: "numeric" });
    return el("div", { className: "lobby-card endorse-card" },
      el("h3", { textContent: `${lobby.game} · ${closed}` }),
      ...lobby.players.map((player) => endorseRow(lobby.id, player, badges)));
  }));
}

function endorseRow(lobbyId, player, badges) {
  const boxes = badges.map((badge) => el("input", { type: "checkbox", value: badge, checked: player.given.includes(badge) }));
  const saved = el("span", { className: "muted small", textContent: "Saved", hidden: true });
  const row = el("div", { className: "endorse-row" },
    userLink(player.username),
    ...boxes.map((box) => el("label", {}, box, box.value)),
    saved);
  row.addEventListener("change", async () => {
    try {
      await api("PUT", `/api/lobbies/${lobbyId}/endorsements`, {
        username: player.username,
        badges: boxes.filter((b) => b.checked).map((b) => b.value),
      });
      saved.hidden = false;
      showError("endorse-error", null);
    } catch (err) { showError("endorse-error", err); }
  });
  return row;
}

// ---- Someone's public profile ----

async function loadUser(username) {
  const name = document.getElementById("user-name");
  const details = document.getElementById("user-details");
  const missing = document.getElementById("user-missing");
  name.textContent = username;
  details.replaceChildren();
  missing.hidden = true;
  try {
    const { profile } = await api("GET", `/api/profiles/${encodeURIComponent(username)}`);
    name.textContent = profile.username;
    const rows = [["Games", profile.games.map((g) => (g.rank ? `${g.game} (${g.rank})` : g.game)).join(", ")]];
    const earned = (profile.badges || []).filter((b) => b.count > 0);
    rows.push(["Badges", earned.length ? earned.map((b) => `${b.badge} × ${b.count}`).join(", ") : "None yet"]);
    if (profile.realName) rows.push(["Real name", profile.realName]);
    if (profile.dorm) rows.push(["Dorm", profile.dorm]);
    for (const [k, v] of rows) details.append(el("dt", { textContent: k }), el("dd", { textContent: v }));
  } catch {
    missing.hidden = false;
  }
}

// ---- Start ----

fetch("/api/me")
  .then((res) => res.json())
  .then((data) => {
    if (!data.signedIn) return location.replace("/");
    me = data;
    document.getElementById("nav-moderation").hidden = !me.isModerator;
    showPage();
  })
  .catch(() => location.replace("/"));

window.addEventListener("hashchange", showPage);
