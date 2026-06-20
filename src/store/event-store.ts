import { INSTANT_APP_ID } from "../config";
import type { GameEvent, RoomPresence } from "../game/types";
import { InstantEventStore } from "./instant-event-store";
import { LocalEventStore } from "./local-event-store";

export type EventStore = {
  readonly mode: "instant" | "local";
  subscribe(roomSlug: string, callback: (events: GameEvent[]) => void): () => void;
  subscribePresence(roomSlug: string, callback: (presence: RoomPresence[]) => void): () => void;
  append(events: GameEvent[]): Promise<void>;
  markSeen(input: { roomSlug: string; handle: string; normalizedHandle: string; displayName: string }): Promise<void>;
};

export function createEventStore(url: URL = new URL(window.location.href)): EventStore {
  const forceLocal = url.searchParams.get("local") === "1" || url.searchParams.get("test") === "1";
  if (forceLocal || !INSTANT_APP_ID) return new LocalEventStore();
  return new InstantEventStore(INSTANT_APP_ID);
}
