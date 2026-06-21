export type DifficultyHint = "easy" | "medium" | "spicy";

export type Category = {
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
  | "category-choice"
  | "answer-entry"
  | "letter-entry"
  | "guesser-call"
  | "guess-judging"
  | "round-recap"
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

export type RoomPresence = {
  presenceKey: string;
  roomSlug: string;
  handle: string;
  normalizedHandle: string;
  displayName: string;
  lastSeenAt: number;
  createdAt: number;
  updatedAt: number;
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
  skipped: boolean;
  endsWord: boolean;
  revealed: boolean;
  filledAtDepth?: number;
  createdAt: number;
};

export type ClueCellInput = {
  letter?: string;
  cells?: Array<{
    depth: number;
    letter: string;
  }>;
  skipped?: boolean;
  endsWord?: boolean;
};

export type Round = {
  id: string;
  roundNumber: number;
  phase: GamePhase;
  status: RoundStatus;
  guesserHandle: string;
  answerWriterHandle: string;
  categoryOptions: string[];
  categoryId?: string;
  categoryLabel?: string;
  depth: number;
  phaseVersion: number;
  answerRaw?: string;
  answerNorm?: string;
  guessRaw?: string;
  guessNorm?: string;
  accepted?: boolean;
  points?: number;
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
  totalRounds: number;
  phaseVersion: number;
  playerCount: number;
  categoryPackId: string;
  rulesVersion: string;
  roundPoints: number[];
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

export type GameEventType =
  | "handle.claimed"
  | "game.created"
  | "player.joined"
  | "player.ready-set"
  | "seats.reordered"
  | "game.started"
  | "category.chosen"
  | "answer.submitted"
  | "letters.submitted"
  | "letters.revealed"
  | "more-letters.requested"
  | "guess.submitted"
  | "guess.judged"
  | "round.passed"
  | "next-round.started"
  | "game.completed"
  | "game.scuttled"
  | "round.voided"
  | "game.paused"
  | "game.resumed"
  | "host.transferred";

export type GameEvent = {
  actionId: string;
  type: GameEventType;
  roomSlug: string;
  actorHandle: string;
  gameId?: string;
  roundId?: string;
  expectedPhaseVersion?: number;
  createdAt: number;
  payload: Record<string, unknown>;
};

export type CommandResult =
  | { ok: true; events: GameEvent[] }
  | { ok: false; error: string };
