import { describe, expect, test } from "bun:test";
import { DEFAULT_PACK_ID } from "../config";
import { pickCategoryOptions, planCategoryOptions, STARTER_CATEGORIES } from "./categories";

describe("category option planning", () => {
  test("starter pack is launch-sized, original, active, and answer-free", () => {
    const ids = new Set(STARTER_CATEGORIES.map((category) => category.id));
    const labels = new Set(STARTER_CATEGORIES.map((category) => category.label));
    const difficulties = new Set(STARTER_CATEGORIES.map((category) => category.difficultyHint));

    expect(STARTER_CATEGORIES.length).toBeGreaterThanOrEqual(100);
    expect(STARTER_CATEGORIES.length).toBeLessThanOrEqual(200);
    expect(ids.size).toBe(STARTER_CATEGORIES.length);
    expect(labels.size).toBe(STARTER_CATEGORIES.length);
    expect(difficulties).toEqual(new Set(["easy", "medium", "spicy"]));
    expect(
      STARTER_CATEGORIES.every(
        (category) =>
          category.active &&
          category.source === "original" &&
          category.locale === "en-US" &&
          category.packId === DEFAULT_PACK_ID &&
          /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(category.id) &&
          !("answers" in category),
      ),
    ).toBe(true);
  });

  test("does not repeat starter categories before the pack is exhausted", () => {
    const activeCount = STARTER_CATEGORIES.filter((category) => category.active).length;
    const roundsBeforeExhaustion = Math.floor(activeCount / 2);
    const planned = planCategoryOptions("full-pack", roundsBeforeExhaustion, 2).flat();

    expect(planned).toHaveLength(roundsBeforeExhaustion * 2);
    expect(new Set(planned).size).toBe(planned.length);
  });

  test("reshuffles after exhaustion while keeping each offer unique when possible", () => {
    const planned = planCategoryOptions("tiny-pack", 4, 2, ["a", "b", "c"]);
    const flat = planned.flat();

    expect(planned).toHaveLength(4);
    expect(planned.every((offer) => offer.length === 2 && new Set(offer).size === 2)).toBe(true);
    expect(new Set(flat.slice(0, 3))).toEqual(new Set(["a", "b", "c"]));
    expect(new Set(flat)).toEqual(new Set(["a", "b", "c"]));
  });

  test("single-round helper matches the deterministic option plan", () => {
    expect(pickCategoryOptions("game-1", 3)).toEqual(planCategoryOptions("game-1", 3)[2] ?? []);
    expect(pickCategoryOptions("game-1", 0)).toEqual([]);
  });
});
