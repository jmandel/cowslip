export type PlayerSeat = {
  userId: string;
  seatNumber: number;
  nickname: string;
};

export type RolePlan = {
  guesser: PlayerSeat;
  answerWriter: PlayerSeat;
  clueGivers: PlayerSeat[];
};

export type RowAssignment = {
  rowIndex: number;
  holderUserId: string;
  holderSeatNumber: number;
  slot: "standard" | "left" | "right";
};

export function orderedSeats(players: PlayerSeat[]): PlayerSeat[] {
  return [...players].sort((a, b) => a.seatNumber - b.seatNumber);
}

export function rolesForRound(players: PlayerSeat[], roundNumber: number): RolePlan {
  const seats = orderedSeats(players);
  if (seats.length < 3 || seats.length > 8) {
    throw new RangeError("The game supports 3-8 players.");
  }
  const guesser = seats[(roundNumber - 1) % seats.length];
  if (!guesser) throw new Error("Could not assign guesser.");
  const answerWriter = seats[(guesser.seatNumber + 1) % seats.length];
  if (!answerWriter) throw new Error("Could not assign answer writer.");
  const clueGivers = seats
    .slice(guesser.seatNumber + 1)
    .concat(seats.slice(0, guesser.seatNumber))
    .filter((seat) => seat.userId !== guesser.userId);
  return { guesser, answerWriter, clueGivers };
}

export function rowCountForPlayers(playerCount: number): number {
  if (playerCount === 3) return 4;
  return playerCount - 1;
}

export function assignmentsForDepth(players: PlayerSeat[], roundNumber: number, depth: number): RowAssignment[] {
  if (depth < 1 || depth > 5) throw new RangeError("Depth must be 1-5.");
  return players.length === 3
    ? threePlayerAssignments(players, roundNumber, depth)
    : standardAssignments(players, roundNumber, depth);
}

function standardAssignments(players: PlayerSeat[], roundNumber: number, depth: number): RowAssignment[] {
  const { clueGivers } = rolesForRound(players, roundNumber);
  const offset = depth === 1 ? 0 : ((depth - 2) % (clueGivers.length - 1)) + 1;
  return clueGivers.map((_, rowIndex) => {
    const holder = clueGivers[(rowIndex + offset) % clueGivers.length];
    if (!holder) throw new Error("Missing holder.");
    return {
      rowIndex,
      holderUserId: holder.userId,
      holderSeatNumber: holder.seatNumber,
      slot: "standard" as const,
    };
  });
}

function threePlayerAssignments(players: PlayerSeat[], roundNumber: number, depth: number): RowAssignment[] {
  const { clueGivers } = rolesForRound(players, roundNumber);
  if (clueGivers.length !== 2) throw new Error("Three-player variant needs exactly two clue givers.");

  const swapped = depth % 2 === 0;
  return Array.from({ length: 4 }, (_, rowIndex) => {
    const starterIndex = rowIndex % 2;
    const holderIndex = swapped ? 1 - starterIndex : starterIndex;
    const holder = clueGivers[holderIndex]!;
    return {
      rowIndex,
      holderUserId: holder.userId,
      holderSeatNumber: holder.seatNumber,
      slot: rowIndex < 2 ? "left" : "right",
    };
  });
}

export function holderForRow(
  players: PlayerSeat[],
  roundNumber: number,
  depth: number,
  rowIndex: number,
): RowAssignment | undefined {
  return assignmentsForDepth(players, roundNumber, depth).find((row) => row.rowIndex === rowIndex);
}
