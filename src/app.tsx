import React, { useEffect, useLayoutEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import { Check, CircleHelp, Copy, Home, LogOut, UserPen, X } from "lucide-react";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { categoryLabel } from "./content/categories";
import {
  activeGame,
  commandJudgeGuess,
  commandAdvanceRound,
  commandClaimHost,
  commandChooseCategory,
  commandClaimHandle,
  commandCreateGame,
  commandGuess,
  commandMoveSeat,
  commandPauseGame,
  commandReorderSeats,
  commandScuttleGame,
  commandSubmitLetters,
  commandSubmitAnswer,
  commandRandomizeSeats,
  commandResumeGame,
  commandPassRound,
  commandStartGame,
  commandTransferHost,
  commandTryRevealLetters,
  commandVoidRound,
  cleanHandle,
  commandRequestMoreLetters,
  currentRound,
  finalScore,
  normalizeHandle,
  reduceEvents,
  roleForHandle,
  rowEntriesThroughDepth,
  rowIsComplete,
  rowsHeldByClueGiver,
  roomSlugFrom,
  trailingBlankEntriesForRow,
} from "./game/model";
import { clampLetter, pointsForDepth } from "./game/rules";
import type { ClueCellInput, ClueEntry, CommandResult, Game, RoomPresence, RoomState, Round, Row } from "./game/types";
import { createEventStore, type EventStore } from "./store/event-store";

type AppContext = {
  roomSlug: string;
  handle: string;
  reviewGameId?: string;
};

type RememberedRoom = {
  roomSlug: string;
  handle: string;
  updatedAt: number;
};

type GameRuntime = {
  eventStore: EventStore;
  unsubscribeEvents: (() => void) | undefined;
  unsubscribePresence: (() => void) | undefined;
  seenInterval: number | undefined;
  copyResetTimer: number | undefined;
  pendingClaims: Set<string>;
  pendingLobbyJoins: Set<string>;
  pendingReveals: Set<string>;
  pendingSeen: Set<string>;
  pendingCommands: Set<string>;
  lastSeenSentAt: Map<string, number>;
};

type GameState = {
  context: AppContext;
  roomState: RoomState | undefined;
  presence: RoomPresence[];
  rememberedRooms: RememberedRoom[];
  lastHandle: string;
  runtime: GameRuntime;
  error: string;
  copyStatus: "idle" | "copied" | "failed";
  pendingGuess: string;
  pendingPassConfirm: boolean;
  pendingVoidConfirm: boolean;
  pendingScuttleConfirm: boolean;
  focusTarget: string | undefined;
  helpOpen: boolean;
  now: number;
  mode: string;
  initialize(): void;
  shutdown(): void;
  syncFromLocation(): void;
  navigate(next: AppContext): void;
  setUrl(params: Record<string, string | undefined>): void;
  copyRoom(): Promise<void>;
  openRoom(roomSlug: string, handle?: string): void;
  backHome(): void;
  forgetRoom(roomSlug: string): void;
  claimHandle(handle: string): Promise<void>;
  switchHandle(): void;
  createGame(): Promise<void>;
  selectPlayer(handle: string, selected: boolean): Promise<void>;
  startGame(): Promise<void>;
  scuttleGame(confirmed?: boolean): Promise<void>;
  moveSeat(handle: string, direction: "up" | "down"): Promise<void>;
  randomizeSeats(): Promise<void>;
  pauseGame(): Promise<void>;
  resumeGame(): Promise<void>;
  voidRound(confirmed?: boolean): Promise<void>;
  transferHost(nextHost: string): Promise<void>;
  claimHost(): Promise<void>;
  chooseCategory(categoryId: string): Promise<void>;
  submitAnswer(answer: string): Promise<void>;
  submitLetters(letters: Map<number, string | ClueCellInput>): Promise<void>;
  requestMoreLetters(): Promise<void>;
  passRound(confirmed?: boolean): Promise<void>;
  submitGuess(guess: string, confirmed: boolean): Promise<void>;
  judgeGuess(accepted: boolean): Promise<void>;
  advanceRound(): Promise<void>;
  copySummary(): Promise<void>;
  reviewGame(gameId: string): void;
  leaveReview(): void;
  openHelp(): void;
  closeHelp(): void;
  clearFocusTarget(): void;
  rememberRoom(roomSlug: string, handle: string): void;
  ensureHandleClaimed(): Promise<void>;
  ensureHandleSeen(force?: boolean): Promise<void>;
  ensureLobbyReady(): Promise<void>;
  ensureLettersRevealed(): Promise<void>;
};

const APP_STORAGE_KEY = "cowslip:app";
const PRESENCE_HEARTBEAT_MS = 15000;
const PRESENCE_ONLINE_MS = 45000;
type PenStyle = {
  index: number;
};

function createRuntime(): GameRuntime {
  return {
    eventStore: createEventStore(),
    unsubscribeEvents: undefined,
    unsubscribePresence: undefined,
    seenInterval: undefined,
    copyResetTimer: undefined,
    pendingClaims: new Set(),
    pendingLobbyJoins: new Set(),
    pendingReveals: new Set(),
    pendingSeen: new Set(),
    pendingCommands: new Set(),
    lastSeenSentAt: new Map(),
  };
}

const useGameStore = create<GameState>()(persist((set, get) => {
  const runtime = createRuntime();
  return {
  context: { roomSlug: "", handle: "" },
  roomState: undefined,
  presence: [],
  rememberedRooms: [],
  lastHandle: "",
  runtime,
  error: "",
  copyStatus: "idle",
  pendingGuess: "",
  pendingPassConfirm: false,
  pendingVoidConfirm: false,
  pendingScuttleConfirm: false,
  focusTarget: undefined,
  helpOpen: false,
  now: Date.now(),
  mode: runtime.eventStore.mode,

  initialize() {
    get().syncFromLocation();
  },

  shutdown() {
    const runtime = get().runtime;
    runtime.unsubscribeEvents?.();
    runtime.unsubscribeEvents = undefined;
    runtime.unsubscribePresence?.();
    runtime.unsubscribePresence = undefined;
    if (runtime.seenInterval) window.clearInterval(runtime.seenInterval);
    runtime.seenInterval = undefined;
    if (runtime.copyResetTimer) window.clearTimeout(runtime.copyResetTimer);
    runtime.copyResetTimer = undefined;
  },

  syncFromLocation() {
    get().navigate(readContextFromLocation(get()));
  },

  navigate(next) {
    const runtime = get().runtime;
    runtime.unsubscribeEvents?.();
    runtime.unsubscribeEvents = undefined;
    runtime.unsubscribePresence?.();
    runtime.unsubscribePresence = undefined;
    if (runtime.seenInterval) window.clearInterval(runtime.seenInterval);
    runtime.seenInterval = undefined;
    set({ context: next, roomState: undefined, presence: [], error: "", pendingGuess: "", pendingPassConfirm: false, pendingVoidConfirm: false, pendingScuttleConfirm: false, now: Date.now() });

    if (!next.roomSlug) return;
    get().rememberRoom(next.roomSlug, next.handle);
    runtime.unsubscribeEvents = runtime.eventStore.subscribe(next.roomSlug, (events) => {
      const roomState = reduceEvents(next.roomSlug, events);
      set({ roomState, now: Date.now() });
      void get().ensureHandleClaimed();
      void get().ensureHandleSeen();
      void get().ensureLobbyReady();
      void get().ensureLettersRevealed();
    });
    runtime.unsubscribePresence = runtime.eventStore.subscribePresence(next.roomSlug, (presence) => {
      set({ presence, now: Date.now() });
    });
    runtime.seenInterval = window.setInterval(() => {
      void get().ensureHandleSeen(true);
      set({ now: Date.now() });
    }, PRESENCE_HEARTBEAT_MS);
  },

  setUrl(params) {
    const url = new URL(window.location.href);
    for (const [key, value] of Object.entries(params)) {
      if (value) url.searchParams.set(key, value);
      else url.searchParams.delete(key);
    }
    history.pushState({}, "", url);
    get().navigate(readContextFromLocation(get()));
  },

  async copyRoom() {
    const roomLink = currentRoomLink(get().context.roomSlug);
    const runtime = get().runtime;
    if (runtime.copyResetTimer) window.clearTimeout(runtime.copyResetTimer);
    try {
      await navigator.clipboard?.writeText(roomLink);
      set({ copyStatus: "copied" });
      runtime.copyResetTimer = window.setTimeout(() => {
        if (get().copyStatus === "copied") set({ copyStatus: "idle" });
        runtime.copyResetTimer = undefined;
      }, 1400);
    } catch {
      set({ copyStatus: "failed" });
      runtime.copyResetTimer = window.setTimeout(() => {
        if (get().copyStatus === "failed") set({ copyStatus: "idle" });
        runtime.copyResetTimer = undefined;
      }, 1800);
    }
  },

  openRoom(roomSlug, handleInput = "") {
    const cleanedHandle = cleanHandle(handleInput);
    if (cleanedHandle) {
      get().rememberRoom(roomSlug, cleanedHandle);
      set({ lastHandle: cleanedHandle });
    }
    get().setUrl({ room: roomSlug, handle: undefined, review: undefined });
  },

  backHome() {
    get().setUrl({ room: undefined, handle: undefined, review: undefined });
  },

  forgetRoom(roomSlugInput) {
    const roomSlug = roomSlugFrom(roomSlugInput);
    if (!roomSlug) return;
    set({ rememberedRooms: get().rememberedRooms.filter((room) => room.roomSlug !== roomSlug) });
  },

  async claimHandle(handleInput) {
    const cleaned = handleInput.trim();
    if (!cleaned) return;
    const { context, roomState } = get();
    get().rememberRoom(context.roomSlug, cleaned);
    set({ lastHandle: cleaned });
    if (roomState) await dispatch(commandClaimHandle(roomState, cleaned), set, get);
    get().setUrl({ room: context.roomSlug, review: undefined });
  },

  switchHandle() {
    const { context } = get();
    get().rememberRoom(context.roomSlug, "");
    set({ context: { roomSlug: context.roomSlug, handle: "" }, lastHandle: "", error: "" });
  },

  async createGame() {
    await dispatchOnce("create-game", () => commandCreateGame(requiredRoomState(get), get().context.handle), set, get);
  },

  async selectPlayer(playerHandle, selected) {
    await dispatchOnce(`select-player:${normalizeHandle(playerHandle)}:${selected}`, () => {
      const state = requiredRoomState(get);
      const game = activeGame(state);
      if (!game || game.status !== "lobby") return { ok: false, error: "Seats can only be changed in the lobby." };
      const normalizedHandle = normalizeHandle(playerHandle);
      const currentHandles = [...game.players].sort((a, b) => a.seatNumber - b.seatNumber).map((player) => player.handle);
      if (!selected) {
        return commandReorderSeats(
          state,
          get().context.handle,
          currentHandles.filter((handle) => normalizeHandle(handle) !== normalizedHandle),
        );
      }
      const roomHandle = state.handles.find((handle) => handle.normalizedHandle === normalizedHandle);
      if (!roomHandle) return { ok: false, error: "Only room members can be selected." };
      if (currentHandles.some((handle) => normalizeHandle(handle) === normalizedHandle)) return { ok: true, events: [] };
      return commandReorderSeats(state, get().context.handle, [...currentHandles, roomHandle.handle]);
    }, set, get);
  },

  async startGame() {
    await dispatchOnce("start-game", () => commandStartGame(requiredRoomState(get), get().context.handle), set, get);
  },

  async scuttleGame(confirmed = false) {
    if (!confirmed) {
      set({ pendingScuttleConfirm: true, focusTarget: "confirm-scuttle-game" });
      return;
    }
    set({ pendingScuttleConfirm: false });
    await dispatchOnce("scuttle-game", () => commandScuttleGame(requiredRoomState(get), get().context.handle), set, get);
  },

  async moveSeat(handle, direction) {
    await dispatchOnce(`move-seat:${handle}:${direction}`, () => commandMoveSeat(requiredRoomState(get), get().context.handle, handle, direction), set, get);
  },

  async randomizeSeats() {
    await dispatchOnce("randomize-seats", () => commandRandomizeSeats(requiredRoomState(get), get().context.handle), set, get);
  },

  async pauseGame() {
    await dispatchOnce("pause-game", () => commandPauseGame(requiredRoomState(get), get().context.handle), set, get);
  },

  async resumeGame() {
    await dispatchOnce("resume-game", () => commandResumeGame(requiredRoomState(get), get().context.handle), set, get);
  },

  async voidRound(confirmed = false) {
    if (!confirmed) {
      set({ pendingVoidConfirm: true, focusTarget: "confirm-void-round" });
      return;
    }
    set({ pendingVoidConfirm: false });
    await dispatchOnce("void-round", () => commandVoidRound(requiredRoomState(get), get().context.handle), set, get);
  },

  async transferHost(nextHost) {
    await dispatchOnce(`transfer-host:${nextHost}`, () => commandTransferHost(requiredRoomState(get), get().context.handle, nextHost), set, get);
  },

  async claimHost() {
    await dispatchOnce("claim-host", () => commandClaimHost(requiredRoomState(get), get().context.handle), set, get);
  },

  async chooseCategory(categoryId) {
    await dispatchOnce(`choose-category:${categoryId}`, () => commandChooseCategory(requiredRoomState(get), get().context.handle, categoryId), set, get);
  },

  async submitAnswer(answer) {
    await dispatchOnce("answer-entry", () => commandSubmitAnswer(requiredRoomState(get), get().context.handle, answer), set, get);
  },

  async submitLetters(letters) {
    await dispatchOnce("letters", () => commandSubmitLetters(requiredRoomState(get), get().context.handle, letters), set, get);
  },

  async requestMoreLetters() {
    await dispatchOnce("request-more-letters", () => commandRequestMoreLetters(requiredRoomState(get), get().context.handle), set, get);
  },

  async passRound(confirmed = false) {
    if (!confirmed) {
      set({ pendingPassConfirm: true, focusTarget: "confirm-pass-round" });
      return;
    }
    set({ pendingPassConfirm: false });
    await dispatchOnce("pass-round", () => commandPassRound(requiredRoomState(get), get().context.handle), set, get);
  },

  async submitGuess(guess, confirmed) {
    if (!confirmed) {
      set({ pendingGuess: guess, pendingPassConfirm: false, focusTarget: "confirm-guess" });
      return;
    }
    const pendingGuess = get().pendingGuess;
    set({ pendingGuess: "", pendingPassConfirm: false });
    await dispatchOnce("guess", () => commandGuess(requiredRoomState(get), get().context.handle, pendingGuess || guess), set, get);
  },

  async judgeGuess(accepted) {
    await dispatchOnce(`judge-guess:${accepted}`, () => commandJudgeGuess(requiredRoomState(get), get().context.handle, accepted), set, get);
  },

  async advanceRound() {
    await dispatchOnce("advance-round", () => commandAdvanceRound(requiredRoomState(get), get().context.handle), set, get);
  },

  async copySummary() {
    const game = activeGame(requiredRoomState(get));
    if (!game) return;
    try {
      await navigator.clipboard?.writeText(gameSummary(game));
      set({ error: "Summary copied." });
    } catch {
      set({ error: "Summary is ready to copy." });
    }
  },

  reviewGame(gameId) {
    get().setUrl({ room: get().context.roomSlug, review: gameId });
  },

  leaveReview() {
    get().setUrl({ room: get().context.roomSlug, review: undefined });
  },

  openHelp() {
    set({ helpOpen: true });
  },

  closeHelp() {
    set({ helpOpen: false });
  },

  clearFocusTarget() {
    set({ focusTarget: undefined });
  },

  rememberRoom(roomSlugInput, handleInput) {
    const roomSlug = roomSlugFrom(roomSlugInput);
    if (!roomSlug) return;
    const nextRooms = get().rememberedRooms.filter((room) => room.roomSlug !== roomSlug);
    nextRooms.unshift({
      roomSlug,
      handle: handleInput.trim(),
      updatedAt: Date.now(),
    });
    set({ rememberedRooms: nextRooms.slice(0, 12) });
  },

  async ensureHandleClaimed() {
    const { context, roomState } = get();
    if (!roomState || !context.handle) return;
    const runtime = get().runtime;
    const key = `${context.roomSlug}:${normalizeHandle(context.handle)}`;
    if (runtime.pendingClaims.has(key)) return;
    if (roomState.handles.some((handle) => handle.normalizedHandle === normalizeHandle(context.handle))) return;
    runtime.pendingClaims.add(key);
    try {
      await dispatch(commandClaimHandle(roomState, context.handle), set, get);
    } finally {
      runtime.pendingClaims.delete(key);
    }
  },

  async ensureHandleSeen(force = false) {
    const { context, roomState } = get();
    if (!roomState || !context.handle) return;
    const runtime = get().runtime;
    const normalizedHandle = normalizeHandle(context.handle);
    if (!roomState.handles.some((handle) => handle.normalizedHandle === normalizedHandle)) return;
    const key = `${context.roomSlug}:${normalizedHandle}`;
    if (runtime.pendingSeen.has(key)) return;
    const now = Date.now();
    const lastSent = runtime.lastSeenSentAt.get(key) ?? 0;
    if (!force && now - lastSent < PRESENCE_HEARTBEAT_MS) return;
    runtime.pendingSeen.add(key);
    runtime.lastSeenSentAt.set(key, now);
    try {
      await runtime.eventStore.markSeen({
        roomSlug: context.roomSlug,
        handle: context.handle,
        normalizedHandle,
        displayName: context.handle,
      });
    } finally {
      runtime.pendingSeen.delete(key);
    }
  },

  async ensureLobbyReady() {
    const { context, roomState } = get();
    if (!roomState || !context.handle) return;
    const normalizedHandle = normalizeHandle(context.handle);
    if (!roomState.handles.some((handle) => handle.normalizedHandle === normalizedHandle)) return;
    const game = activeGame(roomState);
    if (game && game.status !== "void") return;
    const runtime = get().runtime;
    const key = `${context.roomSlug}:${normalizedHandle}:create-lobby`;
    if (runtime.pendingLobbyJoins.has(key)) return;
    const result = commandCreateGame(roomState, context.handle);
    if (!result.ok) {
      set({ error: result.error });
      return;
    }
    runtime.pendingLobbyJoins.add(key);
    try {
      await runtime.eventStore.append(result.events);
    } finally {
      runtime.pendingLobbyJoins.delete(key);
    }
  },

  async ensureLettersRevealed() {
    const { context, roomState } = get();
    if (!roomState || !context.handle) return;
    const runtime = get().runtime;
    const game = activeGame(roomState);
    const round = game ? currentRound(game) : undefined;
    if (!game || !round || round.phase !== "letter-entry") return;
    const key = `${game.id}:${round.id}:${round.depth}:${game.phaseVersion}`;
    if (runtime.pendingReveals.has(key)) return;
    const result = commandTryRevealLetters(roomState, context.handle);
    if (!result.ok || !result.events.length) return;
    runtime.pendingReveals.add(key);
    try {
      await runtime.eventStore.append(result.events);
    } finally {
      runtime.pendingReveals.delete(key);
    }
  },
  };
}, {
  name: APP_STORAGE_KEY,
  storage: createJSONStorage(() => localStorage),
  partialize: (state) => ({
    rememberedRooms: state.rememberedRooms,
    lastHandle: state.lastHandle,
  }),
}));

function CowslipApp(): React.ReactElement {
  const context = useGameStore((state) => state.context);
  const roomState = useGameStore((state) => state.roomState);
  const error = useGameStore((state) => state.error);
  const initialize = useGameStore((state) => state.initialize);
  const shutdown = useGameStore((state) => state.shutdown);
  const syncFromLocation = useGameStore((state) => state.syncFromLocation);

  useEffect(() => {
    initialize();
    const onPopState = (): void => syncFromLocation();
    window.addEventListener("popstate", onPopState);
    return () => {
      window.removeEventListener("popstate", onPopState);
      shutdown();
    };
  }, [initialize, shutdown, syncFromLocation]);

  useAutoFocus();

  let body: React.ReactNode;
  if (!context.roomSlug) {
    body = <RoomEntry />;
  } else if (!context.handle) {
    body = <HandleClaim />;
  } else if (!roomState) {
    body = (
      <section className="paper-panel">
        <p>Loading Room...</p>
      </section>
    );
  } else if (!roomState.handles.some((handle) => handle.normalizedHandle === normalizeHandle(context.handle))) {
    body = (
      <section className="paper-panel">
        <p>Joining Room...</p>
      </section>
    );
  } else {
    const review = context.reviewGameId ? roomState.games.find((game) => game.id === context.reviewGameId) : undefined;
    const game = activeGame(roomState);
    body = review ? <Review game={review} /> : game ? <GameView game={game} /> : <OpeningLobby />;
  }

  return (
    <main className="app-shell" onKeyDown={handleRootKeyDown}>
      <Shell />
      {error ? (
        <div className="toast" role="alert" data-testid="error">
          {error}
        </div>
      ) : null}
      {body}
      <HelpDialog />
    </main>
  );
}

function Shell(): React.ReactElement {
  const context = useGameStore((state) => state.context);
  const openHelp = useGameStore((state) => state.openHelp);
  const copyRoom = useGameStore((state) => state.copyRoom);
  const backHome = useGameStore((state) => state.backHome);
  const switchHandle = useGameStore((state) => state.switchHandle);
  const copyStatus = useGameStore((state) => state.copyStatus);
  const hasRoomContext = Boolean(context.roomSlug || context.handle);
  return (
    <header className="topbar">
      <div className="topbar-brand">
        <a className="wordmark" href="./">
          <img src="./assets/cowslip-icon.png" alt="" className="wordmark-flower" />
          Cowslip
        </a>
      </div>
      <div className="topbar-global-actions">
        {context.roomSlug ? (
          <button type="button" className="button icon-button topbar-icon-button" aria-label="Back to home" title="Back to home" onClick={backHome} data-testid="back-home">
            <Home aria-hidden="true" size={19} strokeWidth={2.5} />
          </button>
        ) : null}
        <button type="button" className="help-button" aria-label="How to play" title="How to play" onClick={openHelp} data-testid="help-button">
          <CircleHelp aria-hidden="true" size={24} strokeWidth={2.25} />
        </button>
      </div>
      {hasRoomContext ? (
        <div className="topbar-actions">
          <div className="topbar-room-row">
            {context.roomSlug ? (
              <div className="topbar-meta">
                <TopbarChip label="Room" value={context.roomSlug} />
              </div>
            ) : null}
            <div className="topbar-icon-actions">
              {context.roomSlug ? (
                <button
                  type="button"
                  className="button icon-button topbar-icon-button"
                  aria-label={copyStatus === "copied" ? "Room link copied" : copyStatus === "failed" ? "Copy failed" : "Copy room link"}
                  title={copyStatus === "copied" ? "Copied" : copyStatus === "failed" ? "Copy failed" : "Copy room link"}
                  data-copy-status={copyStatus}
                  onClick={() => void copyRoom()}
                  data-testid="copy-room"
                >
                  {copyStatus === "copied" ? <Check aria-hidden="true" size={19} strokeWidth={2.8} /> : <Copy aria-hidden="true" size={19} strokeWidth={2.5} />}
                </button>
              ) : null}
            </div>
          </div>
          {context.handle ? (
            <div className="topbar-handle-row">
              <TopbarChip label="Handle" value={context.handle} className="topbar-handle-chip" />
              <button type="button" className="button icon-button topbar-icon-button" aria-label="Switch handle" title="Switch handle" onClick={switchHandle} data-testid="switch-handle">
                <UserPen aria-hidden="true" size={18} strokeWidth={2.5} />
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </header>
  );
}

function TopbarChip({ label, value, className = "" }: { label: string; value: string; className?: string }): React.ReactElement {
  return (
    <span className={`topbar-chip ${className}`}>
      <span className="topbar-chip-label">{label}</span>
      <span className="topbar-chip-value">
        <span className="topbar-chip-text">{value}</span>
      </span>
    </span>
  );
}

function HelpDialog(): React.ReactElement {
  const helpOpen = useGameStore((state) => state.helpOpen);
  const closeHelp = useGameStore((state) => state.closeHelp);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (helpOpen && !dialog.open) {
      dialog.showModal();
      closeButtonRef.current?.focus({ preventScroll: true });
    }
    if (!helpOpen && dialog.open) dialog.close();
  }, [helpOpen]);

  return (
    <dialog
      className="help-dialog"
      ref={dialogRef}
      aria-labelledby="help-title"
      data-testid="help-dialog"
      onCancel={(event) => {
        event.preventDefault();
        closeHelp();
      }}
      onClose={closeHelp}
      onClick={(event) => {
        if (event.target === event.currentTarget) closeHelp();
      }}
    >
      <div className="help-sheet">
        <div className="panel-header">
          <div>
            <p className="eyebrow">Rules</p>
            <h1 id="help-title">How to Play</h1>
          </div>
          <button ref={closeButtonRef} type="button" className="button icon-button" aria-label="Close help" onClick={closeHelp} data-testid="close-help">
            <X aria-hidden="true" size={20} strokeWidth={2.5} />
          </button>
        </div>
        <div className="help-content">
          <section>
            <h2>Goal</h2>
            <p>Work together to help the guesser name the answer writer&apos;s answer from a category and a few clue cells.</p>
          </section>
          <section>
            <h2>Roles</h2>
            <p>The guesser sees the category and makes the guess. The answer writer enters the answer. Every non-guesser adds one letter to each row they hold.</p>
          </section>
          <section>
            <h2>Round</h2>
            <p>Each row can grow to five cells. A clue giver may add a period after a letter to split words. The next clue giver continues in the same row.</p>
          </section>
          <section>
            <h2>Scoring</h2>
            <p>Earlier correct guesses earn better points: 20, 10, 7, 5, then 3. The final score is the best five rounds in the game.</p>
          </section>
          <section>
            <h2>Rooms</h2>
            <p>Share the room link. Players enter a name and rejoin as that same person on any device by using the same name.</p>
          </section>
        </div>
      </div>
    </dialog>
  );
}

function RoomEntry(): React.ReactElement {
  const openRoom = useGameStore((state) => state.openRoom);
  const forgetRoom = useGameStore((state) => state.forgetRoom);
  const rememberedRooms = useGameStore((state) => state.rememberedRooms);
  const lastHandle = useGameStore((state) => state.lastHandle);
  const handleInputRef = useRef<HTMLInputElement>(null);
  const defaultHandle = lastHandle || rememberedRooms.find((room) => room.handle)?.handle || "";
  return (
    <section className="hero">
      <div className="plain-lockup">
        <div className="landing-art" aria-hidden="true">
          <img src="./assets/cowslip-flower.webp" alt="" className="landing-flower" />
        </div>
      </div>
      <div className="room-entry-stack">
        <form
          className="paper-panel compact-form room-entry-card"
          onSubmit={(event) => {
            event.preventDefault();
            const roomSlug = roomSlugFrom(formValue(event.currentTarget, "room"));
            const handle = cleanHandle(formValue(event.currentTarget, "handle"));
            if (roomSlug && handle) openRoom(roomSlug, handle);
          }}
        >
          <h2 className="card-title">Room</h2>
          <label className="form-control">
            <span className="sr-only">Room</span>
            <input
              name="room"
              autoComplete="off"
              placeholder="room-name"
              required
              data-testid="room-input"
              onKeyDown={(event) => {
                if (event.key !== "Enter" || formValue(event.currentTarget.form!, "handle")) return;
                event.preventDefault();
                handleInputRef.current?.focus();
              }}
            />
          </label>
          <label className="form-control">
            <span>Name</span>
            <input ref={handleInputRef} name="handle" autoComplete="nickname" maxLength={32} placeholder="Alice" required defaultValue={defaultHandle} data-testid="handle-input" />
          </label>
          <div className="action-row">
            <button type="submit" className="button primary" data-testid="enter-room">
              Enter Room
            </button>
          </div>
        </form>
        {rememberedRooms.length ? (
          <section className="paper-panel remembered-rooms" data-testid="remembered-rooms">
            <h2 className="card-title">Your Rooms</h2>
            <div className="remembered-room-list">
              {rememberedRooms.map((room) => (
                <div className="remembered-room" key={room.roomSlug}>
                  <button type="button" className="remembered-room-open" onClick={() => openRoom(room.roomSlug)} data-testid={`remembered-room-${room.roomSlug}`}>
                    <strong>{room.roomSlug}</strong>
                    {room.handle ? <span>{room.handle}</span> : <span>Choose a name</span>}
                  </button>
                  <button type="button" className="button icon-button remembered-room-leave" aria-label={`Leave ${room.roomSlug}`} title="Leave room" onClick={() => forgetRoom(room.roomSlug)} data-testid={`leave-remembered-room-${room.roomSlug}`}>
                    <LogOut aria-hidden="true" size={18} strokeWidth={2.4} />
                  </button>
                </div>
              ))}
            </div>
          </section>
        ) : null}
      </div>
    </section>
  );
}

function HandleClaim(): React.ReactElement {
  const claimHandle = useGameStore((state) => state.claimHandle);
  const lastHandle = useGameStore((state) => state.lastHandle);
  return (
    <section className="handle-page">
      <div className="paper-panel handle-panel">
        <form
          className="compact-form"
          onSubmit={(event) => {
            event.preventDefault();
            void claimHandle(formValue(event.currentTarget, "handle"));
          }}
        >
          <label>
            Name
            <input name="handle" autoComplete="nickname" maxLength={32} placeholder="Alice" required defaultValue={lastHandle} data-testid="handle-input" />
          </label>
          <button type="submit" className="button primary" data-testid="claim-handle">
            Enter Room
          </button>
        </form>
      </div>
    </section>
  );
}

function OpeningLobby(): React.ReactElement {
  return (
    <section className="room-grid">
      <div className="paper-panel">
        <h1>Opening Lobby</h1>
        <p className="subtle">Getting this room ready.</p>
      </div>
      <History />
    </section>
  );
}

function GameView({ game }: { game: Game }): React.ReactElement {
  const context = useGameStore((state) => state.context);
  const resumeGame = useGameStore((state) => state.resumeGame);
  if (game.status === "lobby") return <Lobby game={game} />;
  if (game.phase === "final") return <Final game={game} />;
  const round = currentRound(game);
  if (!round) return <OpeningLobby />;
  const role = roleForHandle(game, context.handle);
  if (game.pausedAt) {
    return (
      <section className="game-layout">
        <StatusRail game={game} round={round} role={role} />
        <div className="play-surface">
          <section className="paper-panel wait-panel" data-testid="paused-panel">
            <p className="eyebrow">Paused</p>
            <h1>Game Paused</h1>
            <p className="subtle">The host paused this game. Current round state is preserved.</p>
            {normalizeHandle(game.hostHandle) === normalizeHandle(context.handle) ? (
              <button type="button" className="button primary" onClick={() => void resumeGame()} data-testid="resume-game">
                Resume
              </button>
            ) : null}
          </section>
        </div>
      </section>
    );
  }
  return (
    <section className="game-layout">
      <StatusRail game={game} round={round} role={role} />
      <div className="play-surface">
        <PhasePanel game={game} round={round} role={role} />
      </div>
    </section>
  );
}

function Lobby({ game }: { game: Game }): React.ReactElement {
  const context = useGameStore((state) => state.context);
  const roomState = useGameStore((state) => state.roomState);
  const presence = useGameStore((state) => state.presence);
  const now = useGameStore((state) => state.now);
  const selectPlayer = useGameStore((state) => state.selectPlayer);
  const startGame = useGameStore((state) => state.startGame);
  const scuttleGame = useGameStore((state) => state.scuttleGame);
  const pendingScuttleConfirm = useGameStore((state) => state.pendingScuttleConfirm);
  const randomizeSeats = useGameStore((state) => state.randomizeSeats);
  const moveSeat = useGameStore((state) => state.moveSeat);
  const selectedPlayers = [...game.players].sort((a, b) => a.seatNumber - b.seatNumber);
  const selectedHandles = new Set(selectedPlayers.map((player) => player.normalizedHandle));
  const availableHandles = [...(roomState?.handles ?? [])]
    .filter((handle) => !selectedHandles.has(handle.normalizedHandle))
    .sort((a, b) => a.createdAt - b.createdAt || a.displayName.localeCompare(b.displayName));
  const selectedCount = selectedPlayers.length;
  const canStart = selectedCount >= 3 && selectedCount <= 8;
  const rolePreview = canStart ? lobbyRolePreview(game) : "";

  return (
    <section className="room-grid">
      <div className="paper-panel lobby-summary">
        <p className="eyebrow">Game Lobby</p>
        <h1>{context.roomSlug}</h1>
        <p className="subtle">{selectedCount} selected. Start needs 3-8 players.</p>
        {rolePreview ? <p className="role-preview" data-testid="role-preview">{rolePreview}</p> : null}
        <div className="action-row">
          <button type="button" className="button primary" onClick={() => void startGame()} data-testid="start-game" disabled={!canStart} aria-disabled={!canStart}>
            Start Game
          </button>
          <button
            type="button"
            className="button danger"
            onClick={() => void scuttleGame(pendingScuttleConfirm)}
            data-testid={pendingScuttleConfirm ? "confirm-scuttle-game" : "scuttle-game"}
          >
            {pendingScuttleConfirm ? "Confirm Scuttle" : "Scuttle Game"}
          </button>
        </div>
        {pendingScuttleConfirm ? <p className="hint">This cancels the current lobby and opens a fresh one.</p> : null}
      </div>
      <div className="paper-panel player-selection-panel">
        <div className="section-heading-row">
          <h2>Selected Players</h2>
          {selectedCount > 1 ? (
            <button type="button" className="button secondary lobby-randomize" onClick={() => void randomizeSeats()} data-testid="randomize-seats">
              Randomize
            </button>
          ) : null}
        </div>
        {selectedPlayers.length ? (
          <ol className="seat-list">
            {selectedPlayers.map((player) => {
            const online = isHandleOnline(player.handle, context, presence, now);
            return (
              <li key={player.handle} data-testid={`seat-${player.handle}`} data-presence={online ? "online" : "offline"}>
                <span className="seat-primary" data-testid="seat-name">{player.displayName}</span>
                <span className="seat-meta">
                  <span className={`presence ${online ? "online" : "offline"}`} data-testid={`presence-${player.handle}`}>
                    {online ? "Online" : "Offline"}
                  </span>
                </span>
                <span className="seat-actions">
                  <button type="button" className="button icon-button" aria-label={`Move ${player.displayName} up`} onClick={() => void moveSeat(player.handle, "up")} data-testid={`seat-up-${player.handle}`}>
                    ^
                  </button>
                  <button type="button" className="button icon-button" aria-label={`Move ${player.displayName} down`} onClick={() => void moveSeat(player.handle, "down")} data-testid={`seat-down-${player.handle}`}>
                    v
                  </button>
                  <button type="button" className="button icon-button" aria-label={`Remove ${player.displayName}`} onClick={() => void selectPlayer(player.handle, false)} data-testid={`exclude-player-${player.handle}`}>
                    <X size={16} aria-hidden="true" />
                  </button>
                </span>
              </li>
            );
            })}
          </ol>
        ) : (
          <p className="subtle">Select 3-8 room members to start.</p>
        )}
        <div className="available-player-list">
          <h2>Available in Room</h2>
          {availableHandles.length ? (
            <ul className="seat-list">
              {availableHandles.map((handle) => {
                const online = isHandleOnline(handle.handle, context, presence, now);
                return (
                  <li key={handle.normalizedHandle} data-testid={`available-${handle.handle}`} data-presence={online ? "online" : "offline"}>
                    <span className="seat-primary">{handle.displayName}</span>
                    <span className="seat-meta">
                      <span className={`presence ${online ? "online" : "offline"}`}>{online ? "Online" : "Offline"}</span>
                    </span>
                    <button type="button" className="button secondary" onClick={() => void selectPlayer(handle.handle, true)} data-testid={`include-player-${handle.handle}`}>
                      Include
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="subtle">Everyone in the room is selected.</p>
          )}
        </div>
      </div>
      <History />
    </section>
  );
}

function StatusRail({ game, round, role }: { game: Game; round: Round; role: string }): React.ReactElement {
  const context = useGameStore((state) => state.context);
  const score = game.roundPoints.reduce((sum, value) => sum + value, 0);
  const currentPoints = pointsForDepth(true, round.depth);
  const ladder = [20, 10, 7, 5, 3];
  return (
    <aside className="status-rail">
      <div className="paper-panel status-card">
        <p className="eyebrow">Status</p>
        <div className="status-list">
          <div className="status-row">
            <span className="status-label">Round</span>
            <strong className="status-value">{round.roundNumber} of {game.totalRounds}</strong>
          </div>
          <div className="status-row">
            <span className="status-label">Role</span>
            <span className="status-value">
              <strong>{roleLabel(role)}</strong>
            </span>
          </div>
        </div>
        <div className="status-section">
          <span className="status-label">Earned</span>
          <div className="earned-score-row">
            {game.roundPoints.length ? (
              game.roundPoints.map((value, index) => (
                <span key={`${index}:${value}`} className={`token token-${value} earned-token`}>
                  {value}
                </span>
              ))
            ) : (
              <span className="subtle">No points yet</span>
            )}
          </div>
        </div>
        {game.roundPoints.length > 1 ? (
          <div className="status-total">
            <span>Total</span>
            <strong>{score}</strong>
          </div>
        ) : null}
        <div className="status-section" aria-label="Point ladder">
          <span className="status-label">Point Ladder</span>
          <div className="token-stack">
            {ladder.map((value) => (
              <span key={value} className={`token token-${value} ${value === currentPoints ? "current" : ""}`}>
                {value}
              </span>
            ))}
          </div>
        </div>
      </div>
      <PlayerKeyPanel game={game} />
      <HostControls game={game} />
      <HostRecoveryControls game={game} />
      <RoomResetControls game={game} />
    </aside>
  );
}

function RoomResetControls({ game }: { game: Game }): React.ReactElement | null {
  const context = useGameStore((state) => state.context);
  const scuttleGame = useGameStore((state) => state.scuttleGame);
  const pendingScuttleConfirm = useGameStore((state) => state.pendingScuttleConfirm);
  if (!context.handle || game.status === "complete" || game.status === "void") return null;
  return (
    <details className="paper-panel host-controls" data-testid="room-options">
      <summary>Room Options</summary>
      <div className="host-controls-body">
        <button
          type="button"
          className="button danger"
          onClick={() => void scuttleGame(pendingScuttleConfirm)}
          data-testid={pendingScuttleConfirm ? "confirm-scuttle-game" : "scuttle-game"}
        >
          {pendingScuttleConfirm ? "Confirm Scuttle" : "Scuttle Game"}
        </button>
        {pendingScuttleConfirm ? <p className="hint">This cancels this game and opens a fresh lobby.</p> : null}
      </div>
    </details>
  );
}

function HostControls({ game }: { game: Game }): React.ReactElement | null {
  const context = useGameStore((state) => state.context);
  const pauseGame = useGameStore((state) => state.pauseGame);
  const resumeGame = useGameStore((state) => state.resumeGame);
  const voidRound = useGameStore((state) => state.voidRound);
  const transferHost = useGameStore((state) => state.transferHost);
  const pendingVoidConfirm = useGameStore((state) => state.pendingVoidConfirm);
  const selectRef = useRef<HTMLSelectElement>(null);
  if (normalizeHandle(game.hostHandle) !== normalizeHandle(context.handle)) return null;
  return (
    <details className="paper-panel host-controls" data-testid="host-controls">
      <summary>Host Options</summary>
      <div className="host-controls-body">
        <div className="action-row">
          {game.pausedAt ? (
            <button type="button" className="button primary" onClick={() => void resumeGame()} data-testid="resume-game">
              Resume
            </button>
          ) : (
            <button type="button" className="button secondary" onClick={() => void pauseGame()} data-testid="pause-game">
              Pause
            </button>
          )}
          <button
            type="button"
            className="button danger"
            onClick={() => void voidRound(pendingVoidConfirm)}
            data-testid={pendingVoidConfirm ? "confirm-void-round" : "void-round"}
          >
            {pendingVoidConfirm ? "Confirm Void Round" : "Void Round"}
          </button>
        </div>
        {pendingVoidConfirm ? <p className="hint">This cancels the current round and records 0 points.</p> : null}
        <label>
          Transfer Host
          <select ref={selectRef} data-testid="host-transfer-select" defaultValue={game.hostHandle}>
            {game.players.map((player) => (
              <option key={player.handle} value={player.handle}>
                {player.displayName}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className="button" onClick={() => void transferHost(selectRef.current?.value ?? game.hostHandle)} data-testid="transfer-host-selected">
          Transfer
        </button>
      </div>
    </details>
  );
}

function HostRecoveryControls({ game }: { game: Game }): React.ReactElement | null {
  const context = useGameStore((state) => state.context);
  const roomState = useGameStore((state) => state.roomState);
  const presence = useGameStore((state) => state.presence);
  const now = useGameStore((state) => state.now);
  const claimHost = useGameStore((state) => state.claimHost);
  if (normalizeHandle(game.hostHandle) === normalizeHandle(context.handle)) return null;
  if (!playerForGame(game, context.handle)) return null;
  if (isHandleOnline(game.hostHandle, context, presence, now)) return null;
  return (
    <div className="paper-panel host-controls" data-testid="host-offline-panel">
      <h2>Host Offline</h2>
      <p className="subtle">{game.hostHandle} is offline.</p>
      <button type="button" className="button secondary" onClick={() => void claimHost()} data-testid="claim-host">
        Take Host
      </button>
    </div>
  );
}

function PhasePanel({ game, round, role }: { game: Game; round: Round; role: string }): React.ReactElement {
  const categoryTitle = round.categoryLabel || "Category";
  if (round.phase === "category-choice") {
    if (role === "guesser") return <CategoryChoice round={round} />;
    return <WaitPanel message="The guesser is choosing a category." />;
  }
  if (round.phase === "answer-entry") {
    if (role === "answerWriter") return <AnswerPanel categoryTitle={categoryTitle} />;
    return (
      <section className="paper-panel wait-panel">
        <p className="eyebrow">Category</p>
        <div className="phase-title-row">
          <div>
            <h1>{categoryTitle}</h1>
            <p className="subtle">The answer writer is choosing the answer.</p>
          </div>
        </div>
      </section>
    );
  }
  if (round.phase === "letter-entry") return <LetterEntryPanel game={game} round={round} role={role} categoryTitle={categoryTitle} />;
  if (round.phase === "guesser-call") return <GuesserCallPanel game={game} round={round} role={role} categoryTitle={categoryTitle} />;
  if (round.phase === "guess-judging") return <GuessJudgingPanel game={game} round={round} role={role} categoryTitle={categoryTitle} />;
  return <RoundRecap game={game} round={round} />;
}

function CategoryChoice({ round }: { round: Round }): React.ReactElement {
  const chooseCategory = useGameStore((state) => state.chooseCategory);
  return (
    <section className="paper-panel">
      <p className="eyebrow">Choose a Category</p>
      <h1>You are the guesser</h1>
      <p className="subtle">Choose a category. The answer writer will pick an answer inside it.</p>
      <div className="category-options">
        {round.categoryOptions.map((categoryId) => (
          <button type="button" key={categoryId} className="category-card" onClick={() => void chooseCategory(categoryId)} data-testid="category-option">
            <span>Category</span>
            <strong>{categoryLabel(categoryId)}</strong>
          </button>
        ))}
      </div>
    </section>
  );
}

function AnswerPanel({ categoryTitle }: { categoryTitle: string }): React.ReactElement {
  const submitAnswer = useGameStore((state) => state.submitAnswer);
  return (
    <section className="paper-panel">
      <p className="eyebrow">Category</p>
      <h1>{categoryTitle}</h1>
      <p className="subtle">You are the answer writer. Enter the answer the group will try to guess.</p>
      <form
        className="compact-form"
        onSubmit={(event) => {
          event.preventDefault();
          void submitAnswer(formValue(event.currentTarget, "answer-entry"));
        }}
      >
        <label>
          Answer
          <input name="answer-entry" autoComplete="off" maxLength={80} required data-testid="answer-input" />
        </label>
        <p className="hint">Long phrases and obscure proper nouns are hard to clue fairly.</p>
        <button type="submit" className="button primary" data-testid="submit-answer">
          Submit Answer
        </button>
      </form>
    </section>
  );
}

function LetterEntryPanel({ game, round, role, categoryTitle }: { game: Game; round: Round; role: string; categoryTitle: string }): React.ReactElement {
  const context = useGameStore((state) => state.context);
  const submitLetters = useGameStore((state) => state.submitLetters);
  const heldRows = rowsHeldByClueGiver(round, context.handle);
  const submittedCurrentDepth = round.entries.some((entry) => entry.depth === round.depth && sameHandle(entry.handle, context.handle));
  const rows = (
    <Rows
      game={game}
      round={round}
      revealAll={false}
      viewerHandle={context.handle}
      editableRows={heldRows}
      showLetterEntryState={true}
    />
  );
  return (
    <section className="paper-panel board-panel">
      <p className="eyebrow">Category</p>
      <h1>{categoryTitle}</h1>
      {role === "guesser" ? null : (
        <p className="answer-line">
          Answer: <strong>{round.answerRaw}</strong>
        </p>
      )}
      <p className="subtle">
        {role === "guesser"
          ? "The clue givers are adding letters."
          : heldRows.length
            ? "Add letters or skip. Use . for a word break."
            : submittedCurrentDepth
              ? "Submitted. Waiting for the other clue givers."
              : "Waiting for the other clue givers."}
      </p>
      {heldRows.length ? (
        <form
          className="letter-form inline-clue-form"
          onSubmit={(event) => {
            event.preventDefault();
            const form = event.currentTarget;
            const letters = new Map<number, ClueCellInput>();
            const formData = new FormData(form);
            for (const row of heldRows) {
              const skipped = formData.get(`blank-${row.rowIndex}`) === "1";
              const endsWord = formData.get(`end-${row.rowIndex}`) === "on";
              if (skipped) {
                letters.set(row.rowIndex, { skipped: true });
                continue;
              }
              const cells = Array.from(form.querySelectorAll<HTMLInputElement>(`[data-row-index="${row.rowIndex}"].clue-letter-input`))
                .map((input) => ({ depth: Number(input.dataset.depth ?? 0), letter: clampLetter(input.value) }))
                .filter((cell) => cell.depth > 0 && cell.letter);
              if (cells.length) letters.set(row.rowIndex, { cells, endsWord });
            }
            void submitLetters(letters);
          }}
        >
          {rows}
          <button className="button primary" type="submit" data-testid="submit-letters">
            Submit Clues
          </button>
        </form>
      ) : (
        rows
      )}
    </section>
  );
}

function GuesserCallPanel({ game, round, role, categoryTitle }: { game: Game; round: Round; role: string; categoryTitle: string }): React.ReactElement {
  const pendingGuess = useGameStore((state) => state.pendingGuess);
  const submitGuess = useGameStore((state) => state.submitGuess);
  const requestMoreLetters = useGameStore((state) => state.requestMoreLetters);
  const passRound = useGameStore((state) => state.passRound);
  const pendingPassConfirm = useGameStore((state) => state.pendingPassConfirm);
  const currentPoints = pointsForDepth(true, round.depth);
  return (
    <section className="paper-panel board-panel">
      <p className="eyebrow">Category</p>
      <h1>{categoryTitle}</h1>
      <p className="points-callout" data-testid="current-points">
        Guess now for {currentPoints} points.
      </p>
      <Rows game={game} round={round} revealAll={false} />
      {role === "guesser" ? (
        <>
          <form
            className="compact-form guess-form"
            onSubmit={(event) => {
              event.preventDefault();
              void submitGuess(formValue(event.currentTarget, "guess"), pendingGuess.length > 0);
            }}
          >
            <label>
              Guess
              <input name="guess" autoComplete="off" required data-testid="guess-input" defaultValue={pendingGuess} />
            </label>
            {pendingGuess ? (
              <>
                <p className="hint" data-testid="guess-confirmation">
                  Final guess. If it is wrong, this round scores 0.
                </p>
                <input type="hidden" name="confirmed" value="true" />
                <button className="button primary" type="submit" data-testid="confirm-guess">
                  Confirm Guess
                </button>
              </>
            ) : (
              <button className="button primary" type="submit" data-testid="submit-guess">
                Guess
              </button>
            )}
          </form>
          <div className="action-row">
            {round.depth < 5 ? (
              <button type="button" className="button secondary" onClick={() => void requestMoreLetters()} data-testid="one-more-letter">
                Reveal One More Letter
              </button>
            ) : null}
            <button
              type="button"
              className="button danger"
              onClick={() => void passRound(pendingPassConfirm)}
              data-testid={pendingPassConfirm ? "confirm-pass-round" : "pass-round"}
            >
              {pendingPassConfirm ? "Confirm Pass" : "Pass"}
            </button>
          </div>
          {pendingPassConfirm ? <p className="hint">Passing ends this round with 0 points.</p> : null}
        </>
      ) : (
        <>
          <p className="answer-line">
            Answer: <strong>{round.answerRaw}</strong>
          </p>
          <p className="subtle">The guesser is deciding.</p>
        </>
      )}
    </section>
  );
}

function GuessJudgingPanel({ game, round, role, categoryTitle }: { game: Game; round: Round; role: string; categoryTitle: string }): React.ReactElement {
  const judgeGuess = useGameStore((state) => state.judgeGuess);
  if (role === "answerWriter") {
    return (
      <section className="paper-panel">
        <p className="eyebrow">Judge the Guess</p>
        <h1>Accept this guess?</h1>
        <dl className="compare-list">
          <dt>Answer</dt>
          <dd>{round.answerRaw}</dd>
          <dt>Guess</dt>
          <dd>{round.guessRaw}</dd>
        </dl>
        <div className="action-row">
          <button type="button" className="button primary" onClick={() => void judgeGuess(true)} data-testid="accept-guess">
            Accept
          </button>
          <button type="button" className="button danger" onClick={() => void judgeGuess(false)} data-testid="reject-guess">
            Reject
          </button>
        </div>
      </section>
    );
  }
  if (role === "guesser") {
    return (
      <section className="paper-panel board-panel">
        <p className="eyebrow">Category</p>
        <h1>{categoryTitle}</h1>
        <Rows game={game} round={round} revealAll={false} />
        <dl className="compare-list">
          <dt>Guess</dt>
          <dd data-testid="judging-guess">{round.guessRaw}</dd>
        </dl>
        <p className="subtle">The answer writer is judging the guess.</p>
      </section>
    );
  }
  return (
    <section className="paper-panel wait-panel">
      <p className="answer-line">
        Answer: <strong>{round.answerRaw}</strong>
      </p>
      <p className="subtle">The answer writer is judging the guess.</p>
    </section>
  );
}

function RoundRecap({ game, round }: { game: Game; round: Round }): React.ReactElement {
  const context = useGameStore((state) => state.context);
  const advanceRound = useGameStore((state) => state.advanceRound);
  const isHost = normalizeHandle(game.hostHandle) === normalizeHandle(context.handle);
  return (
    <section className="paper-panel board-panel">
      <p className="eyebrow">Round Recap</p>
      <h1>{round.accepted ? recapLine(round.depth) : "No match this time."}</h1>
      <dl className="compare-list">
        <dt>Category</dt>
        <dd>{round.categoryLabel}</dd>
        <dt>Answer</dt>
        <dd data-testid="revealed-answer">{round.answerRaw}</dd>
        <dt>Guess</dt>
        <dd>{round.guessRaw || "Passed"}</dd>
        <dt>Points</dt>
        <dd>{round.points ?? 0}</dd>
      </dl>
      <p className="score-note" data-testid="running-final-score">
        Final score so far: {finalScore(game)} / 100
      </p>
      <Rows game={game} round={round} revealAll={true} />
      {isHost ? (
        <button type="button" className="button primary" onClick={() => void advanceRound()} data-testid="advance">
          {round.roundNumber >= game.totalRounds ? "Final Score" : "Next Round"}
        </button>
      ) : (
        <p className="subtle">Waiting for the host.</p>
      )}
    </section>
  );
}

function Final({ game }: { game: Game }): React.ReactElement {
  const summary = gameSummary(game);
  const copySummary = useGameStore((state) => state.copySummary);
  const createGame = useGameStore((state) => state.createGame);
  return (
    <section className="room-grid">
      <div className="paper-panel final-panel">
        <p className="eyebrow">Final Score</p>
        <h1>{finalScore(game)} / 100</h1>
        <div className="score-ledger">
          <p data-testid="all-round-points">
            <strong>Every Round:</strong> {game.roundPoints.join(", ") || "none"}
          </p>
          <p data-testid="counted-round-points">
            <strong>Counted Rounds:</strong> {topFive(game.roundPoints).join(", ") || "none"}
          </p>
        </div>
        <label>
          Summary
          <textarea className="summary-box" readOnly data-testid="summary-text" value={summary} />
        </label>
        <button type="button" className="button secondary" onClick={() => void copySummary()} data-testid="copy-summary">
          Copy Summary
        </button>
        <button type="button" className="button primary" onClick={() => void createGame()} data-testid="rematch">
          Rematch
        </button>
      </div>
      <Review game={game} />
    </section>
  );
}

function Review({ game }: { game: Game }): React.ReactElement {
  const context = useGameStore((state) => state.context);
  const leaveReview = useGameStore((state) => state.leaveReview);
  return (
    <section className="paper-panel review-panel" data-testid="review-panel">
      <div className="panel-header">
        <div>
          <p className="eyebrow">Room History</p>
          <h1>Game Review</h1>
        </div>
        {context.reviewGameId ? (
          <button type="button" className="button quiet" onClick={leaveReview}>
            Back
          </button>
        ) : null}
      </div>
      <p className="subtle" data-testid="review-final-score">
        Final score {finalScore(game)} / 100
      </p>
      <div className="review-list">
        {game.rounds.map((round) => (
          <article className="review-item" key={round.id}>
            <h2>Round {round.roundNumber}: {round.categoryLabel || "Category"}</h2>
            <p>
              Answer: <strong>{round.answerRaw || ""}</strong>
            </p>
            <p>Guess: {round.guessRaw || "Passed"} · Points {round.points ?? 0}</p>
            <Rows game={game} round={round} revealAll={true} />
            <PlayerLegend game={game} />
            <Replay game={game} round={round} />
          </article>
        ))}
      </div>
    </section>
  );
}

function Replay({ game, round }: { game: Game; round: Round }): React.ReactElement | null {
  const maxDepth = Math.max(0, ...round.entries.map((entry) => entry.depth));
  if (!maxDepth) return null;
  return (
    <div className="round-replay" data-testid={`round-replay-${round.roundNumber}`}>
      <h3>Replay</h3>
      {Array.from({ length: maxDepth }, (_, index) => {
        const depth = index + 1;
        return (
          <section className="replay-step" data-testid={`replay-step-${round.roundNumber}-${depth}`} key={depth}>
            <h4>Cell {depth}</h4>
            <Rows game={game} round={round} revealAll={true} maxVisibleDepth={depth} />
          </section>
        );
      })}
    </div>
  );
}

function Rows({
  game,
  round,
  revealAll,
  viewerHandle = "",
  maxVisibleDepth,
  editableRows = [],
  showLetterEntryState = false,
}: {
  game: Game;
  round: Round;
  revealAll: boolean;
  viewerHandle?: string;
  maxVisibleDepth?: number;
  editableRows?: Row[];
  showLetterEntryState?: boolean;
}): React.ReactElement {
  const context = useGameStore((state) => state.context);
  const viewer = viewerHandle || context.handle;
  const editableRowIndexes = new Set(editableRows.map((row) => row.rowIndex));
  return (
    <div className="rows" data-testid="rows">
      {round.rows.map((row) => {
        const limit = maxVisibleDepth ?? round.depth;
        const editable = editableRowIndexes.has(row.rowIndex);
        const isComplete = rowIsComplete(round, row.rowIndex);
        const hasCurrentEntry = round.entries.some((entry) => entry.rowIndex === row.rowIndex && entry.depth === round.depth);
        const showPendingCell = !revealAll && !isComplete && !hasCurrentEntry && round.phase === "letter-entry";
        const rowPen = penForHandle(game, row.currentHolderHandle);
        const trailingBlankDepths = new Set(
          editable && showPendingCell ? trailingBlankEntriesForRow(round, row.rowIndex).map((entry) => entry.depth) : [],
        );
        const entries = rowEntriesThroughDepth(round, row.rowIndex, limit)
          .filter(
            (entry) =>
              revealAll ||
              maxVisibleDepth !== undefined ||
              entry.revealed ||
              entry.depth < round.depth ||
              sameHandle(entry.handle, viewer) ||
              (showLetterEntryState && round.phase === "letter-entry" && entry.depth === round.depth),
          )
          .sort((a, b) => a.depth - b.depth);
        const cellCount = entries.length + (showPendingCell ? 1 : 0);
        return (
          <div
            className={`hint-row ${revealAll ? "reveal" : ""} ${isComplete ? "complete" : ""}`}
            key={row.rowIndex}
          >
            <div className="row-main">
              <div className="slots" aria-label={`Row ${row.rowIndex + 1}`} data-cell-count={cellCount}>
                {entries.map((entry) => {
                  const pen = penForHandle(game, entry.handle);
                  const filledAtDepth = entry.filledAtDepth ?? entry.depth;
                  const displayAsBlank =
                    entry.skipped ||
                    (maxVisibleDepth !== undefined && filledAtDepth > maxVisibleDepth) ||
                    (!revealAll && !entry.revealed && !sameHandle(entry.handle, viewer));
                  if (showPendingCell && trailingBlankDepths.has(entry.depth)) {
                    return (
                      <span className={`slot editing blank-fill pen-${rowPen.index}`} key={entry.depth} data-testid={`clue-cell-${row.rowIndex}-${entry.depth}`}>
                        <ClueCellInputControl rowIndex={row.rowIndex} depth={entry.depth} />
                      </span>
                    );
                  }
                  const wasFilledLater = !entry.skipped && filledAtDepth > entry.depth;
                  return (
                    <span
                      className={`slot filled frozen ${displayAsBlank ? "skipped" : ""} ${wasFilledLater ? "late-fill" : ""} pen-${pen.index}`}
                      key={entry.depth}
                      data-testid={`clue-cell-${row.rowIndex}-${entry.depth}`}
                      data-author={entry.handle}
                    >
                      <ClueCellText entry={entry} displayAsBlank={displayAsBlank} />
                    </span>
                  );
                })}
                {showPendingCell ? (
                  <span className={`slot ${editable ? "editing" : "pending"} pen-${rowPen.index}`} data-testid={`clue-cell-${row.rowIndex}-${round.depth}`}>
                    {editable ? <ClueCellInputControl rowIndex={row.rowIndex} depth={round.depth} /> : <span className="clue-placeholder" aria-hidden="true" />}
                  </span>
                ) : null}
              </div>
              {editable ? <RowEntryTools rowIndex={row.rowIndex} /> : null}
            </div>
            {!revealAll && showLetterEntryState ? (
              <span
                className="sr-only row-state"
                data-testid={`row-state-${row.rowIndex}`}
                data-state={letterEntryRowState(round, row, viewer).state}
              >
                {letterEntryRowState(round, row, viewer).label}
              </span>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function letterEntryRowState(
  round: Round,
  row: Row,
  viewerHandle: string,
): { label: string; state: "complete" | "submitted" | "waiting" | "editable" } {
  const entry = round.entries.find((item) => item.rowIndex === row.rowIndex && item.depth === round.depth);
  const complete = rowIsComplete(round, row.rowIndex);

  if (complete) return { label: "Complete", state: "complete" };
  if (!entry) {
    if (sameHandle(row.currentHolderHandle, viewerHandle)) return { label: "Your turn", state: "editable" };
    return { label: "Waiting", state: "waiting" };
  }
  return { label: "Ready", state: "submitted" };
}

function ClueCellInputControl({ rowIndex, depth }: { rowIndex: number; depth: number }): React.ReactElement {
  return (
    <span className="cell-editor" data-row-index={rowIndex}>
      <input
        name={`letter-${rowIndex}-${depth}`}
        className="clue-letter-input"
        maxLength={1}
        autoComplete="off"
        required
        aria-label={`Row ${rowIndex + 1} cell ${depth}`}
        data-row-index={rowIndex}
        data-depth={depth}
        data-testid={`letter-input-${rowIndex}`}
        onInput={(event) => {
          const input = event.currentTarget;
          if (input.value.trim() === "_") {
            setRowBlankMode(input, true);
            focusNextIncompleteLetter(input);
            return;
          }
          input.value = clampLetter(input.value);
          setRowBlankMode(input, false);
          if (input.value) focusNextIncompleteLetter(input);
        }}
        onKeyDown={(event) => {
          if (event.key !== ".") return;
          event.preventDefault();
          const checkbox = event.currentTarget.form?.elements.namedItem(`end-${rowIndex}`);
          if (checkbox instanceof HTMLInputElement) {
            checkbox.checked = !checkbox.checked;
            setEndWordMarker(checkbox);
          }
        }}
      />
    </span>
  );
}

function RowEntryTools({ rowIndex }: { rowIndex: number }): React.ReactElement {
  return (
    <div className="row-entry-tools">
      <input type="hidden" name={`blank-${rowIndex}`} value="0" data-testid={`skip-input-${rowIndex}`} />
      <div className="mode-toggle" aria-label={`Row ${rowIndex + 1} entry mode`}>
        <button
          type="button"
          className="mode-toggle-button"
          aria-pressed="true"
          data-testid={`letter-mode-${rowIndex}`}
          onClick={(event) => {
            const row = event.currentTarget.closest<HTMLElement>(".hint-row");
            const input = row?.querySelector<HTMLInputElement>(`.clue-letter-input[data-row-index="${rowIndex}"]`);
            if (!input) return;
            setRowBlankMode(input, false);
            input.focus({ preventScroll: true });
          }}
        >
          Letter
        </button>
        <button
          type="button"
          className="mode-toggle-button"
          aria-pressed="false"
          data-testid={`skip-cell-${rowIndex}`}
          onClick={(event) => {
            const row = event.currentTarget.closest<HTMLElement>(".hint-row");
            const input = row?.querySelector<HTMLInputElement>(`.clue-letter-input[data-row-index="${rowIndex}"]`);
            if (!input) return;
            setRowBlankMode(input, true);
            focusNextIncompleteLetter(input);
          }}
        >
          Skip
        </button>
      </div>
      <button
        type="button"
        className="period-toggle"
        aria-label={`End word after row ${rowIndex + 1} letter`}
        aria-pressed="false"
        title="End word"
        onClick={(event) => {
          const checkbox = event.currentTarget.nextElementSibling;
          if (!(checkbox instanceof HTMLInputElement) || checkbox.disabled) return;
          checkbox.checked = !checkbox.checked;
          setEndWordMarker(checkbox);
        }}
      >
        .
      </button>
      <input
        className="visually-hidden end-word-input"
        type="checkbox"
        name={`end-${rowIndex}`}
        data-testid={`word-end-${rowIndex}`}
        onChange={(event) => setEndWordMarker(event.currentTarget)}
      />
    </div>
  );
}

function ClueCellText({ entry, displayAsBlank }: { entry: ClueEntry; displayAsBlank: boolean }): React.ReactElement {
  if (displayAsBlank) {
    return <span className="clue-blank" aria-label={`Blank by ${entry.handle}`} />;
  }
  return (
    <span className="clue-letter" aria-label={`${entry.letter}${entry.endsWord ? " word end" : ""} by ${entry.handle}`}>
      {entry.letter}
      {entry.endsWord ? <span className="cell-period" aria-hidden="true">.</span> : null}
    </span>
  );
}

function PlayerKeyPanel({ game }: { game: Game }): React.ReactElement {
  const context = useGameStore((state) => state.context);
  const round = currentRound(game);
  return (
    <section className="paper-panel player-key-panel" data-testid="player-key">
      <p className="eyebrow">Players</p>
      {round ? <PlayerLegend game={game} round={round} viewerHandle={context.handle} /> : <PlayerLegend game={game} />}
    </section>
  );
}

function PlayerLegend({ game, round, viewerHandle = "" }: { game: Game; round?: Round; viewerHandle?: string }): React.ReactElement {
  return (
    <div className="player-legend" data-testid="player-legend" aria-label="Player pen styles">
      {game.players.map((player) => {
        const pen = penForHandle(game, player.handle);
        const status = playerTurnStatus(round, player.handle, viewerHandle);
        return (
          <span key={player.handle} className="legend-item" style={penStyleVars(pen)}>
            <span className={`legend-sample pen-${pen.index}`} aria-hidden="true" />
            <span className="legend-name">{player.displayName}</span>
            {status ? <span className="legend-status">{status}</span> : null}
          </span>
        );
      })}
    </div>
  );
}

function playerTurnStatus(round: Round | undefined, handle: string, viewerHandle: string): string {
  if (!round || round.phase !== "letter-entry") return "";
  const normalizedHandle = normalizeHandle(handle);
  const heldRows = round.rows.filter((row) => normalizeHandle(row.currentHolderHandle) === normalizedHandle);
  if (!heldRows.length) return "";
  const waiting = heldRows.some((row) => !round.entries.some((entry) => entry.rowIndex === row.rowIndex && entry.depth === round.depth));
  if (waiting) return sameHandle(handle, viewerHandle) ? "Your turn" : "Waiting";
  return "Ready";
}

function History(): React.ReactElement {
  const roomState = useGameStore((state) => state.roomState);
  const reviewGame = useGameStore((state) => state.reviewGame);
  const completeGames = [...(roomState?.games ?? [])].filter((game) => game.status === "complete").sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0));
  return (
    <div className="paper-panel">
      <h2>Room History</h2>
      {completeGames.length ? (
        <ul className="history-list">
          {completeGames.map((game) => (
            <li key={game.id}>
              <span>Game {new Date(game.createdAt).toLocaleDateString()}</span>
              <button type="button" className="button quiet" onClick={() => reviewGame(game.id)}>
                Review {finalScore(game)}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="subtle">No completed games in this room yet.</p>
      )}
    </div>
  );
}

function WaitPanel({ message }: { message: string }): React.ReactElement {
  return (
    <section className="paper-panel wait-panel">
      <h1>{message}</h1>
    </section>
  );
}

function handleRootKeyDown(event: React.KeyboardEvent<HTMLElement>): void {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  if (event.key === "Enter" && target instanceof HTMLInputElement && target.form) {
    if (target.form.classList.contains("letter-form")) {
      const nextIncomplete = nextIncompleteLetterInput(target);
      if (nextIncomplete) {
        event.preventDefault();
        nextIncomplete.focus({ preventScroll: true });
        return;
      }
    }
    event.preventDefault();
    target.form.requestSubmit();
    return;
  }
  if (event.key !== "Enter" && event.key !== " ") return;
  const button = target.closest<HTMLButtonElement>("button");
  if (!button || button.disabled || button.getAttribute("aria-disabled") === "true") return;
  event.preventDefault();
  if (button.type === "submit" && button.form) button.form.requestSubmit(button);
  else button.click();
}

function setEndWordMarker(checkbox: HTMLInputElement): void {
  const row = checkbox.closest<HTMLElement>(".hint-row");
  const editors = row ? Array.from(row.querySelectorAll<HTMLElement>(".cell-editor")) : [];
  const editor = editors.at(-1);
  if (editor) editor.dataset.endWord = checkbox.checked ? "true" : "false";
  const periodButton = checkbox.previousElementSibling;
  if (periodButton instanceof HTMLButtonElement) {
    periodButton.setAttribute("aria-pressed", checkbox.checked ? "true" : "false");
  }
}

function setRowBlankMode(input: HTMLInputElement, skipped: boolean): void {
  const row = input.closest<HTMLElement>(".hint-row");
  const rowIndex = input.dataset.rowIndex ?? "";
  const skipInput = row?.querySelector<HTMLInputElement>(`[data-testid="skip-input-${rowIndex}"]`);
  const endWord = row?.querySelector<HTMLInputElement>('input[name^="end-"]');
  const letterModeButton = row?.querySelector<HTMLButtonElement>(`[data-testid="letter-mode-${rowIndex}"]`);
  const skipButton = row?.querySelector<HTMLButtonElement>(`[data-testid="skip-cell-${rowIndex}"]`);
  const periodButton = row?.querySelector<HTMLButtonElement>(".period-toggle");
  const inputs = row ? Array.from(row.querySelectorAll<HTMLInputElement>(`.clue-letter-input[data-row-index="${rowIndex}"]`)) : [];
  if (skipInput) skipInput.value = skipped ? "1" : "0";
  if (row) row.dataset.blankMode = skipped ? "true" : "false";
  letterModeButton?.setAttribute("aria-pressed", skipped ? "false" : "true");
  skipButton?.setAttribute("aria-pressed", skipped ? "true" : "false");
  for (const rowInput of inputs) {
    const slot = rowInput.closest<HTMLElement>(".slot");
    if (slot) slot.dataset.skipped = skipped ? "true" : "false";
    if (skipped) rowInput.value = "";
    rowInput.readOnly = skipped;
    rowInput.required = !skipped;
  }
  if (endWord && skipped) {
    endWord.checked = false;
    endWord.disabled = skipped;
    setEndWordMarker(endWord);
  } else if (endWord) {
    endWord.disabled = false;
  }
  if (periodButton) periodButton.disabled = skipped;
}

function focusNextIncompleteLetter(input: HTMLInputElement): void {
  const next = nextIncompleteLetterInput(input);
  if (next) {
    next.focus({ preventScroll: true });
    return;
  }
  input.form?.querySelector<HTMLButtonElement>('[data-testid="submit-letters"]')?.focus({ preventScroll: true });
}

function nextIncompleteLetterInput(current: HTMLInputElement): HTMLInputElement | undefined {
  const form = current.form;
  if (!form) return undefined;
  const inputs = Array.from(form.querySelectorAll<HTMLInputElement>('input[name^="letter-"]'));
  const afterCurrent = inputs.slice(inputs.indexOf(current) + 1);
  const beforeCurrent = inputs.slice(0, inputs.indexOf(current));
  return [...afterCurrent, ...beforeCurrent].find((input) => {
    if (input === current) return false;
    return !input.disabled && !input.readOnly && !input.value.trim();
  });
}

function useAutoFocus(): void {
  const context = useGameStore((state) => state.context);
  const roomState = useGameStore((state) => state.roomState);
  const pendingGuess = useGameStore((state) => state.pendingGuess);
  const focusTarget = useGameStore((state) => state.focusTarget);
  const helpOpen = useGameStore((state) => state.helpOpen);
  const clearFocusTarget = useGameStore((state) => state.clearFocusTarget);
  useLayoutEffect(() => {
    if (helpOpen) return;
    if (focusTarget) {
      focusByTestId(focusTarget);
      clearFocusTarget();
      return;
    }
    if (isEditableElement(document.activeElement)) return;
    focusPrimaryAction();
  }, [context.roomSlug, context.handle, context.reviewGameId, roomState, pendingGuess, focusTarget, helpOpen, clearFocusTarget]);
}

async function dispatch(result: CommandResult, set: (partial: Partial<GameState>) => void, get: () => GameState): Promise<void> {
  if (!result.ok) {
    set({ error: result.error });
    return;
  }
  set({ error: "" });
  await get().runtime.eventStore.append(result.events);
}

async function dispatchOnce(
  name: string,
  makeResult: () => CommandResult,
  set: (partial: Partial<GameState>) => void,
  get: () => GameState,
): Promise<void> {
  const key = commandKey(name, get());
  const runtime = get().runtime;
  if (runtime.pendingCommands.has(key)) return;
  runtime.pendingCommands.add(key);
  try {
    await dispatch(makeResult(), set, get);
  } finally {
    runtime.pendingCommands.delete(key);
  }
}

function commandKey(name: string, state: GameState): string {
  const game = state.roomState ? activeGame(state.roomState) : undefined;
  const round = game ? currentRound(game) : undefined;
  return [name, state.context.handle, game?.id ?? "room", round?.id ?? "none", game?.phaseVersion ?? 0, round?.depth ?? 0].join(":");
}

function requiredRoomState(get: () => GameState): RoomState {
  const state = get().roomState;
  if (!state) throw new Error("Room state is not loaded.");
  return state;
}

function readContextFromLocation(state: Pick<GameState, "rememberedRooms" | "lastHandle">): AppContext {
  const url = new URL(window.location.href);
  const roomSlug = roomSlugFrom(url.searchParams.get("room") ?? "");
  const handleFromUrl = url.searchParams.get("handle")?.trim() ?? "";
  const rememberedHandle = state.rememberedRooms.find((room) => room.roomSlug === roomSlug)?.handle ?? "";
  const handle = handleFromUrl || rememberedHandle || "";
  const reviewGameId = url.searchParams.get("review");
  return reviewGameId ? { roomSlug, handle, reviewGameId } : { roomSlug, handle };
}

function currentRoomLink(roomSlug: string): string {
  const url = new URL(window.location.href);
  url.search = "";
  url.hash = "";
  url.searchParams.set("room", roomSlug);
  return url.toString();
}

function formValue(form: HTMLFormElement, name: string): string {
  const value = new FormData(form).get(name);
  return typeof value === "string" ? value.trim() : "";
}

function roleLabel(role: string): string {
  if (role === "guesser") return "Guesser";
  if (role === "answerWriter") return "Answer Writer";
  if (role === "clueGiver") return "Clue Giver";
  return "Observer";
}

function lobbyRolePreview(game: Game): string {
  const players = [...game.players].sort((a, b) => a.seatNumber - b.seatNumber);
  if (players.length < 3) return "";
  const guesser = players[0];
  const answerWriter = players[1];
  const clueGivers = players.slice(1).map((player) => player.displayName);
  if (!guesser || !answerWriter) return "";
  return `First round: ${guesser.displayName} guesses, ${answerWriter.displayName} writes the answer, ${clueGivers.join(", ")} give clues.`;
}

function sameHandle(left: string, right: string): boolean {
  return normalizeHandle(left) === normalizeHandle(right);
}

function recapLine(depth: number): string {
  if (depth === 1) return "Solved on the first reveal.";
  if (depth <= 3) return "Solved from a few letters.";
  return "Solved just in time.";
}

function topFive(roundPoints: number[]): number[] {
  return [...roundPoints].sort((a, b) => b - a).slice(0, 5);
}

function penForHandle(game: Game, handle: string): PenStyle {
  const normalizedHandle = normalizeHandle(handle);
  const orderedPlayers = [...game.players].sort((a, b) => a.seatNumber - b.seatNumber);
  const playerIndex = orderedPlayers.findIndex((player) => player.normalizedHandle === normalizedHandle);
  const index = playerIndex >= 0 ? playerIndex : hashString(normalizedHandle);
  return { index: index % 8 };
}

function penStyleVars(pen: PenStyle): React.CSSProperties {
  return { "--pen-index": pen.index } as React.CSSProperties;
}

function hashString(value: string): number {
  let hash = 0;
  for (const char of value) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash;
}

function playerForGame(game: Game, handle: string): boolean {
  return game.players.some((player) => player.normalizedHandle === normalizeHandle(handle));
}

function isHandleOnline(handle: string, context: AppContext, presence: RoomPresence[], now: number): boolean {
  if (normalizeHandle(handle) === normalizeHandle(context.handle)) return true;
  const roomPresence = presence.find((item) => item.normalizedHandle === normalizeHandle(handle));
  return Boolean(roomPresence && now - roomPresence.lastSeenAt <= PRESENCE_ONLINE_MS);
}

function focusPrimaryAction(): void {
  const selectors = [
    '[data-testid="room-input"]',
    '[data-testid="handle-input"]',
    '[data-testid="start-game"]:not(:disabled)',
    '[data-testid^="include-player-"]',
    '[data-testid="category-option"]',
    '[data-testid="answer-input"]',
    '[data-testid^="letter-input-"]',
    '[data-testid="confirm-guess"]',
    '[data-testid="guess-input"]',
    '[data-testid="accept-guess"]',
    '[data-testid="advance"]',
    '[data-testid="resume-game"]',
  ];
  for (const selector of selectors) {
    const element = document.querySelector<HTMLElement>(selector);
    if (!element || !isFocusable(element)) continue;
    element.focus({ preventScroll: true });
    return;
  }
}

function focusByTestId(testId: string): boolean {
  for (const element of document.querySelectorAll<HTMLElement>("[data-testid]")) {
    if (element.dataset.testid !== testId || !isFocusable(element)) continue;
    element.focus({ preventScroll: true });
    return true;
  }
  return false;
}

function isEditableElement(element: Element | null): boolean {
  return (
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement ||
    element instanceof HTMLSelectElement ||
    (element instanceof HTMLElement && element.isContentEditable)
  );
}

function isFocusable(element: HTMLElement): boolean {
  if (element instanceof HTMLButtonElement && element.disabled) return false;
  if (element instanceof HTMLInputElement && element.disabled) return false;
  if (element instanceof HTMLSelectElement && element.disabled) return false;
  if (element instanceof HTMLTextAreaElement && element.disabled) return false;
  if (element.getAttribute("aria-disabled") === "true") return false;
  return element.getClientRects().length > 0;
}

function gameSummary(game: Game): string {
  const points = game.roundPoints.map((pointValue, index) => `Round ${index + 1}: ${pointValue}`).join(", ");
  return `Final Score ${finalScore(game)} / 100\nBest five rounds: ${topFive(game.roundPoints).join(", ") || "none"}\n${points || "No rounds yet."}`;
}

export function startApp(): void {
  const root = document.getElementById("app");
  if (!root) throw new Error("Missing element #app");
  createRoot(root).render(<CowslipApp />);
}
