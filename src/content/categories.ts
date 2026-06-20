import { CATEGORY_OFFER_COUNT, DEFAULT_PACK_ID } from "../config";
import type { DifficultyHint, Category } from "../game/types";

// Categories name a kind of thing; the answer writer invents a specific member.
// e.g. Planet -> Mars, Condiment -> Ketchup, Sci-Fi Movie -> Alien.
// Keep them short and concrete so the clue cells stay interpretable.
const easy = [
  "Fruit",
  "Vegetable",
  "Animal",
  "Pet",
  "Ocean Animal",
  "Bird",
  "Insect",
  "Flower",
  "Tree",
  "Color",
  "Body Part",
  "Pizza Topping",
  "Breakfast Food",
  "Dessert",
  "Candy",
  "Ice Cream Flavor",
  "Condiment",
  "Kitchen Tool",
  "Sport",
  "Board Game",
  "Musical Instrument",
  "School Subject",
  "Shape",
  "Planet",
  "Holiday",
  "Month",
  "Clothing Item",
  "Hat",
  "Toy",
  "Furniture",
  "Kitchen Appliance",
  "Tool",
  "Vehicle",
  "Drink",
];

const medium = [
  "Athlete",
  "Superhero",
  "Cartoon Character",
  "Sci-Fi Movie",
  "Disney Movie",
  "Video Game",
  "Arcade Game",
  "Country",
  "US State",
  "Capital City",
  "World Landmark",
  "River",
  "Mountain",
  "National Park",
  "Dinosaur",
  "Gemstone",
  "Chemical Element",
  "Constellation",
  "Fast Food Chain",
  "Soda Brand",
  "Breakfast Cereal",
  "Cocktail",
  "Cheese",
  "Spice",
  "Art Supply",
  "Dance",
  "Card Game",
  "Pasta Shape",
  "Coffee Drink",
  "Sandwich",
  "Olympic Sport",
  "Movie Monster",
  "Circus Act",
];

const spicy = [
  "Comic Book Villain",
  "Mythological Creature",
  "Greek God",
  "Chess Piece",
  "Martial Art",
  "Yoga Pose",
  "Phobia",
  "Emotion",
  "Cloud Type",
  "Natural Disaster",
  "Knot",
  "Magic Trick",
  "Font",
  "Punctuation Mark",
  "Shakespeare Play",
  "Broadway Musical",
  "Famous Painting",
  "Art Movement",
  "Philosopher",
  "Invention",
  "Space Mission",
  "Famous Ship",
  "Secret Agent",
  "Fairy Tale",
  "Nursery Rhyme",
  "Superpower",
  "Mythical Place",
  "Volcano",
  "Desert",
  "Zodiac Sign",
  "Cryptid",
  "Wizard",
  "Pirate",
];

function slugify(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function categoriesFor(labels: string[], difficultyHint: DifficultyHint): Category[] {
  return labels.map((label) => ({
    id: slugify(label),
    label,
    locale: "en-US",
    packId: DEFAULT_PACK_ID,
    source: "original",
    active: true,
    difficultyHint,
  }));
}

export const STARTER_CATEGORIES: Category[] = [
  ...categoriesFor(easy, "easy"),
  ...categoriesFor(medium, "medium"),
  ...categoriesFor(spicy, "spicy"),
];

export function categoryById(categoryId: string): Category | undefined {
  return STARTER_CATEGORIES.find((category) => category.id === categoryId);
}

export function categoryLabel(categoryId: string): string {
  return categoryById(categoryId)?.label ?? categoryId;
}

export function planCategoryOptions(
  planKey: string,
  totalRounds: number,
  count = CATEGORY_OFFER_COUNT,
  categoryIds = activeCategoryIds(),
): string[][] {
  if (totalRounds <= 0 || count <= 0 || categoryIds.length === 0) return [];
  const targetCount = Math.min(count, categoryIds.length);
  const rounds: string[][] = [];
  let deck: string[] = [];
  let cycle = 0;

  for (let roundIndex = 0; roundIndex < totalRounds; roundIndex += 1) {
    const roundOptions: string[] = [];
    while (roundOptions.length < targetCount) {
      if (!deck.length) {
        const nextDeckSource = categoryIds.filter((categoryId) => !roundOptions.includes(categoryId));
        deck = deterministicShuffle(nextDeckSource.length ? nextDeckSource : categoryIds, `${planKey}:categories:${cycle}`);
        cycle += 1;
      }
      const categoryId = deck.shift();
      if (categoryId && !roundOptions.includes(categoryId)) roundOptions.push(categoryId);
    }
    rounds.push(roundOptions);
  }

  return rounds;
}

export function pickCategoryOptions(planKey: string, roundNumber: number, count = CATEGORY_OFFER_COUNT): string[] {
  return planCategoryOptions(planKey, roundNumber, count)[roundNumber - 1] ?? [];
}

function activeCategoryIds(): string[] {
  return STARTER_CATEGORIES.filter((category) => category.active).map((category) => category.id);
}

function deterministicShuffle(values: string[], planKey: string): string[] {
  const random = mulberry32(hashString(planKey));
  const shuffled = [...values];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex]!, shuffled[index]!];
  }
  return shuffled;
}

function hashString(value: string): number {
  let hash = 2166136261;
  for (const char of value) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function mulberry32(state: number): () => number {
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}
