// Fixed choices for profiles. Using fixed lists (not free text) keeps lobby
// filters working and lets us count how many students share each value for
// the re-identification analysis.

// Games named by 3+ of 55 survey responses (see the survey counts).
// Rare games are left off profiles on purpose: a game only one student
// plays would identify them. Lobbies can still name any game.
const GAMES = [
  "Minecraft",
  "Roblox",
  "League of Legends",
  "Super Smash Bros. Ultimate",
  "Fortnite",
  "Mario Kart",
  "Overcooked",
  "Tetris",
  "Valorant",
  "Overwatch 2",
  "Peak",
  "R.E.P.O.",
  "Stardew Valley",
  "Ultimate Chicken Horse",
];

const DORMS = [
  "Baker",
  "Burton Conner",
  "East Campus",
  "MacGregor",
  "Maseeh",
  "McCormick",
  "New House",
  "New Vassar",
  "Next House",
  "Random",
  "Simmons",
  "Graduate housing",
  "FSILG",
  "Off campus",
];

// Pixel beaver avatars: a fur color and an accessory. Picked from fixed
// lists (no uploads), so avatars can't identify anyone and need no moderation.
// public/avatar.js draws them.
const AVATAR_COLORS = ["brown", "tomato", "gold", "mint", "sapphire", "grey"];
const AVATAR_ITEMS = ["none", "headset", "cap", "glasses", "crown", "bow"];

// Majors by department ("Course"), not sub-major: 6-3 vs 6-4 or a small
// joint major would shrink the group of students who share it. Grad
// students pick their department too.
const MAJORS = [
  "Course 1 (Civil and Environmental Eng.)",
  "Course 2 (Mechanical Eng.)",
  "Course 3 (Materials Science and Eng.)",
  "Course 4 (Architecture)",
  "Course 5 (Chemistry)",
  "Course 6 (EECS)",
  "Course 7 (Biology)",
  "Course 8 (Physics)",
  "Course 9 (Brain and Cognitive Sciences)",
  "Course 10 (Chemical Eng.)",
  "Course 11 (Urban Studies and Planning)",
  "Course 12 (EAPS)",
  "Course 14 (Economics)",
  "Course 15 (Management)",
  "Course 16 (Aero/Astro)",
  "Course 17 (Political Science)",
  "Course 18 (Mathematics)",
  "Course 20 (Biological Eng.)",
  "Course 21 (Humanities)",
  "Course 22 (Nuclear Science and Eng.)",
  "Course 24 (Linguistics and Philosophy)",
  "Other or interdisciplinary",
  "Undeclared",
];

module.exports = { GAMES, DORMS, MAJORS, AVATAR_COLORS, AVATAR_ITEMS };
