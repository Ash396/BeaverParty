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
  if (target === "moderation") loadModeration();
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

  avatarChoice = { ...(profile ? profile.avatar : { color: "brown", item: "none" }) };
  renderAvatarPicker();
  document.getElementById("delete-section").hidden = !profile;
  document.getElementById("blocked-section").hidden = !profile;
  if (profile) loadBlocked();
  document.getElementById("delete-error").hidden = true;
  document.getElementById("delete-form").reset();

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
      avatar: avatarChoice,
      games,
    });
    const firstTime = !me.username;
    me.username = profile.username;
    me.invisible = profile.invisible;
    renderMyStatus();
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

let avatarChoice = { color: "brown", item: "none" };

function renderAvatarPicker() {
  document.getElementById("avatar-preview").replaceChildren(beaverSvg(avatarChoice, 96));
  const row = (id, key, values) => document.getElementById(id).replaceChildren(...values.map((value) => {
    const button = el("button", {
      type: "button", className: "choice", title: AVATAR_LABELS[value],
      ariaPressed: String(avatarChoice[key] === value), ariaLabel: AVATAR_LABELS[value],
    }, beaverSvg({ ...avatarChoice, [key]: value }, 40));
    button.addEventListener("click", () => { avatarChoice[key] = value; renderAvatarPicker(); });
    return button;
  }));
  row("avatar-colors", "color", catalog.avatarColors);
  row("avatar-items", "item", catalog.avatarItems);
}

document.getElementById("delete-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!confirm("Delete your BeaverParty account? This can't be undone.")) return;
  try {
    await api("POST", "/api/account/delete", { confirm: event.target.elements.confirm.value });
    location.replace("/");
  } catch (err) { showError("delete-error", err); }
});

// ---- Blocking and reporting ----

async function setBlocked(username, block) {
  await api(block ? "PUT" : "DELETE", `/api/blocks/${encodeURIComponent(username)}`);
}

async function loadBlocked() {
  const { blocked } = await api("GET", "/api/blocks");
  document.getElementById("blocked-empty").hidden = blocked.length > 0;
  document.getElementById("blocked-list").replaceChildren(...blocked.map((username) => {
    const undo = el("button", { type: "button", className: "secondary small-button", textContent: "Unblock" });
    undo.addEventListener("click", async () => { await setBlocked(username, false); loadBlocked(); });
    return el("li", {}, userLink(username), undo);
  }));
}

// Small Report / Block buttons for another player, e.g. in a lobby roster.
function playerActions(username, { lobbyId = null, blocked = false, onChange } = {}) {
  const report = el("button", { type: "button", className: "link-button", textContent: "Report" });
  report.addEventListener("click", () => openReport(username, lobbyId, onChange));
  const block = el("button", { type: "button", className: "link-button", textContent: blocked ? "Unblock" : "Block" });
  block.addEventListener("click", async () => {
    if (!blocked && !confirm(`Block ${username}? They won't be told.`)) return;
    await setBlocked(username, !blocked);
    if (onChange) onChange();
  });
  return el("span", { className: "player-actions" }, report, block);
}

let reportTarget = null;

function openReport(username, lobbyId, onDone) {
  reportTarget = { username, lobbyId, onDone };
  const form = document.getElementById("report-form");
  form.reset();
  const reasons = form.elements.reason;
  if (reasons.options.length === 1) for (const r of catalog.reportReasons) reasons.append(el("option", { value: r, textContent: r }));
  document.getElementById("report-name").textContent = username;
  document.getElementById("report-context").textContent = lobbyId
    ? "A copy of this lobby's chat will be saved with the report."
    : "This reports their profile (for example, an offensive username). To report something said in chat, report them from the lobby.";
  showError("report-error", null);
  document.getElementById("report-dialog").showModal();
}

document.getElementById("report-cancel").addEventListener("click", () => document.getElementById("report-dialog").close());

document.getElementById("report-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const f = event.target.elements;
  const { username, lobbyId, onDone } = reportTarget;
  try {
    await api("POST", "/api/reports", { username, lobbyId, reason: f.reason.value, details: f.details.value });
    if (f.alsoBlock.checked) await setBlocked(username, true);
    document.getElementById("report-dialog").close();
    alert("Thanks. A moderator will look at your report.");
    if (onDone) onDone();
  } catch (err) { showError("report-error", err); }
});

// Avatar circles for a lobby's players, plus empty circles for open spots.
function seats(lobby) {
  const row = el("div", { className: "seats", ariaLabel: `${lobby.members.length} of ${lobby.slots} spots taken` });
  for (let i = 0; i < lobby.slots; i++) {
    const seat = el("span", { className: i < lobby.members.length ? "seat filled" : "seat" });
    if (i < lobby.members.length) {
      seat.title = lobby.members[i];
      seat.append(beaverSvg(lobby.avatars[i], 38));
    }
    row.append(seat);
  }
  return row;
}

// ---- Lobbies ----

let myLobbyId = null;
let stream = null;
let streamLobby = undefined;

function userLink(username) {
  return el("a", { href: `#user/${encodeURIComponent(username)}`, textContent: username });
}

// ---- Online status ----

// A dot that live "presence" events keep up to date. Invisible students
// come through as offline, same as if they had the app closed.
function presenceDot(username, online) {
  const dot = el("span", { className: "presence", dataset: { user: username || "" } });
  setDot(dot, online);
  return dot;
}

function setDot(dot, online) {
  dot.classList.toggle("on", online);
  dot.title = online ? "Online" : "Offline";
  dot.setAttribute("role", "img");
  dot.setAttribute("aria-label", dot.title);
}

function onPresence({ username, online }) {
  if (!username) return;
  for (const dot of document.querySelectorAll(`.presence[data-user="${CSS.escape(username)}"]`)) setDot(dot, online);
  const status = document.getElementById("user-status");
  if (status.dataset.user === username) status.textContent = online ? "Online now" : "Offline";
}

function renderMyStatus() {
  const button = document.getElementById("status-toggle");
  button.hidden = !me.username;
  const label = me.invisible ? "Invisible" : "Online";
  button.replaceChildren(el("span", { className: me.invisible ? "presence" : "presence on", ariaHidden: "true" }),
    el("span", { className: "status-label", textContent: label }));
  button.ariaLabel = `Status: ${label}`;
  button.title = me.invisible
    ? "Everyone sees you as offline. Click to show as online."
    : "Others can see you're online. Click to go invisible.";
}

document.getElementById("status-toggle").addEventListener("click", async () => {
  try {
    const { invisible } = await api("PUT", "/api/status", { invisible: !me.invisible });
    me.invisible = invisible;
    renderMyStatus();
  } catch (err) { alert(err.message); }
});

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
  stream.addEventListener("presence", (e) => onPresence(JSON.parse(e.data)));
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
    lobby.members.forEach((m, i) => members.append(i ? ", " : "", presenceDot(m, lobby.online[i]), userLink(m)));
    return el("div", { className: "lobby-card" },
      el("div", {}, el("h3", { textContent: lobby.game }), el("p", { className: "muted", textContent: describe(lobby) }), seats(lobby), members),
      join);
  }));
}

async function renderMyLobby() {
  const { lobby } = await api("GET", `/api/lobbies/${myLobbyId}`);
  document.getElementById("lobby-state").textContent = lobby.state;
  document.getElementById("lobby-title").textContent = lobby.game;
  document.getElementById("lobby-meta").textContent = `Hosted by ${lobby.host} · ${describe(lobby)}`;
  document.getElementById("lobby-seats").replaceWith(Object.assign(seats(lobby), { id: "lobby-seats" }));
  document.getElementById("lobby-roster").replaceChildren(...lobby.roster.map((r) => {
    const li = el("li", {}, beaverSvg(r.avatar, 28), presenceDot(r.username, r.online), userLink(r.username));
    if (r.isModerator) li.append(modBadge());
    if (r.inGameName) li.append(` (in game: ${r.inGameName})`);
    if (r.blocked) li.append(el("span", { className: "muted small", textContent: " blocked, chat hidden" }));
    if (r.username && r.username !== me.username) {
      li.append(playerActions(r.username, { lobbyId: lobby.id, blocked: r.blocked, onChange: renderMyLobby }));
    }
    return li;
  }));
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

function modBadge() {
  return el("span", { className: "badge mod", textContent: "Mod", title: "BeaverParty moderator" });
}

function addMessage(m) {
  const log = document.getElementById("chat-log");
  if (log.querySelector(`[data-id="${m.id}"]`)) return;
  const time = new Date(m.createdAt.replace(" ", "T") + "Z").toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  log.append(el("p", { dataset: { id: m.id } },
    el("span", { className: `who ${playerColor(m.username)}`, textContent: m.username || "(deleted)" }),
    m.isModerator ? modBadge() : "", m.isModerator ? " " : "",
    m.body, el("span", { className: "when", textContent: time })));
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
    saved,
    playerActions(player.username, { lobbyId, onChange: loadRecent }));
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
  document.getElementById("user-avatar").replaceChildren();
  document.getElementById("user-mod").hidden = true;
  document.getElementById("user-actions").hidden = true;
  document.getElementById("user-action-note").hidden = true;
  const status = document.getElementById("user-status");
  status.textContent = "";
  status.dataset.user = "";
  missing.hidden = true;
  try {
    const { profile } = await api("GET", `/api/profiles/${encodeURIComponent(username)}`);
    name.textContent = profile.username;
    document.getElementById("user-mod").hidden = !profile.isModerator;
    const mine = profile.username === me.username;
    document.getElementById("user-actions").hidden = mine;
    const block = document.getElementById("user-block");
    block.textContent = profile.blockedByMe ? "Unblock" : "Block";
    block.onclick = async () => {
      if (!profile.blockedByMe && !confirm(`Block ${profile.username}? They won't be told.`)) return;
      await setBlocked(profile.username, !profile.blockedByMe);
      loadUser(profile.username);
    };
    document.getElementById("user-report").onclick = () => openReport(profile.username, null);
    const note = document.getElementById("user-action-note");
    note.hidden = !profile.blockedByMe;
    note.textContent = "You blocked this player. They aren't told.";
    document.getElementById("user-avatar").replaceChildren(beaverSvg(profile.avatar, 72));
    status.dataset.user = profile.username;
    status.textContent = profile.online ? "Online now" : "Offline";
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

// ---- Moderation (moderators only) ----

function shortDate(sqlTime) {
  if (!sqlTime) return "";
  return new Date(sqlTime.replace(" ", "T") + "Z").toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

async function loadModeration() {
  let data;
  try {
    data = await api("GET", "/api/moderation");
    showError("mod-error", null);
  } catch (err) { return showError("mod-error", err); }
  document.getElementById("mod-count").textContent = data.reports.length;
  document.getElementById("mod-empty").hidden = data.reports.length > 0;
  document.getElementById("mod-reports").replaceChildren(...data.reports.map(reportCard));

  document.getElementById("mod-banned-empty").hidden = data.banned.length > 0;
  document.getElementById("mod-banned").replaceChildren(...data.banned.map((username) => {
    const lift = el("button", { type: "button", className: "secondary small-button", textContent: "Lift ban" });
    lift.addEventListener("click", async () => {
      if (!confirm(`Lift the ban on ${username}? They'll be able to sign in again.`)) return;
      try { await api("POST", "/api/moderation/unban", { username }); loadModeration(); } catch (err) { showError("mod-error", err); }
    });
    return el("li", {}, el("span", { textContent: username }), lift);
  }));

  document.getElementById("mod-history").hidden = data.history.length === 0;
  const head = el("tr", {}, ...["When", "Reason", "Decision", "Moderator"].map((h) => el("th", { textContent: h })));
  document.getElementById("mod-history").replaceChildren(head, ...data.history.map((h) =>
    el("tr", {}, ...[shortDate(h.resolvedAt), h.reason, h.action, h.moderator || "(former moderator)"].map((v) => el("td", { textContent: v })))));
}

function reportCard(r) {
  const f = r.flags;
  const flags = [];
  if (f.openReportsAboutThem > 1) flags.push(`${plural(f.openReportsAboutThem, "student")} reported them`);
  if (f.pastWarnings) flags.push(`warned ${plural(f.pastWarnings, "time")} before`);
  if (f.reporterReportsLast30Days >= 5) flags.push(`this reporter filed ${f.reporterReportsLast30Days} reports in 30 days`);
  if (f.reporterDismissed >= 2) flags.push(`${f.reporterDismissed} of this reporter's past reports were dismissed`);

  const who = r.accountDeleted ? `${r.usernameWhenReported} (account deleted)` : r.username;
  const renamed = !r.accountDeleted && r.usernameWhenReported && r.usernameWhenReported !== r.username
    ? ` (was ${r.usernameWhenReported} when reported)` : "";
  const card = el("div", { className: "lobby-card report-card" },
    el("p", {}, el("span", { className: "badge", textContent: r.reason }), " ", el("span", { className: "muted small", textContent: shortDate(r.createdAt) })),
    el("h3", { textContent: who + renamed }),
    el("p", { className: "small muted", textContent: r.games.map((g) => (g.rank ? `${g.game} (${g.rank})` : g.game)).join(", ") }));
  if (flags.length) card.append(el("p", { className: "small flag", textContent: `Note: ${flags.join("; ")}.` }));
  if (r.details) card.append(el("blockquote", { textContent: r.details }));
  if (r.lobby) {
    card.append(el("p", { className: "small", textContent: `${r.lobby.game} lobby, ${shortDate(r.lobby.createdAt)}` }));
    const log = el("div", { className: "chat-log saved" });
    if (!r.messages.length) log.append(el("p", { className: "muted", textContent: "No chat messages." }));
    for (const m of r.messages) {
      log.append(el("p", { className: m.reported ? "reported" : "" },
        el("span", { className: `who ${m.reported ? "p2" : "p3"}`, textContent: m.who }), m.body,
        el("span", { className: "when", textContent: shortDate(m.createdAt) })));
    }
    card.append(log);
  } else {
    card.append(el("p", { className: "small muted", textContent: "Profile report (no lobby chat)." }));
  }
  const buttons = [
    ["dismiss", "Dismiss", "secondary", null],
    ["warn", "Warn", "secondary", `Warn ${who}? They'll see a notice next time they open BeaverParty.`],
    ["ban", "Ban", "danger", `Ban ${who}? They'll be signed out right away and can't sign in again until a moderator lifts it. This resolves every open report about them.`],
  ].map(([action, label, cls, question]) => {
    const b = el("button", { type: "button", className: cls, textContent: label });
    b.addEventListener("click", async () => {
      if (question && !confirm(question)) return;
      try { await api("POST", `/api/moderation/reports/${r.id}`, { action }); loadModeration(); } catch (err) { showError("mod-error", err); }
    });
    return b;
  });
  card.append(el("p", { className: "actions" }, ...buttons));
  return card;
}

// ---- Warnings ----

function showWarning(warning) {
  const box = document.getElementById("warning");
  box.hidden = !warning;
  if (warning) document.getElementById("warning-text").textContent = `Reason: ${warning.reason}.`;
}

document.getElementById("warning-ok").addEventListener("click", async () => {
  await api("POST", "/api/warnings/seen");
  showWarning(null);
});

// ---- Start ----

fetch("/api/me")
  .then((res) => res.json())
  .then((data) => {
    if (!data.signedIn) return location.replace("/");
    me = data;
    document.getElementById("nav-moderation").hidden = !me.isModerator;
    showWarning(me.warning);
    return api("GET", "/api/catalog").then((c) => {
      catalog = c;
      showPage();
      renderMyStatus();
      if (me.username) connect(); // having the app open on any page is what shows you as online
    });
  })
  .catch(() => location.replace("/"));

window.addEventListener("hashchange", showPage);
