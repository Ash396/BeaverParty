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

module.exports = { GAMES, DORMS, AVATAR_COLORS, AVATAR_ITEMS };
