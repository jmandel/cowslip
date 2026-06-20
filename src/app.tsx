import React, { useEffect, useLayoutEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import { Check, CircleHelp, Copy, Home, UserPen, X } from "lucide-react";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { STARTER_FIELDS, fieldLabel } from "./content/fields";
import {
  activeGame,
  commandAdjudicate,
  commandAdvanceAfterRecap,
  commandClaimHost,
  commandChooseField,
  commandClaimHandle,
  commandCreateSeason,
  commandGuess,
  commandJoinSeason,
  commandMarkHandleSeen,
  commandMoveSeat,
  commandPauseSeason,
  commandPlantLetters,
  commandPlantSeed,
  commandRandomizeSeats,
  commandResumeSeason,
  commandSetReady,
  commandSpoil,
  commandStartSeason,
  commandTransferHost,
  commandTrySprout,
  commandVoidHarvest,
  commandWait,
  currentRound,
  finalScore,
  normalizeHandle,
  reduceEvents,
  roleForHandle,
  rowIsComplete,
  rowsHeldForClue,
  roomSlugFrom,
} from "./game/model";
import { clampLetter, pointsForDepth } from "./game/rules";
import type { ClueCellInput, CommandResult, Game, RoomState, Round, Row } from "./game/types";
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

type SowsEarRuntime = {
  eventStore: EventStore;
  unsubscribeEvents: (() => void) | undefined;
  seenInterval: number | undefined;
  copyResetTimer: number | undefined;
  pendingClaims: Set<string>;
  pendingLobbyJoins: Set<string>;
  pendingSprouts: Set<string>;
  pendingSeen: Set<string>;
  pendingCommands: Set<string>;
  lastSeenSentAt: Map<string, number>;
};

type SowsEarState = {
  context: AppContext;
  roomState: RoomState | undefined;
  rememberedRooms: RememberedRoom[];
  lastHandle: string;
  runtime: SowsEarRuntime;
  error: string;
  copyStatus: "idle" | "copied" | "failed";
  pendingGuess: string;
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
  openRoom(roomSlug: string): void;
  leaveRoom(): void;
  claimHandle(handle: string): Promise<void>;
  switchHandle(): void;
  createSeason(): Promise<void>;
  joinSeason(): Promise<void>;
  toggleReady(): Promise<void>;
  startSeason(): Promise<void>;
  moveSeat(handle: string, direction: "up" | "down"): Promise<void>;
  randomizeSeats(): Promise<void>;
  pauseSeason(): Promise<void>;
  resumeSeason(): Promise<void>;
  voidHarvest(): Promise<void>;
  transferHost(nextHost: string): Promise<void>;
  claimHost(): Promise<void>;
  chooseField(fieldId: string): Promise<void>;
  plantSeed(seed: string): Promise<void>;
  plantLetters(letters: Map<number, string | ClueCellInput>): Promise<void>;
  wait(): Promise<void>;
  spoil(): Promise<void>;
  submitGuess(guess: string, confirmed: boolean): Promise<void>;
  adjudicate(accepted: boolean): Promise<void>;
  advance(): Promise<void>;
  copySummary(): Promise<void>;
  reviewGame(gameId: string): void;
  leaveReview(): void;
  openHelp(): void;
  closeHelp(): void;
  clearFocusTarget(): void;
  rememberRoom(roomSlug: string, handle: string): void;
  ensureHandleClaimed(): Promise<void>;
  ensureHandleSeen(force?: boolean): Promise<void>;
  ensureLobbyJoined(): Promise<void>;
  ensureRowsSprouted(): Promise<void>;
};

const APP_STORAGE_KEY = "sowsear:app";
const PRESENCE_HEARTBEAT_MS = 15000;
const PRESENCE_ONLINE_MS = 45000;
const PEN_COLORS = ["#000000", "#0072b2", "#d55e00", "#009e73", "#cc79a7", "#e69f00", "#56b4e9", "#5f5f5f"] as const;

type PenStyle = {
  index: number;
  color: string;
};

function createRuntime(): SowsEarRuntime {
  return {
    eventStore: createEventStore(),
    unsubscribeEvents: undefined,
    seenInterval: undefined,
    copyResetTimer: undefined,
    pendingClaims: new Set(),
    pendingLobbyJoins: new Set(),
    pendingSprouts: new Set(),
    pendingSeen: new Set(),
    pendingCommands: new Set(),
    lastSeenSentAt: new Map(),
  };
}

const useSowsEarStore = create<SowsEarState>()(persist((set, get) => {
  const runtime = createRuntime();
  return {
  context: { roomSlug: "", handle: "" },
  roomState: undefined,
  rememberedRooms: [],
  lastHandle: "",
  runtime,
  error: "",
  copyStatus: "idle",
  pendingGuess: "",
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
    if (runtime.seenInterval) window.clearInterval(runtime.seenInterval);
    runtime.seenInterval = undefined;
    set({ context: next, roomState: undefined, error: "", pendingGuess: "", now: Date.now() });

    if (!next.roomSlug) return;
    get().rememberRoom(next.roomSlug, next.handle);
    runtime.unsubscribeEvents = runtime.eventStore.subscribe(next.roomSlug, (events) => {
      const roomState = reduceEvents(next.roomSlug, events);
      set({ roomState, now: Date.now() });
      void get().ensureHandleClaimed();
      void get().ensureHandleSeen();
      void get().ensureLobbyJoined();
      void get().ensureRowsSprouted();
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

  openRoom(roomSlug) {
    get().setUrl({ room: roomSlug, handle: undefined, review: undefined });
  },

  leaveRoom() {
    get().setUrl({ room: undefined, handle: undefined, review: undefined });
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

  async createSeason() {
    await dispatchOnce("create-season", () => commandCreateSeason(requiredRoomState(get), get().context.handle), set, get);
  },

  async joinSeason() {
    await dispatchOnce("join-season", () => commandJoinSeason(requiredRoomState(get), get().context.handle), set, get);
  },

  async toggleReady() {
    await dispatchOnce("toggle-ready", () => {
      const state = requiredRoomState(get);
      const game = activeGame(state);
      const me = game?.players.find((player) => player.normalizedHandle === normalizeHandle(get().context.handle));
      return commandSetReady(state, get().context.handle, !me?.ready);
    }, set, get);
  },

  async startSeason() {
    await dispatchOnce("start-season", () => commandStartSeason(requiredRoomState(get), get().context.handle), set, get);
  },

  async moveSeat(handle, direction) {
    await dispatchOnce(`move-seat:${handle}:${direction}`, () => commandMoveSeat(requiredRoomState(get), get().context.handle, handle, direction), set, get);
  },

  async randomizeSeats() {
    await dispatchOnce("randomize-seats", () => commandRandomizeSeats(requiredRoomState(get), get().context.handle), set, get);
  },

  async pauseSeason() {
    await dispatchOnce("pause-season", () => commandPauseSeason(requiredRoomState(get), get().context.handle), set, get);
  },

  async resumeSeason() {
    await dispatchOnce("resume-season", () => commandResumeSeason(requiredRoomState(get), get().context.handle), set, get);
  },

  async voidHarvest() {
    await dispatchOnce("void-harvest", () => commandVoidHarvest(requiredRoomState(get), get().context.handle), set, get);
  },

  async transferHost(nextHost) {
    await dispatchOnce(`transfer-host:${nextHost}`, () => commandTransferHost(requiredRoomState(get), get().context.handle, nextHost), set, get);
  },

  async claimHost() {
    await dispatchOnce("claim-host", () => commandClaimHost(requiredRoomState(get), get().context.handle), set, get);
  },

  async chooseField(fieldId) {
    await dispatchOnce(`choose-field:${fieldId}`, () => commandChooseField(requiredRoomState(get), get().context.handle, fieldId), set, get);
  },

  async plantSeed(seed) {
    await dispatchOnce("seed", () => commandPlantSeed(requiredRoomState(get), get().context.handle, seed), set, get);
  },

  async plantLetters(letters) {
    await dispatchOnce("letters", () => commandPlantLetters(requiredRoomState(get), get().context.handle, letters), set, get);
  },

  async wait() {
    await dispatchOnce("wait", () => commandWait(requiredRoomState(get), get().context.handle), set, get);
  },

  async spoil() {
    await dispatchOnce("spoil", () => commandSpoil(requiredRoomState(get), get().context.handle), set, get);
  },

  async submitGuess(guess, confirmed) {
    if (!confirmed) {
      set({ pendingGuess: guess, focusTarget: "confirm-guess" });
      return;
    }
    const pendingGuess = get().pendingGuess;
    set({ pendingGuess: "" });
    await dispatchOnce("guess", () => commandGuess(requiredRoomState(get), get().context.handle, pendingGuess || guess), set, get);
  },

  async adjudicate(accepted) {
    await dispatchOnce(`adjudicate:${accepted}`, () => commandAdjudicate(requiredRoomState(get), get().context.handle, accepted), set, get);
  },

  async advance() {
    await dispatchOnce("advance", () => commandAdvanceAfterRecap(requiredRoomState(get), get().context.handle), set, get);
  },

  async copySummary() {
    const game = activeGame(requiredRoomState(get));
    if (!game) return;
    try {
      await navigator.clipboard?.writeText(seasonSummary(game));
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
    const result = commandMarkHandleSeen(roomState, context.handle);
    if (!result.ok || !result.events.length) return;
    runtime.pendingSeen.add(key);
    runtime.lastSeenSentAt.set(key, now);
    try {
      await runtime.eventStore.append(result.events);
    } finally {
      runtime.pendingSeen.delete(key);
    }
  },

  async ensureLobbyJoined() {
    const { context, roomState } = get();
    if (!roomState || !context.handle) return;
    const runtime = get().runtime;
    const game = activeGame(roomState);
    if (!game || game.status !== "lobby") return;
    if (playerForGame(game, context.handle)) return;
    const key = `${game.id}:${normalizeHandle(context.handle)}`;
    if (runtime.pendingLobbyJoins.has(key)) return;
    const result = commandJoinSeason(roomState, context.handle);
    if (!result.ok) {
      set({ error: result.error });
      return;
    }
    if (!result.events.length) return;
    runtime.pendingLobbyJoins.add(key);
    try {
      await runtime.eventStore.append(result.events);
    } finally {
      runtime.pendingLobbyJoins.delete(key);
    }
  },

  async ensureRowsSprouted() {
    const { context, roomState } = get();
    if (!roomState || !context.handle) return;
    const runtime = get().runtime;
    const game = activeGame(roomState);
    const round = game ? currentRound(game) : undefined;
    if (!game || !round || round.phase !== "planting") return;
    const key = `${game.id}:${round.id}:${round.depth}:${game.phaseVersion}`;
    if (runtime.pendingSprouts.has(key)) return;
    const result = commandTrySprout(roomState, context.handle);
    if (!result.ok || !result.events.length) return;
    runtime.pendingSprouts.add(key);
    try {
      await runtime.eventStore.append(result.events);
    } finally {
      runtime.pendingSprouts.delete(key);
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

function SowsEarApp(): React.ReactElement {
  const context = useSowsEarStore((state) => state.context);
  const roomState = useSowsEarStore((state) => state.roomState);
  const error = useSowsEarStore((state) => state.error);
  const initialize = useSowsEarStore((state) => state.initialize);
  const shutdown = useSowsEarStore((state) => state.shutdown);
  const syncFromLocation = useSowsEarStore((state) => state.syncFromLocation);

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
  let hideHeaderBrand = false;
  if (!context.roomSlug) {
    hideHeaderBrand = true;
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
    body = review ? <Review game={review} /> : game ? <GameView game={game} /> : <RoomHome />;
  }

  return (
    <main className="app-shell" onKeyDown={handleRootKeyDown}>
      <Shell hideHeaderBrand={hideHeaderBrand} />
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

function Shell({ hideHeaderBrand }: { hideHeaderBrand?: boolean }): React.ReactElement {
  const context = useSowsEarStore((state) => state.context);
  const openHelp = useSowsEarStore((state) => state.openHelp);
  const copyRoom = useSowsEarStore((state) => state.copyRoom);
  const leaveRoom = useSowsEarStore((state) => state.leaveRoom);
  const switchHandle = useSowsEarStore((state) => state.switchHandle);
  const copyStatus = useSowsEarStore((state) => state.copyStatus);
  const hasRoomContext = Boolean(context.roomSlug || context.handle);
  return (
    <header className={`topbar ${hideHeaderBrand ? "topbar-minimal" : ""}`}>
      {hideHeaderBrand ? (
        <div />
      ) : (
        <div className="topbar-brand">
          <a className="wordmark" href="./" aria-label="Sow's Ear">
            <img src="./assets/brand-title-header.png" alt="" />
          </a>
        </div>
      )}
      <div className="topbar-global-actions">
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
                <button type="button" className="button icon-button topbar-icon-button" aria-label="Room switcher" title="Room switcher" onClick={leaveRoom} data-testid="leave-room">
                  <Home aria-hidden="true" size={19} strokeWidth={2.5} />
                </button>
              ) : null}
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
      <span className="topbar-chip-value">{value}</span>
    </span>
  );
}

function HelpDialog(): React.ReactElement {
  const helpOpen = useSowsEarStore((state) => state.helpOpen);
  const closeHelp = useSowsEarStore((state) => state.closeHelp);
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
            <p>Work together to help the guesser name the picker&apos;s answer from a category and a few clue cells.</p>
          </section>
          <section>
            <h2>Roles</h2>
            <p>The guesser sees the category and makes the guess. The picker enters the answer. Every non-guesser adds one letter to each row they hold.</p>
          </section>
          <section>
            <h2>Round</h2>
            <p>Each row can grow to five cells. A cluer may mark the current cell with a period to end that row. The guesser may guess after each reveal, ask for one more cell, or pass.</p>
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
  const setUrl = useSowsEarStore((state) => state.setUrl);
  const openRoom = useSowsEarStore((state) => state.openRoom);
  const rememberedRooms = useSowsEarStore((state) => state.rememberedRooms);
  return (
    <section className="hero">
      <div className="brand-lockup">
        <img src="./assets/brand-pig.png" alt="" className="brand-pig" />
        <div className="brand-copy">
          <img src="./assets/brand-title.png" alt="Sow's Ear" className="brand-title" />
          <p>A cooperative word game where every letter counts.</p>
        </div>
      </div>
      <div className="room-entry-stack">
        <form
          className="paper-panel compact-form room-entry-card"
          onSubmit={(event) => {
            event.preventDefault();
            const roomSlug = roomSlugFrom(formValue(event.currentTarget, "room"));
            if (roomSlug) setUrl({ room: roomSlug, review: undefined });
          }}
        >
          <h2 className="card-title">Room</h2>
          <label className="field-control">
            <span className="sr-only">Room</span>
            <input name="room" autoComplete="off" placeholder="farm-night" required data-testid="room-input" />
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
                <button type="button" className="remembered-room" key={room.roomSlug} onClick={() => openRoom(room.roomSlug)} data-testid={`remembered-room-${room.roomSlug}`}>
                  <strong>{room.roomSlug}</strong>
                  {room.handle ? <span>{room.handle}</span> : <span>Choose a name</span>}
                </button>
              ))}
            </div>
          </section>
        ) : null}
      </div>
    </section>
  );
}

function HandleClaim(): React.ReactElement {
  const claimHandle = useSowsEarStore((state) => state.claimHandle);
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
            <input name="handle" autoComplete="nickname" maxLength={32} placeholder="Alice" required data-testid="handle-input" />
          </label>
          <button type="submit" className="button primary" data-testid="claim-handle">
            Join Room
          </button>
        </form>
      </div>
      <img src="./assets/brand-pig.png" alt="" className="handle-mascot" />
    </section>
  );
}

function RoomHome(): React.ReactElement {
  const createSeason = useSowsEarStore((state) => state.createSeason);
  return (
    <section className="room-grid">
      <div className="paper-panel">
        <h1>Start a Game</h1>
        <p className="subtle">Create a new game, or review an earlier one.</p>
        <div className="action-row">
          <button type="button" className="button primary" onClick={() => void createSeason()} data-testid="create-season">
            Start Game
          </button>
        </div>
      </div>
      <History />
    </section>
  );
}

function GameView({ game }: { game: Game }): React.ReactElement {
  const context = useSowsEarStore((state) => state.context);
  const resumeSeason = useSowsEarStore((state) => state.resumeSeason);
  if (game.status === "lobby") return <Lobby game={game} />;
  if (game.phase === "final") return <Final game={game} />;
  const round = currentRound(game);
  if (!round) return <RoomHome />;
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
              <button type="button" className="button primary" onClick={() => void resumeSeason()} data-testid="resume-season">
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
  const context = useSowsEarStore((state) => state.context);
  const roomState = useSowsEarStore((state) => state.roomState);
  const now = useSowsEarStore((state) => state.now);
  const joinSeason = useSowsEarStore((state) => state.joinSeason);
  const toggleReady = useSowsEarStore((state) => state.toggleReady);
  const startSeason = useSowsEarStore((state) => state.startSeason);
  const claimHost = useSowsEarStore((state) => state.claimHost);
  const randomizeSeats = useSowsEarStore((state) => state.randomizeSeats);
  const moveSeat = useSowsEarStore((state) => state.moveSeat);
  const transferHost = useSowsEarStore((state) => state.transferHost);
  const me = game.players.find((player) => player.normalizedHandle === normalizeHandle(context.handle));
  const isHost = normalizeHandle(game.hostHandle) === normalizeHandle(context.handle);
  const readyCount = game.players.filter((player) => player.ready).length;
  const canStart = readyCount >= 3 && readyCount <= 8;

  return (
    <section className="room-grid">
      <div className="paper-panel">
        <p className="eyebrow">Game Lobby</p>
        <h1>{context.roomSlug}</h1>
        <p className="subtle">{readyCount} ready. Start needs 3-8 ready players.</p>
        <div className="rules-summary" data-testid="rules-summary">
          <p>
            <strong>Category pack:</strong> Starter Categories ({STARTER_FIELDS.length})
          </p>
          <p>
            <strong>Rules:</strong> 3-8 players, five cells max, points 20/10/7/5/3, final score uses the best five rounds.
          </p>
        </div>
        <div className="action-row">
          {me ? (
            <button type="button" className={`button ${me.ready ? "secondary" : "primary"}`} onClick={() => void toggleReady()} data-testid="toggle-ready">
              {me.ready ? "Not Ready" : "Ready"}
            </button>
          ) : (
            <button type="button" className="button primary" onClick={() => void joinSeason()} data-testid="join-season">
              Join Game
            </button>
          )}
          {isHost ? (
            <button type="button" className="button primary" onClick={() => void startSeason()} data-testid="start-season" disabled={!canStart} aria-disabled={!canStart}>
              Start Game
            </button>
          ) : null}
          {!isHost && me && !isHandleOnline(game.hostHandle, context, roomState, now) ? (
            <button type="button" className="button secondary" onClick={() => void claimHost()} data-testid="claim-host">
              Take Host
            </button>
          ) : null}
        </div>
      </div>
      <div className="paper-panel">
        <h2>Seats</h2>
        <ol className="seat-list">
          {[...game.players].sort((a, b) => a.seatNumber - b.seatNumber).map((player) => {
            const online = isHandleOnline(player.handle, context, roomState, now);
            return (
              <li key={player.handle} data-testid={`seat-${player.handle}`} data-presence={online ? "online" : "offline"}>
                <span data-testid="seat-name">{player.displayName}</span>
                <span>
                  {player.isHost ? "Host" : ""} {player.ready ? "Ready" : "Waiting"}{" "}
                  <span className={`presence ${online ? "online" : "offline"}`} data-testid={`presence-${player.handle}`}>
                    {online ? "Online" : "Offline"}
                  </span>
                </span>
                {isHost ? (
                  <span className="seat-actions">
                    <button type="button" className="button icon-button" aria-label={`Move ${player.displayName} up`} onClick={() => void moveSeat(player.handle, "up")} data-testid={`seat-up-${player.handle}`}>
                      ^
                    </button>
                    <button type="button" className="button icon-button" aria-label={`Move ${player.displayName} down`} onClick={() => void moveSeat(player.handle, "down")} data-testid={`seat-down-${player.handle}`}>
                      v
                    </button>
                  </span>
                ) : null}
                {isHost && !player.isHost ? (
                  <button type="button" className="button quiet" onClick={() => void transferHost(player.handle)} data-testid={`transfer-host-${player.handle}`}>
                    Make Host
                  </button>
                ) : null}
              </li>
            );
          })}
        </ol>
        {isHost ? (
          <button type="button" className="button secondary lobby-randomize" onClick={() => void randomizeSeats()} data-testid="randomize-seats">
            Randomize Seats
          </button>
        ) : null}
      </div>
      <History />
    </section>
  );
}

function StatusRail({ game, round, role }: { game: Game; round: Round; role: string }): React.ReactElement {
  const context = useSowsEarStore((state) => state.context);
  const score = game.ribbons.reduce((sum, value) => sum + value, 0);
  const currentPoints = pointsForDepth(true, round.depth);
  return (
    <aside className="status-rail">
      <div className="paper-panel status-card">
        <div className="status-card-header">
          <p className="eyebrow">Round {round.roundNumber} of {game.totalHarvests}</p>
        </div>
        <div className="status-card-body">
          <div className="role-summary">
            <h2>{role === "none" ? "Observer" : titleCase(role)}</h2>
            <p>{context.handle}</p>
          </div>
          <div className="score-inline">
            <span>Points</span>
            <strong>{score}</strong>
          </div>
        </div>
      </div>
      <div className="paper-panel ribbon-ladder" aria-label="Point ladder">
        <div className="ribbon-ladder-heading">
          <span>Point Ladder</span>
          <strong>Current {currentPoints}</strong>
        </div>
        <div className="token-stack">
          {[20, 10, 7, 5, 3].map((value) => (
            <span key={value} className={`token token-${value}`}>
              {value}
            </span>
          ))}
        </div>
      </div>
      <HostControls game={game} />
      <HostRecoveryControls game={game} />
    </aside>
  );
}

function HostControls({ game }: { game: Game }): React.ReactElement | null {
  const context = useSowsEarStore((state) => state.context);
  const pauseSeason = useSowsEarStore((state) => state.pauseSeason);
  const resumeSeason = useSowsEarStore((state) => state.resumeSeason);
  const voidHarvest = useSowsEarStore((state) => state.voidHarvest);
  const transferHost = useSowsEarStore((state) => state.transferHost);
  const selectRef = useRef<HTMLSelectElement>(null);
  if (normalizeHandle(game.hostHandle) !== normalizeHandle(context.handle)) return null;
  return (
    <div className="paper-panel host-controls">
      <h2>You're Host</h2>
      <div className="action-row">
        {game.pausedAt ? (
          <button type="button" className="button primary" onClick={() => void resumeSeason()} data-testid="resume-season">
            Resume
          </button>
        ) : (
          <button type="button" className="button secondary" onClick={() => void pauseSeason()} data-testid="pause-season">
            Pause
          </button>
        )}
        <button type="button" className="button danger" onClick={() => void voidHarvest()} data-testid="void-harvest">
          Void Round
        </button>
      </div>
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
  );
}

function HostRecoveryControls({ game }: { game: Game }): React.ReactElement | null {
  const context = useSowsEarStore((state) => state.context);
  const roomState = useSowsEarStore((state) => state.roomState);
  const now = useSowsEarStore((state) => state.now);
  const claimHost = useSowsEarStore((state) => state.claimHost);
  if (normalizeHandle(game.hostHandle) === normalizeHandle(context.handle)) return null;
  if (!playerForGame(game, context.handle)) return null;
  if (isHandleOnline(game.hostHandle, context, roomState, now)) return null;
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
  const fieldTitle = round.fieldLabel || "Category";
  if (round.phase === "field-choice") {
    if (role === "guesser") return <FieldChoice round={round} />;
    return <WaitPanel message="The guesser is choosing a category." />;
  }
  if (round.phase === "seed") {
    if (role === "picker") return <AnswerPanel fieldTitle={fieldTitle} />;
    return (
      <section className="paper-panel wait-panel">
        <p className="eyebrow">Category</p>
        <div className="phase-title-row">
          <div>
            <h1>{fieldTitle}</h1>
            <p className="subtle">The picker is choosing the answer.</p>
          </div>
        </div>
      </section>
    );
  }
  if (round.phase === "planting") return <PlantingPanel game={game} round={round} role={role} fieldTitle={fieldTitle} />;
  if (round.phase === "farmer-call") return <GuesserCallPanel game={game} round={round} role={role} fieldTitle={fieldTitle} />;
  if (round.phase === "adjudication") return <AdjudicationPanel game={game} round={round} role={role} fieldTitle={fieldTitle} />;
  return <RoundRecap game={game} round={round} />;
}

function FieldChoice({ round }: { round: Round }): React.ReactElement {
  const chooseField = useSowsEarStore((state) => state.chooseField);
  return (
    <section className="paper-panel">
      <p className="eyebrow">Choose a Category</p>
      <h1>Pick the search space</h1>
      <div className="field-options">
        {round.fieldOptions.map((fieldId) => (
          <button type="button" key={fieldId} className="field-card" onClick={() => void chooseField(fieldId)} data-testid="field-option">
            <span>Category</span>
            <strong>{fieldLabel(fieldId)}</strong>
          </button>
        ))}
      </div>
    </section>
  );
}

function AnswerPanel({ fieldTitle }: { fieldTitle: string }): React.ReactElement {
  const plantSeed = useSowsEarStore((state) => state.plantSeed);
  return (
    <section className="paper-panel">
      <p className="eyebrow">Category</p>
      <h1>{fieldTitle}</h1>
      <form
        className="compact-form"
        onSubmit={(event) => {
          event.preventDefault();
          void plantSeed(formValue(event.currentTarget, "seed"));
        }}
      >
        <label>
          Answer
          <input name="seed" autoComplete="off" maxLength={80} required data-testid="seed-input" />
        </label>
        <p className="hint">Long phrases and obscure proper nouns are hard to clue fairly.</p>
        <button type="submit" className="button primary" data-testid="plant-seed">
          Lock Answer
        </button>
      </form>
    </section>
  );
}

function PlantingPanel({ game, round, role, fieldTitle }: { game: Game; round: Round; role: string; fieldTitle: string }): React.ReactElement {
  const context = useSowsEarStore((state) => state.context);
  const plantLetters = useSowsEarStore((state) => state.plantLetters);
  const heldRows = rowsHeldForClue(round, context.handle);
  return (
    <section className="paper-panel board-panel">
      <p className="eyebrow">Category</p>
      <h1>{fieldTitle}</h1>
      {role === "guesser" ? null : (
        <p className="seed-line">
          Answer: <strong>{round.seedRaw}</strong>
        </p>
      )}
      {heldRows.length ? (
        <form
          className="letter-form inline-clue-form"
          onSubmit={(event) => {
            event.preventDefault();
            const form = event.currentTarget;
            const letters = new Map<number, ClueCellInput>();
            for (const row of heldRows) {
              const letter = clampLetter(formValue(form, `letter-${row.rowIndex}`));
              const endsWord = new FormData(form).get(`end-${row.rowIndex}`) === "on";
              if (letter) letters.set(row.rowIndex, { letter, endsWord });
            }
            void plantLetters(letters);
          }}
        >
          <Rows game={game} round={round} revealAll={false} editableRows={heldRows} />
          <PlantingStatus round={round} />
          <button className="button primary" type="submit" data-testid="submit-letters">
            Submit Clues
          </button>
        </form>
      ) : (
        <>
          <Rows game={game} round={round} revealAll={false} />
          <PlantingStatus round={round} />
          <p className="subtle">{role === "guesser" ? "The cluers are adding letters." : "Waiting for the handoff."}</p>
        </>
      )}
    </section>
  );
}

function PlantingStatus({ round }: { round: Round }): React.ReactElement | null {
  const context = useSowsEarStore((state) => state.context);
  const roomState = useSowsEarStore((state) => state.roomState);
  const now = useSowsEarStore((state) => state.now);
  if (round.phase !== "planting") return null;
  return (
    <div className="planting-status" data-testid="planting-status" aria-label="Planting status">
      {round.rows.map((row) => {
        const entry = round.entries.find((item) => item.rowIndex === row.rowIndex && item.depth === round.depth);
        const complete = rowIsComplete(round, row.rowIndex);
        const handle = entry?.handle ?? row.currentHolderHandle;
        const online = isHandleOnline(handle, context, roomState, now);
        return (
          <div
            key={row.rowIndex}
            className={`planting-status-item ${entry ? "planted" : "waiting"}`}
            data-testid={`planting-status-${row.rowIndex}`}
            data-state={complete ? "complete" : entry ? "planted" : "waiting"}
            data-presence={online ? "online" : "offline"}
          >
            <span>Row {row.rowIndex + 1}</span>
            <strong>{handle}</strong>
            <span>{complete ? "Complete" : entry ? "Submitted" : online ? "Waiting" : "Waiting (offline)"}</span>
          </div>
        );
      })}
    </div>
  );
}

function GuesserCallPanel({ game, round, role, fieldTitle }: { game: Game; round: Round; role: string; fieldTitle: string }): React.ReactElement {
  const pendingGuess = useSowsEarStore((state) => state.pendingGuess);
  const submitGuess = useSowsEarStore((state) => state.submitGuess);
  const wait = useSowsEarStore((state) => state.wait);
  const spoil = useSowsEarStore((state) => state.spoil);
  return (
    <section className="paper-panel board-panel">
      <p className="eyebrow">Category</p>
      <h1>{fieldTitle}</h1>
      <p className="ribbon-callout" data-testid="current-ribbon">
        Current Points: {pointsForDepth(true, round.depth)}
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
                  Submitting ends the round if it is not accepted.
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
              <button type="button" className="button secondary" onClick={() => void wait()} data-testid="one-more-letter">
                One More Cell
              </button>
            ) : null}
            <button type="button" className="button danger" onClick={() => void spoil()} data-testid="spoil">
              Pass
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="seed-line">
            Answer: <strong>{round.seedRaw}</strong>
          </p>
          <p className="subtle">The guesser is deciding.</p>
        </>
      )}
    </section>
  );
}

function AdjudicationPanel({ game, round, role, fieldTitle }: { game: Game; round: Round; role: string; fieldTitle: string }): React.ReactElement {
  const adjudicate = useSowsEarStore((state) => state.adjudicate);
  if (role === "picker") {
    return (
      <section className="paper-panel">
        <p className="eyebrow">Adjudication</p>
        <h1>Does this count?</h1>
        <dl className="compare-list">
          <dt>Answer</dt>
          <dd>{round.seedRaw}</dd>
          <dt>Guess</dt>
          <dd>{round.guessRaw}</dd>
        </dl>
        <div className="action-row">
          <button type="button" className="button primary" onClick={() => void adjudicate(true)} data-testid="accept-guess">
            Correct
          </button>
          <button type="button" className="button danger" onClick={() => void adjudicate(false)} data-testid="reject-guess">
            Miss
          </button>
        </div>
      </section>
    );
  }
  if (role === "guesser") {
    return (
      <section className="paper-panel board-panel">
        <p className="eyebrow">Category</p>
        <h1>{fieldTitle}</h1>
        <Rows game={game} round={round} revealAll={false} />
        <dl className="compare-list">
          <dt>Guess</dt>
          <dd data-testid="adjudication-guess">{round.guessRaw}</dd>
        </dl>
        <p className="subtle">The picker is judging the guess.</p>
      </section>
    );
  }
  return (
    <section className="paper-panel wait-panel">
      <p className="seed-line">
        Answer: <strong>{round.seedRaw}</strong>
      </p>
      <p className="subtle">The picker is judging the guess.</p>
    </section>
  );
}

function RoundRecap({ game, round }: { game: Game; round: Round }): React.ReactElement {
  const context = useSowsEarStore((state) => state.context);
  const advance = useSowsEarStore((state) => state.advance);
  const isHost = normalizeHandle(game.hostHandle) === normalizeHandle(context.handle);
  return (
    <section className="paper-panel board-panel">
      <p className="eyebrow">Round Recap</p>
      <h1>{round.accepted ? recapLine(round.depth) : "No match this time."}</h1>
      <dl className="compare-list">
        <dt>Category</dt>
        <dd>{round.fieldLabel}</dd>
        <dt>Answer</dt>
        <dd data-testid="revealed-seed">{round.seedRaw}</dd>
        <dt>Guess</dt>
        <dd>{round.guessRaw || "Passed"}</dd>
        <dt>Points</dt>
        <dd>{round.ribbon ?? 0}</dd>
      </dl>
      <p className="score-note" data-testid="running-county-fair">
        Final score so far: {finalScore(game)} / 100
      </p>
      <Rows game={game} round={round} revealAll={true} />
      <PlayerLegend game={game} />
      {isHost ? (
        <button type="button" className="button primary" onClick={() => void advance()} data-testid="advance">
          {round.roundNumber >= game.totalHarvests ? "Final Score" : "Next Round"}
        </button>
      ) : (
        <p className="subtle">Waiting for the host.</p>
      )}
    </section>
  );
}

function Final({ game }: { game: Game }): React.ReactElement {
  const summary = seasonSummary(game);
  const copySummary = useSowsEarStore((state) => state.copySummary);
  const createSeason = useSowsEarStore((state) => state.createSeason);
  return (
    <section className="room-grid">
      <div className="paper-panel final-panel">
        <p className="eyebrow">Final Score</p>
        <h1>{finalScore(game)} / 100</h1>
        <div className="score-ledger">
          <p data-testid="all-ribbons">
            <strong>Every Round:</strong> {game.ribbons.join(", ") || "none"}
          </p>
          <p data-testid="counted-ribbons">
            <strong>Counted Rounds:</strong> {topFive(game.ribbons).join(", ") || "none"}
          </p>
        </div>
        <label>
          Summary
          <textarea className="summary-box" readOnly data-testid="summary-text" value={summary} />
        </label>
        <button type="button" className="button secondary" onClick={() => void copySummary()} data-testid="copy-summary">
          Copy Summary
        </button>
        <button type="button" className="button primary" onClick={() => void createSeason()} data-testid="rematch">
          Rematch
        </button>
      </div>
      <Review game={game} />
    </section>
  );
}

function Review({ game }: { game: Game }): React.ReactElement {
  const context = useSowsEarStore((state) => state.context);
  const leaveReview = useSowsEarStore((state) => state.leaveReview);
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
            <h2>Round {round.roundNumber}: {round.fieldLabel || "Category"}</h2>
            <p>
              Answer: <strong>{round.seedRaw || ""}</strong>
            </p>
            <p>Guess: {round.guessRaw || "Passed"} · Points {round.ribbon ?? 0}</p>
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
    <div className="harvest-replay" data-testid={`harvest-replay-${round.roundNumber}`}>
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
  maxVisibleDepth,
  editableRows = [],
}: {
  game: Game;
  round: Round;
  revealAll: boolean;
  maxVisibleDepth?: number;
  editableRows?: Row[];
}): React.ReactElement {
  const editableRowIndexes = new Set(editableRows.map((row) => row.rowIndex));
  return (
    <div className="rows" data-testid="rows">
      {round.rows.map((row) => {
        const entries = [1, 2, 3, 4, 5].map((depth) => round.entries.find((entry) => entry.rowIndex === row.rowIndex && entry.depth === depth));
        const editable = editableRowIndexes.has(row.rowIndex);
        return (
          <div className={`hint-row ${revealAll ? "reveal" : ""} ${rowIsComplete(round, row.rowIndex) ? "complete" : ""}`} key={row.rowIndex}>
            <span className="row-number">{row.rowIndex + 1}</span>
            <div className="row-main">
              <div className="slots" aria-label={`Row ${row.rowIndex + 1}`}>
                {entries.map((entry, index) => {
                  const visible = entry && (maxVisibleDepth === undefined ? entry.sprouted || revealAll : entry.depth <= maxVisibleDepth);
                  const isEditableCell = editable && index === round.depth - 1 && !entry;
                  const pen = visible && entry ? penForHandle(game, entry.handle) : undefined;
                  return (
                    <span
                      className={`slot ${visible ? "filled" : ""} ${isEditableCell ? "editing" : ""} ${pen ? `pen-${pen.index}` : ""}`}
                      style={pen ? penStyleVars(pen) : undefined}
                      key={index}
                      data-testid={`clue-cell-${row.rowIndex}-${index + 1}`}
                    >
                      {isEditableCell ? (
                        <ClueCellInputControl rowIndex={row.rowIndex} />
                      ) : visible && entry ? (
                        <ClueCellText letter={entry.letter} endsWord={entry.endsWord} handle={entry.handle} />
                      ) : (
                        <span className="clue-placeholder" aria-hidden="true">
                          _
                        </span>
                      )}
                    </span>
                  );
                })}
              </div>
            </div>
            {revealAll ? null : <span className="holder">{row.currentHolderHandle}</span>}
          </div>
        );
      })}
    </div>
  );
}

function ClueCellInputControl({ rowIndex }: { rowIndex: number }): React.ReactElement {
  return (
    <span className="cell-editor">
      <input
        name={`letter-${rowIndex}`}
        className="clue-letter-input"
        maxLength={1}
        autoComplete="off"
        required
        aria-label={`Row ${rowIndex + 1} next letter`}
        data-testid={`letter-input-${rowIndex}`}
        onInput={(event) => {
          event.currentTarget.value = clampLetter(event.currentTarget.value);
        }}
        onKeyDown={(event) => {
          if (event.key !== ".") return;
          event.preventDefault();
          const checkbox = event.currentTarget.form?.elements.namedItem(`end-${rowIndex}`);
          if (checkbox instanceof HTMLInputElement) checkbox.checked = !checkbox.checked;
        }}
      />
      <label className="word-end-toggle" title="Mark this cell as the end of a word">
        <input type="checkbox" name={`end-${rowIndex}`} data-testid={`word-end-${rowIndex}`} />
        <span>.</span>
      </label>
    </span>
  );
}

function ClueCellText({ letter, endsWord, handle }: { letter: string; endsWord: boolean; handle: string }): React.ReactElement {
  return (
    <>
      <span className="clue-letter" aria-label={`${letter}${endsWord ? " word end" : ""}`}>
        {letter}
        {endsWord ? "." : ""}
      </span>
      <span className="pen-badge" aria-label={`by ${handle}`}>
        {handle.slice(0, 1).toLocaleUpperCase("en-US")}
      </span>
    </>
  );
}

function PlayerLegend({ game }: { game: Game }): React.ReactElement {
  return (
    <div className="player-legend" data-testid="player-legend" aria-label="Player pen styles">
      {game.players.map((player) => {
        const pen = penForHandle(game, player.handle);
        return (
          <span key={player.handle} className={`legend-item pen-${pen.index}`} style={penStyleVars(pen)}>
            <span className="legend-sample">
              <span className="clue-letter">A</span>
              <span className="pen-badge">{player.displayName.slice(0, 1).toLocaleUpperCase("en-US")}</span>
            </span>
            <span>{player.displayName}</span>
          </span>
        );
      })}
    </div>
  );
}

function History(): React.ReactElement {
  const roomState = useSowsEarStore((state) => state.roomState);
  const reviewGame = useSowsEarStore((state) => state.reviewGame);
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
      const inputs = Array.from(target.form.querySelectorAll<HTMLInputElement>('input[name^="letter-"]'));
      const nextEmpty = inputs.find((input) => input !== target && !input.value.trim());
      if (nextEmpty) {
        event.preventDefault();
        nextEmpty.focus();
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

function useAutoFocus(): void {
  const context = useSowsEarStore((state) => state.context);
  const roomState = useSowsEarStore((state) => state.roomState);
  const pendingGuess = useSowsEarStore((state) => state.pendingGuess);
  const focusTarget = useSowsEarStore((state) => state.focusTarget);
  const helpOpen = useSowsEarStore((state) => state.helpOpen);
  const clearFocusTarget = useSowsEarStore((state) => state.clearFocusTarget);
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

async function dispatch(result: CommandResult, set: (partial: Partial<SowsEarState>) => void, get: () => SowsEarState): Promise<void> {
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
  set: (partial: Partial<SowsEarState>) => void,
  get: () => SowsEarState,
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

function commandKey(name: string, state: SowsEarState): string {
  const game = state.roomState ? activeGame(state.roomState) : undefined;
  const round = game ? currentRound(game) : undefined;
  return [name, state.context.handle, game?.id ?? "room", round?.id ?? "none", game?.phaseVersion ?? 0, round?.depth ?? 0].join(":");
}

function requiredRoomState(get: () => SowsEarState): RoomState {
  const state = get().roomState;
  if (!state) throw new Error("Room state is not loaded.");
  return state;
}

function readContextFromLocation(state: Pick<SowsEarState, "rememberedRooms" | "lastHandle">): AppContext {
  const url = new URL(window.location.href);
  const roomSlug = roomSlugFrom(url.searchParams.get("room") ?? "");
  const handleFromUrl = url.searchParams.get("handle")?.trim() ?? "";
  const rememberedHandle = state.rememberedRooms.find((room) => room.roomSlug === roomSlug)?.handle ?? "";
  const handle = handleFromUrl || rememberedHandle || state.lastHandle || "";
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

function titleCase(value: string): string {
  return value.slice(0, 1).toLocaleUpperCase("en-US") + value.slice(1);
}

function recapLine(depth: number): string {
  if (depth === 1) return "A silk purse out of a sow's ear!";
  if (depth <= 3) return "Solved from a few letters.";
  return "Solved just in time.";
}

function topFive(ribbons: number[]): number[] {
  return [...ribbons].sort((a, b) => b - a).slice(0, 5);
}

function penForHandle(game: Game, handle: string): PenStyle {
  const normalizedHandle = normalizeHandle(handle);
  const orderedPlayers = [...game.players].sort((a, b) => a.seatNumber - b.seatNumber);
  const playerIndex = orderedPlayers.findIndex((player) => player.normalizedHandle === normalizedHandle);
  const index = playerIndex >= 0 ? playerIndex : hashString(normalizedHandle) % PEN_COLORS.length;
  const penIndex = index % PEN_COLORS.length;
  return {
    index: penIndex,
    color: PEN_COLORS[penIndex] ?? PEN_COLORS[0],
  };
}

function penStyleVars(pen: PenStyle): React.CSSProperties {
  return { "--pen-color": pen.color } as React.CSSProperties;
}

function hashString(value: string): number {
  let hash = 0;
  for (const char of value) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash;
}

function playerForGame(game: Game, handle: string): boolean {
  return game.players.some((player) => player.normalizedHandle === normalizeHandle(handle));
}

function isHandleOnline(handle: string, context: AppContext, roomState: RoomState | undefined, now: number): boolean {
  if (normalizeHandle(handle) === normalizeHandle(context.handle)) return true;
  const roomHandle = roomState?.handles.find((item) => item.normalizedHandle === normalizeHandle(handle));
  return Boolean(roomHandle && now - roomHandle.lastSeenAt <= PRESENCE_ONLINE_MS);
}

function focusPrimaryAction(): void {
  const selectors = [
    '[data-testid="room-input"]',
    '[data-testid="handle-input"]',
    '[data-testid="create-season"]',
    '[data-testid="start-season"]:not(:disabled)',
    '[data-testid="field-option"]',
    '[data-testid="seed-input"]',
    '[data-testid^="letter-input-"]',
    '[data-testid="confirm-guess"]',
    '[data-testid="guess-input"]',
    '[data-testid="accept-guess"]',
    '[data-testid="advance"]',
    '[data-testid="resume-season"]',
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

function seasonSummary(game: Game): string {
  const points = game.ribbons.map((pointValue, index) => `Round ${index + 1}: ${pointValue}`).join(", ");
  return `Sow's Ear Final Score ${finalScore(game)} / 100\nBest five rounds: ${topFive(game.ribbons).join(", ") || "none"}\n${points || "No rounds yet."}`;
}

export function startApp(): void {
  startFieldCountGuard();
  const root = document.getElementById("app");
  if (!root) throw new Error("Missing element #app");
  createRoot(root).render(<SowsEarApp />);
}

function startFieldCountGuard(): void {
  if (STARTER_FIELDS.length < 120) {
    console.warn(`Starter category pack has ${STARTER_FIELDS.length} categories; launch target is 120-200.`);
  }
}
