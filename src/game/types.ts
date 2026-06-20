export type DifficultyHint = "easy" | "medium" | "spicy";

export type Field = {
  id: string;
  label: string;
  locale: "en-US";
  packId: string;
  source: "original" | "custom";
  active: boolean;
  difficultyHint?: DifficultyHint;
};

export type GamePhase =
  | "lobby"
  | "field-choice"
  | "seed"
  | "planting"
  | "farmer-call"
  | "adjudication"
  | "harvest-recap"
  | "final";

export type GameStatus = "lobby" | "active" | "complete" | "void";
export type RoundStatus = "active" | "resolved" | "void";

export type RoomHandle = {
  handle: string;
  normalizedHandle: string;
  displayName: string;
  lastSeenAt: number;
  createdAt: number;
};

export type GamePlayer = {
  handle: string;
  normalizedHandle: string;
  displayName: string;
  seatNumber: number;
  ready: boolean;
  isHost: boolean;
  joinedAt: number;
  updatedAt: number;
};

export type Row = {
  rowIndex: number;
  starterHandle: string;
  currentHolderHandle: string;
  slot: "standard" | "left" | "right";
};

export type ClueEntry = {
  rowIndex: number;
  depth: number;
  handle: string;
  letter: string;
  endsWord: boolean;
  sprouted: boolean;
  createdAt: number;
};

export type ClueCellInput = {
  letter: string;
  endsWord?: boolean;
};

export type Round = {
  id: string;
  roundNumber: number;
  phase: GamePhase;
  status: RoundStatus;
  farmerHandle: string;
  sowerHandle: string;
  fieldOptions: string[];
  fieldId?: string;
  fieldLabel?: string;
  depth: number;
  phaseVersion: number;
  seedRaw?: string;
  seedNorm?: string;
  guessRaw?: string;
  guessNorm?: string;
  accepted?: boolean;
  ribbon?: number;
  rows: Row[];
  entries: ClueEntry[];
  createdAt: number;
  updatedAt: number;
  resolvedAt?: number;
};

export type Game = {
  id: string;
  roomSlug: string;
  status: GameStatus;
  phase: GamePhase;
  hostHandle: string;
  players: GamePlayer[];
  rounds: Round[];
  currentRoundId?: string;
  currentRoundNumber: number;
  totalHarvests: number;
  phaseVersion: number;
  playerCount: number;
  fieldPackId: string;
  rulesVersion: string;
  ribbons: number[];
  pausedAt?: number;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
};

export type RoomState = {
  roomSlug: string;
  handles: RoomHandle[];
  games: Game[];
  activeGameId?: string;
  appliedActionIds: Set<string>;
};

export type SowsEarEventType =
  | "handle.claimed"
  | "handle.seen"
  | "season.created"
  | "player.joined"
  | "player.ready-set"
  | "seats.reordered"
  | "season.started"
  | "field.chosen"
  | "seed.planted"
  | "letters.planted"
  | "rows.sprouted"
  | "farmer.waited"
  | "guess.submitted"
  | "guess.adjudicated"
  | "harvest.spoiled"
  | "next-harvest.started"
  | "season.completed"
  | "harvest.voided"
  | "season.paused"
  | "season.resumed"
  | "host.transferred";

export type SowsEarEvent = {
  actionId: string;
  type: SowsEarEventType;
  roomSlug: string;
  actorHandle: string;
  gameId?: string;
  roundId?: string;
  expectedPhaseVersion?: number;
  createdAt: number;
  payload: Record<string, unknown>;
};

export type CommandResult =
  | { ok: true; events: SowsEarEvent[] }
  | { ok: false; error: string };
