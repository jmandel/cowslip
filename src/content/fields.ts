import { DEFAULT_PACK_ID } from "../config";
import type { DifficultyHint, Field } from "../game/types";

// Fields name a *kind of thing*; the Sower invents a specific member each Harvest.
// e.g. Planet -> Mars, Condiment -> Ketchup, Sci-Fi Movie -> Alien.
// Keep them short and concrete so the sprouting letters stay interpretable.
const easy = [
  "Fruit",
  "Vegetable",
  "Farm Animal",
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
  "Season",
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

function fieldsFor(labels: string[], difficultyHint: DifficultyHint): Field[] {
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

export const STARTER_FIELDS: Field[] = [
  ...fieldsFor(easy, "easy"),
  ...fieldsFor(medium, "medium"),
  ...fieldsFor(spicy, "spicy"),
];

export function fieldById(fieldId: string): Field | undefined {
  return STARTER_FIELDS.find((field) => field.id === fieldId);
}

export function fieldLabel(fieldId: string): string {
  return fieldById(fieldId)?.label ?? fieldId;
}

export function planFieldOptions(seed: string, totalRounds: number, count = 2, fieldIds = activeFieldIds()): string[][] {
  if (totalRounds <= 0 || count <= 0 || fieldIds.length === 0) return [];
  const targetCount = Math.min(count, fieldIds.length);
  const rounds: string[][] = [];
  let deck: string[] = [];
  let cycle = 0;

  for (let roundIndex = 0; roundIndex < totalRounds; roundIndex += 1) {
    const roundOptions: string[] = [];
    while (roundOptions.length < targetCount) {
      if (!deck.length) {
        const nextDeckSource = fieldIds.filter((fieldId) => !roundOptions.includes(fieldId));
        deck = seededShuffle(nextDeckSource.length ? nextDeckSource : fieldIds, `${seed}:fields:${cycle}`);
        cycle += 1;
      }
      const fieldId = deck.shift();
      if (fieldId && !roundOptions.includes(fieldId)) roundOptions.push(fieldId);
    }
    rounds.push(roundOptions);
  }

  return rounds;
}

export function pickFieldOptions(seed: string, roundNumber: number, count = 2): string[] {
  return planFieldOptions(seed, roundNumber, count)[roundNumber - 1] ?? [];
}

function activeFieldIds(): string[] {
  return STARTER_FIELDS.filter((field) => field.active).map((field) => field.id);
}

function seededShuffle(values: string[], seed: string): string[] {
  const random = mulberry32(hashString(seed));
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

function mulberry32(seed: number): () => number {
  return () => {
    seed += 0x6d2b79f5;
    let value = seed;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}
