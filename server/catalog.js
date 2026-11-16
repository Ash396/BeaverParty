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

// Majors: a student can pick up to two (double majors), each either a
// whole department ("Course 6") or one of its programs ("6-3"). Fixed codes,
// not free text. Picking a program shrinks the group of students who share
// it, which the profile's privacy note warns about.
const DEPARTMENTS = [
  { code: "1", name: "Civil and Environmental Eng.", programs: [["1-ENG", "Civil and Environmental Eng."], ["1-12", "Climate System Science and Eng."]] },
  { code: "2", name: "Mechanical Eng.", programs: [["2", "Mechanical Eng."], ["2-A", "Eng. (flexible)"], ["2-OE", "Mechanical and Ocean Eng."]] },
  { code: "3", name: "Materials Science and Eng.", programs: [["3", "Materials Science and Eng."], ["3-A", "Materials Science and Eng. (flexible)"], ["3-C", "Archaeology and Materials"]] },
  { code: "4", name: "Architecture", programs: [["4", "Architecture"], ["4-B", "Art and Design"]] },
  { code: "5", name: "Chemistry", programs: [["5", "Chemistry"], ["5-7", "Chemistry and Biology"]] },
  { code: "6", name: "EECS", programs: [
    ["6-1", "Electrical Science and Eng."], ["6-2", "Electrical Eng. and Computer Science"],
    ["6-3", "Computer Science and Eng."], ["6-4", "AI and Decision Making"],
    ["6-5", "Electrical Eng. with Computing"], ["6-7", "Computer Science and Molecular Biology"],
    ["6-9", "Computation and Cognition"], ["6-14", "Computer Science, Economics, and Data Science"],
  ] },
  { code: "7", name: "Biology", programs: [] },
  { code: "8", name: "Physics", programs: [] },
  { code: "9", name: "Brain and Cognitive Sciences", programs: [] },
  { code: "10", name: "Chemical Eng.", programs: [["10", "Chemical Eng."], ["10-B", "Chemical-Biological Eng."], ["10-C", "Chemical Eng. (flexible)"], ["10-ENG", "Eng. (flexible)"]] },
  { code: "11", name: "Urban Studies and Planning", programs: [["11", "Planning"], ["11-6", "Urban Science and Planning with CS"]] },
  { code: "12", name: "EAPS", programs: [] },
  { code: "14", name: "Economics", programs: [["14-1", "Economics"], ["14-2", "Mathematical Economics"]] },
  { code: "15", name: "Management", programs: [["15-1", "Management"], ["15-2", "Business Analytics"], ["15-3", "Finance"]] },
  { code: "16", name: "Aero/Astro", programs: [["16", "Aerospace Eng."], ["16-ENG", "Eng. (flexible)"]] },
  { code: "17", name: "Political Science", programs: [] },
  { code: "18", name: "Mathematics", programs: [["18", "Mathematics"], ["18-C", "Mathematics with Computer Science"]] },
  { code: "20", name: "Biological Eng.", programs: [] },
  { code: "21", name: "Humanities", programs: [["21A", "Anthropology"], ["21G", "Global Languages"], ["21H", "History"], ["21L", "Literature"], ["21M", "Music and Theater Arts"], ["21W", "Writing"]] },
  { code: "22", name: "Nuclear Science and Eng.", programs: [] },
  { code: "24", name: "Linguistics and Philosophy", programs: [["24-1", "Philosophy"], ["24-2", "Linguistics and Philosophy"]] },
];
const MAJOR_EXTRAS = ["Other or interdisciplinary", "Undeclared"];
const MAX_MAJORS = 2;

// Every code a student can pick -> its department code (null for extras).
// A program code can equal its department's (like "2"); both mean Course 2.
const MAJORS = new Map();
for (const d of DEPARTMENTS) {
  MAJORS.set(d.code, d.code);
  for (const [code] of d.programs) MAJORS.set(code, d.code);
}
for (const x of MAJOR_EXTRAS) MAJORS.set(x, null);

module.exports = { GAMES, DORMS, MAJORS, DEPARTMENTS, MAJOR_EXTRAS, MAX_MAJORS, AVATAR_COLORS, AVATAR_ITEMS };
