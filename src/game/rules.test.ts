import { describe, expect, test } from "bun:test";
import { finalScoreFromPoints, normalizeGuess, pointsForDepth, roundsForPlayerCount } from "./rules";
import { assignmentsForDepth, rolesForRound, rowCountForPlayers, type PlayerSeat } from "./rotation";

function players(count: number): PlayerSeat[] {
  return Array.from({ length: count }, (_, index) => ({
    userId: `u${index}`,
    seatNumber: index,
    nickname: `Player ${index + 1}`,
  }));
}

describe("scoring", () => {
  test("awards descending points by depth", () => {
    expect([1, 2, 3, 4, 5].map((depth) => pointsForDepth(true, depth))).toEqual([20, 10, 7, 5, 3]);
    expect(pointsForDepth(false, 1)).toBe(0);
    expect(pointsForDepth(true, 0)).toBe(0);
    expect(pointsForDepth(true, 6)).toBe(0);
  });

  test("final score sums the five highest point values", () => {
    expect(finalScoreFromPoints([3, 20, 0, 10, 7, 5, 20])).toBe(62);
    expect(finalScoreFromPoints([20, 10])).toBe(30);
    expect(finalScoreFromPoints([])).toBe(0);
  });

  test("round count follows player-count rules", () => {
    expect(roundsForPlayerCount(3)).toBe(6);
    expect(roundsForPlayerCount(4)).toBe(8);
    expect(roundsForPlayerCount(5)).toBe(5);
    expect(roundsForPlayerCount(8)).toBe(8);
    expect(() => roundsForPlayerCount(2)).toThrow();
  });
});

describe("guess normalization", () => {
  test("normalizes only conservative variants", () => {
    expect(normalizeGuess(" The   Beatles ")).toBe("the beatles");
    expect(normalizeGuess("SPIDER\u2013MAN")).toBe("spider-man");
    expect(normalizeGuess("Cafe\u2019s Menu")).toBe("cafe's menu");
    expect(normalizeGuess("Beatle")).not.toBe(normalizeGuess("The Beatles"));
    expect(normalizeGuess("cafe\u0301")).toBe(normalizeGuess("café"));
  });
});

describe("rotation", () => {
  test("assigns roles from fixed seat order", () => {
    const plan = rolesForRound(players(5), 2);
    expect(plan.guesser.userId).toBe("u1");
    expect(plan.answerWriter.userId).toBe("u2");
    expect(plan.clueGivers.map((clueGiver) => clueGiver.userId)).toEqual(["u2", "u3", "u4", "u0"]);
  });

  test("standard rotations keep one holder per row and no guesser holder", () => {
    for (const count of [4, 5, 6, 7, 8]) {
      const seats = players(count);
      for (let roundNumber = 1; roundNumber <= count; roundNumber += 1) {
        const guesser = rolesForRound(seats, roundNumber).guesser;
        for (let depth = 1; depth <= 5; depth += 1) {
          const assignments = assignmentsForDepth(seats, roundNumber, depth);
          expect(assignments).toHaveLength(rowCountForPlayers(count));
          expect(new Set(assignments.map((row) => row.rowIndex)).size).toBe(rowCountForPlayers(count));
          expect(assignments.some((row) => row.holderUserId === guesser.userId)).toBe(false);
        }
      }
    }
  });

  test("three-player variant gives both clue givers two rows at every depth", () => {
    const seats = players(3);
    for (let roundNumber = 1; roundNumber <= 6; roundNumber += 1) {
      const guesser = rolesForRound(seats, roundNumber).guesser;
      for (let depth = 1; depth <= 5; depth += 1) {
        const assignments = assignmentsForDepth(seats, roundNumber, depth);
        expect(assignments).toHaveLength(4);
        expect(new Set(assignments.map((row) => row.rowIndex)).size).toBe(4);
        expect(assignments.some((row) => row.holderUserId === guesser.userId)).toBe(false);
        const holderCounts = new Map<string, number>();
        for (const row of assignments) {
          holderCounts.set(row.holderUserId, (holderCounts.get(row.holderUserId) ?? 0) + 1);
        }
        expect([...holderCounts.values()].sort()).toEqual([2, 2]);
      }
    }
  });

  test("three-player variant starts rows alternating and swaps all rows on the first rotation", () => {
    const seats = players(3);
    const depthOne = assignmentsForDepth(seats, 1, 1);
    const depthTwo = assignmentsForDepth(seats, 1, 2);
    const depthThree = assignmentsForDepth(seats, 1, 3);
    expect(depthOne.map((row) => row.holderUserId)).toEqual(["u1", "u2", "u1", "u2"]);
    expect(depthTwo.map((row) => row.holderUserId)).toEqual(["u2", "u1", "u2", "u1"]);
    expect(depthThree.map((row) => row.holderUserId)).toEqual(depthOne.map((row) => row.holderUserId));
  });

  test("property: every supported count, round, and depth preserves row handoff invariants", () => {
    for (let count = 3; count <= 8; count += 1) {
      const seats = players(count);
      const rowCount = rowCountForPlayers(count);
      for (let roundNumber = 1; roundNumber <= roundsForPlayerCount(count); roundNumber += 1) {
        const roles = rolesForRound(seats, roundNumber);
        const clueGiverIds = new Set(roles.clueGivers.map((clueGiver) => clueGiver.userId));
        const rowDepthKeys = new Set<string>();
        const signatures = new Map<number, string>();
        const starterByRow = new Map<number, string>();

        expect(clueGiverIds.has(roles.guesser.userId)).toBe(false);
        expect(clueGiverIds.has(roles.answerWriter.userId)).toBe(true);
        expect(roles.clueGivers).toHaveLength(count - 1);

        for (let depth = 1; depth <= 5; depth += 1) {
          const assignments = assignmentsForDepth(seats, roundNumber, depth);
          const rowIndices = assignments.map((row) => row.rowIndex).sort((a, b) => a - b);
          const holderCounts = new Map<string, number>();

          expect(assignments).toHaveLength(rowCount);
          expect(rowIndices).toEqual(Array.from({ length: rowCount }, (_, index) => index));
          expect(assignments.some((row) => row.holderUserId === roles.guesser.userId)).toBe(false);
          expect(assignments.every((row) => clueGiverIds.has(row.holderUserId))).toBe(true);

          for (const assignment of assignments) {
            rowDepthKeys.add(`${assignment.rowIndex}:${depth}`);
            holderCounts.set(assignment.holderUserId, (holderCounts.get(assignment.holderUserId) ?? 0) + 1);
            if (depth === 1) starterByRow.set(assignment.rowIndex, assignment.holderUserId);
            else if (count > 3) expect(assignment.holderUserId).not.toBe(starterByRow.get(assignment.rowIndex));
          }

          if (count === 3) {
            expect([...holderCounts.values()].sort()).toEqual([2, 2]);
          } else {
            expect([...holderCounts.values()].sort()).toEqual(Array.from({ length: count - 1 }, () => 1));
          }

          signatures.set(depth, assignmentSignature(assignments));
        }

        expect(rowDepthKeys.size).toBe(rowCount * 5);
        const repeatPeriod = count === 3 ? 2 : count - 2;
        for (let depth = 2; depth + repeatPeriod <= 5; depth += 1) {
          expect(signatures.get(depth + repeatPeriod)).toBe(signatures.get(depth));
        }
      }
    }
  });

  test("clue givers never receive Rows they started after the first letter in standard rotation", () => {
    for (let count = 4; count <= 8; count += 1) {
      const seats = players(count);
      for (let roundNumber = 1; roundNumber <= roundsForPlayerCount(count); roundNumber += 1) {
        const starters = new Map(
          assignmentsForDepth(seats, roundNumber, 1).map((assignment) => [assignment.rowIndex, assignment.holderUserId]),
        );
        for (let depth = 2; depth <= 5; depth += 1) {
          for (const assignment of assignmentsForDepth(seats, roundNumber, depth)) {
            expect(assignment.holderUserId).not.toBe(starters.get(assignment.rowIndex));
          }
        }
      }
    }
  });
});

function assignmentSignature(assignments: ReturnType<typeof assignmentsForDepth>): string {
  return [...assignments]
    .sort((a, b) => a.rowIndex - b.rowIndex)
    .map((row) => `${row.rowIndex}:${row.holderUserId}:${row.slot}`)
    .join("|");
}
