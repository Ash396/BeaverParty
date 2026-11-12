// App shell: checks sign-in, shows the page named after # in the URL, and
// highlights it in the sidebar. New users must create a profile first.
const PAGES = ["lobbies", "profile", "heatmap", "moderation", "user"];
let me = { isModerator: false, username: null };
let catalog = null;

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) location.replace("/");
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Something went wrong.");
  return data;
}

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
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
