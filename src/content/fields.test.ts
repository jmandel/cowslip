import { describe, expect, test } from "bun:test";
import { DEFAULT_PACK_ID } from "../config";
import { pickFieldOptions, planFieldOptions, STARTER_FIELDS } from "./fields";

describe("field option planning", () => {
  test("starter pack is launch-sized, original, active, and answer-free", () => {
    const ids = new Set(STARTER_FIELDS.map((field) => field.id));
    const labels = new Set(STARTER_FIELDS.map((field) => field.label));
    const difficulties = new Set(STARTER_FIELDS.map((field) => field.difficultyHint));

    expect(STARTER_FIELDS.length).toBeGreaterThanOrEqual(100);
    expect(STARTER_FIELDS.length).toBeLessThanOrEqual(200);
    expect(ids.size).toBe(STARTER_FIELDS.length);
    expect(labels.size).toBe(STARTER_FIELDS.length);
    expect(difficulties).toEqual(new Set(["easy", "medium", "spicy"]));
    expect(
      STARTER_FIELDS.every(
        (field) =>
          field.active &&
          field.source === "original" &&
          field.locale === "en-US" &&
          field.packId === DEFAULT_PACK_ID &&
          /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(field.id) &&
          !("answers" in field),
      ),
    ).toBe(true);
  });

  test("does not repeat starter Fields before the pack is exhausted", () => {
    const activeCount = STARTER_FIELDS.filter((field) => field.active).length;
    const roundsBeforeExhaustion = Math.floor(activeCount / 2);
    const planned = planFieldOptions("full-pack", roundsBeforeExhaustion, 2).flat();

    expect(planned).toHaveLength(roundsBeforeExhaustion * 2);
    expect(new Set(planned).size).toBe(planned.length);
  });

  test("reshuffles after exhaustion while keeping each offer unique when possible", () => {
    const planned = planFieldOptions("tiny-pack", 4, 2, ["a", "b", "c"]);
    const flat = planned.flat();

    expect(planned).toHaveLength(4);
    expect(planned.every((offer) => offer.length === 2 && new Set(offer).size === 2)).toBe(true);
    expect(new Set(flat.slice(0, 3))).toEqual(new Set(["a", "b", "c"]));
    expect(new Set(flat)).toEqual(new Set(["a", "b", "c"]));
  });

  test("single-round picker matches the deterministic option plan", () => {
    expect(pickFieldOptions("season-1", 3)).toEqual(planFieldOptions("season-1", 3)[2] ?? []);
    expect(pickFieldOptions("season-1", 0)).toEqual([]);
  });
});
