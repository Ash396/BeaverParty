// App shell: checks sign-in, shows the page named after # in the URL, and
// highlights it in the sidebar.
const PAGES = ["lobbies", "profile", "heatmap", "moderation"];
let me = { isModerator: false };

function showPage() {
  let page = location.hash.slice(1);
  if (!PAGES.includes(page) || (page === "moderation" && !me.isModerator)) page = "lobbies";
  for (const el of document.querySelectorAll("[data-page]")) el.hidden = el.dataset.page !== page;
  for (const link of document.querySelectorAll(".sidebar nav a")) {
    if (link.getAttribute("href") === `#${page}`) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
}

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
showPage();
