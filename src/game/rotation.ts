export type PlayerSeat = {
  userId: string;
  seatNumber: number;
  nickname: string;
};

export type RolePlan = {
  farmer: PlayerSeat;
  sower: PlayerSeat;
  hands: PlayerSeat[];
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
    throw new RangeError("Sow's Ear supports 3-8 players.");
  }
  const farmer = seats[(roundNumber - 1) % seats.length];
  if (!farmer) throw new Error("Could not assign Farmer.");
  const sower = seats[(farmer.seatNumber + 1) % seats.length];
  if (!sower) throw new Error("Could not assign Sower.");
  const hands = seats
    .slice(farmer.seatNumber + 1)
    .concat(seats.slice(0, farmer.seatNumber))
    .filter((seat) => seat.userId !== farmer.userId);
  return { farmer, sower, hands };
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
  const { hands } = rolesForRound(players, roundNumber);
  const offset = depth === 1 ? 0 : ((depth - 2) % (hands.length - 1)) + 1;
  return hands.map((_, rowIndex) => {
    const holder = hands[(rowIndex + offset) % hands.length];
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
  const { hands } = rolesForRound(players, roundNumber);
  if (hands.length !== 2) throw new Error("Three-player variant needs exactly two Hands.");

  if (depth > 1) {
    return [
      { rowIndex: 0, holderUserId: hands[1]!.userId, holderSeatNumber: hands[1]!.seatNumber, slot: "left" },
      { rowIndex: 1, holderUserId: hands[1]!.userId, holderSeatNumber: hands[1]!.seatNumber, slot: "right" },
      { rowIndex: 2, holderUserId: hands[0]!.userId, holderSeatNumber: hands[0]!.seatNumber, slot: "left" },
      { rowIndex: 3, holderUserId: hands[0]!.userId, holderSeatNumber: hands[0]!.seatNumber, slot: "right" },
    ];
  }

  let slots: RowAssignment[] = [
    { rowIndex: 0, holderUserId: hands[0]!.userId, holderSeatNumber: hands[0]!.seatNumber, slot: "left" },
    { rowIndex: 1, holderUserId: hands[0]!.userId, holderSeatNumber: hands[0]!.seatNumber, slot: "right" },
    { rowIndex: 2, holderUserId: hands[1]!.userId, holderSeatNumber: hands[1]!.seatNumber, slot: "left" },
    { rowIndex: 3, holderUserId: hands[1]!.userId, holderSeatNumber: hands[1]!.seatNumber, slot: "right" },
  ];

  for (let i = 1; i < depth; i += 1) {
    const byHand = hands.map((hand) => ({
      hand,
      left: slots.find((slot) => slot.holderUserId === hand.userId && slot.slot === "left")!,
      right: slots.find((slot) => slot.holderUserId === hand.userId && slot.slot === "right")!,
    }));
    slots = byHand.flatMap((entry, handIndex) => {
      const prev = byHand[(handIndex - 1 + byHand.length) % byHand.length]!;
      return [
        {
          rowIndex: entry.right.rowIndex,
          holderUserId: entry.hand.userId,
          holderSeatNumber: entry.hand.seatNumber,
          slot: "left" as const,
        },
        {
          rowIndex: prev.left.rowIndex,
          holderUserId: entry.hand.userId,
          holderSeatNumber: entry.hand.seatNumber,
          slot: "right" as const,
        },
      ];
    });
  }

  return slots.sort((a, b) => a.rowIndex - b.rowIndex);
}

export function holderForRow(
  players: PlayerSeat[],
  roundNumber: number,
  depth: number,
  rowIndex: number,
): RowAssignment | undefined {
  return assignmentsForDepth(players, roundNumber, depth).find((row) => row.rowIndex === rowIndex);
}
