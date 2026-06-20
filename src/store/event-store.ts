import { INSTANT_APP_ID } from "../config";
import type { SowsEarEvent } from "../game/types";
import { InstantEventStore } from "./instant-event-store";
import { LocalEventStore } from "./local-event-store";

export type EventStore = {
  readonly mode: "instant" | "local";
  subscribe(roomSlug: string, callback: (events: SowsEarEvent[]) => void): () => void;
  append(events: SowsEarEvent[]): Promise<void>;
};

export function createEventStore(url: URL = new URL(window.location.href)): EventStore {
  const forceLocal = url.searchParams.get("local") === "1" || url.searchParams.get("test") === "1";
  if (forceLocal || !INSTANT_APP_ID) return new LocalEventStore();
  return new InstantEventStore(INSTANT_APP_ID);
}
