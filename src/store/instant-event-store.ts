import { id, init } from "@instantdb/core";
import schema from "../../instant.schema";
import type { SowsEarEvent } from "../game/types";
import type { EventStore } from "./event-store";

export class InstantEventStore implements EventStore {
  readonly mode = "instant" as const;
  private db: ReturnType<typeof init<typeof schema>>;

  constructor(appId: string) {
    this.db = init({ appId, schema });
  }

  subscribe(roomSlug: string, callback: (events: SowsEarEvent[]) => void): () => void {
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
            const event: SowsEarEvent = {
            actionId: row.actionId,
            type: row.type as SowsEarEvent["type"],
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

  async append(events: SowsEarEvent[]): Promise<void> {
    if (!events.length) return;
    await this.db.transact(
      events.map((event) => {
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
      }),
    );
  }
}
