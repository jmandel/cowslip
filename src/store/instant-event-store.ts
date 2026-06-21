import { id, init } from "@instantdb/core";
import schema from "../../instant.schema";
import type { GameEvent, RoomPresence } from "../game/types";
import type { EventStore } from "./event-store";

export class InstantEventStore implements EventStore {
  readonly mode = "instant" as const;
  private db: ReturnType<typeof init<typeof schema>>;

  constructor(appId: string) {
    this.db = init({ appId, schema });
  }

  subscribe(roomSlug: string, callback: (events: GameEvent[]) => void): () => void {
    return this.db.subscribeQuery(
      {
        gameEvents: {
          $: {
            where: { roomSlug },
          },
        },
      },
      (resp) => {
        if (resp.error) {
          console.error(resp.error);
          callback([]);
          return;
        }
        const rows = resp.data?.gameEvents ?? [];
        callback(
          rows.map((row) => {
            const event: GameEvent = {
            actionId: row.actionId,
            type: row.type as GameEvent["type"],
            roomSlug: row.roomSlug,
            actorHandle: row.actorHandle,
            createdAt: Number(row.createdAt),
            payload:
              typeof row.payload === "object" && row.payload !== null
                ? (row.payload as Record<string, unknown>)
                : {},
            };
            if (row.gameId !== "room") event.gameId = row.gameId;
            if (row.roundId) event.roundId = row.roundId;
            const payload = event.payload;
            if (typeof payload.expectedPhaseVersion === "number") {
              event.expectedPhaseVersion = payload.expectedPhaseVersion;
            }
            return event;
          }),
        );
      },
    );
  }

  subscribePresence(roomSlug: string, callback: (presence: RoomPresence[]) => void): () => void {
    return this.db.subscribeQuery(
      {
        roomPresence: {
          $: {
            where: { roomSlug },
          },
        },
      },
      (resp) => {
        if (resp.error) {
          console.error(resp.error);
          callback([]);
          return;
        }
        callback(
          (resp.data?.roomPresence ?? []).map((row) => ({
            presenceKey: row.presenceKey,
            roomSlug: row.roomSlug,
            handle: row.handle,
            normalizedHandle: row.normalizedHandle,
            displayName: row.displayName,
            lastSeenAt: Number(row.lastSeenAt),
            createdAt: Number(row.createdAt),
            updatedAt: Number(row.updatedAt),
          })),
        );
      },
    );
  }

  async append(events: GameEvent[]): Promise<void> {
    if (!events.length) return;
    const lastEventAt = Math.max(...events.map((event) => event.createdAt));
    const roomSlug = events[0]!.roomSlug;
    const activeGameId = activeGameIdFromEvents(events);
    const eventTransactions = events.map((event) => {
        const payload: Record<string, unknown> = { ...event.payload };
        if (typeof event.expectedPhaseVersion === "number") {
          payload.expectedPhaseVersion = event.expectedPhaseVersion;
        }
        const tx = this.db.tx.gameEvents[id()];
        if (!tx) throw new Error("Could not create gameEvents transaction.");
        return tx.update({
          roomSlug: event.roomSlug,
          gameId: event.gameId ?? "room",
          roundId: event.roundId ?? null,
          actionId: event.actionId,
          actorHandle: event.actorHandle,
          type: event.type,
          payload,
          createdAt: event.createdAt,
        });
      });
    await this.db.transact(eventTransactions);

    const summaryUpdate: Record<string, unknown> = {
      roomSlug,
      lastEventAt,
      updatedAt: lastEventAt,
      createdAt: lastEventAt,
    };
    if (activeGameId !== undefined) summaryUpdate.activeGameId = activeGameId;
    const summaryTx = this.db.tx.roomSummaries[await stableId(`room-summary:${roomSlug}`)];
    if (!summaryTx) return;
    try {
      await this.db.transact(summaryTx.update(summaryUpdate));
    } catch (error) {
      console.warn("Could not update room summary.", error);
    }
  }

  async markSeen(input: { roomSlug: string; handle: string; normalizedHandle: string; displayName: string }): Promise<void> {
    const now = Date.now();
    const presenceKey = `${input.roomSlug}:${input.normalizedHandle}`;
    const presenceTx = this.db.tx.roomPresence[await stableId(`room-presence:${presenceKey}`)];
    if (!presenceTx) throw new Error("Could not create roomPresence transaction.");
    try {
      await this.db.transact(
        presenceTx.update({
          presenceKey,
          roomSlug: input.roomSlug,
          handle: input.handle,
          normalizedHandle: input.normalizedHandle,
          displayName: input.displayName,
          lastSeenAt: now,
          createdAt: now,
          updatedAt: now,
        }),
      );
    } catch (error) {
      console.warn("Could not update room presence.", error);
    }
  }
}

async function stableId(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", new TextEncoder().encode(value)));
  digest[6] = (digest[6]! & 0x0f) | 0x50;
  digest[8] = (digest[8]! & 0x3f) | 0x80;
  const hex = Array.from(digest.slice(0, 16), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function activeGameIdFromEvents(events: GameEvent[]): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.type === "game.created" && event.gameId) return event.gameId;
  }
  return undefined;
}
