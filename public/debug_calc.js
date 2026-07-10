const rGamesStr = JSON.stringify([
  "#3301 COOKIE - 4 guesses",
  "#3300 SUGARS - 3 guesses",
  "#3299 UNIQUE - 3 guesses"
]);

let calcStreak = 0;
let expectedNext = null;
const rGames = JSON.parse(rGamesStr);
for (let i = 0; i < rGames.length; i++) {
    const game = rGames[i];
    const match = game.match(/^#(\d+) /);
    if (match) {
        const num = parseInt(match[1]);
        if (game.includes("- X guesses")) break;
        if (expectedNext === null) {
            calcStreak = 1;
            expectedNext = num - 1;
        } else if (num === expectedNext) {
            calcStreak++;
            expectedNext = num - 1;
        } else {
            break;
        }
    }
}
console.log("calcStreak:", calcStreak);
