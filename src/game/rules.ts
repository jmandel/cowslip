export const POINTS_BY_DEPTH = [0, 20, 10, 7, 5, 3] as const;

export type Depth = 1 | 2 | 3 | 4 | 5;

export type GameRules = {
  rulesVersion: "word-game-0.4";
  guessersAtThreeOrFour: 2;
  guessersAtFiveToEight: 1;
  maxLetters: 5;
  pointsByDepth: [20, 10, 7, 5, 3];
  finalScoreMode: "best-five";
  fifthLetterBehavior: "guess-or-spoil";
};

export const GAME_RULES: GameRules = {
  rulesVersion: "word-game-0.4",
  guessersAtThreeOrFour: 2,
  guessersAtFiveToEight: 1,
  maxLetters: 5,
  pointsByDepth: [20, 10, 7, 5, 3],
  finalScoreMode: "best-five",
  fifthLetterBehavior: "guess-or-spoil",
};

export function pointsForDepth(correct: boolean, depth: number): number {
  if (!correct || depth < 1 || depth > 5) return 0;
  return POINTS_BY_DEPTH[depth as Depth];
}

export function finalScoreFromPoints(points: number[]): number {
  return [...points]
    .sort((a, b) => b - a)
    .slice(0, 5)
    .reduce((sum, r) => sum + r, 0);
}

export function roundsForPlayerCount(playerCount: number): number {
  if (playerCount < 3 || playerCount > 8) {
    throw new RangeError("The game supports 3-8 players.");
  }
  return playerCount * (playerCount <= 4 ? 2 : 1);
}

export const points = pointsForDepth;
export const finalScore = finalScoreFromPoints;

export function normalizeGuess(value: string, locale = "en-US"): string {
  return value
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[\u2018\u2019\u201A\u201B\u2032]/g, "'")
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2212]/g, "-")
    .toLocaleLowerCase(locale);
}

export function isValidLetter(value: string): boolean {
  return /^\p{Letter}$/u.test(value);
}

export function clampLetter(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  const first = [...trimmed][0] ?? "";
  return isValidLetter(first) ? first.toLocaleUpperCase("en-US") : "";
}
