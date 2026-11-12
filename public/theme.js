// Light/dark mode. Dark is the default; a choice is remembered in this
// browser only. Loaded in <head> so the page never flashes the wrong theme.
(function () {
  let theme = "dark";
  try { theme = localStorage.getItem("bp-theme") === "light" ? "light" : "dark"; } catch {}
  document.documentElement.dataset.theme = theme;

  function label(button) {
    button.textContent = document.documentElement.dataset.theme === "dark" ? "Light mode" : "Dark mode";
  }
  document.addEventListener("DOMContentLoaded", () => {
    for (const button of document.querySelectorAll("[data-theme-toggle]")) {
      label(button);
      button.addEventListener("click", () => {
        const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
        document.documentElement.dataset.theme = next;
        try { localStorage.setItem("bp-theme", next); } catch {}
        document.querySelectorAll("[data-theme-toggle]").forEach(label);
        document.dispatchEvent(new Event("themechange"));
      });
    }
  });
})();
