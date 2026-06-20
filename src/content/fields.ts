import { DEFAULT_PACK_ID } from "../config";
import type { DifficultyHint, Field } from "../game/types";

const easy = [
  "Things Found on a Farm",
  "Things in a Kitchen",
  "Breakfast Foods",
  "Animals People Keep as Pets",
  "Things That Are Round",
  "Things You Wear",
  "Things in a Backpack",
  "Things at the Beach",
  "Things in a Bathroom",
  "Things in a Garden",
  "Fruits",
  "Vegetables",
  "Board Games",
  "Outdoor Games",
  "Things With Wheels",
  "Things That Fly",
  "Things Made of Wood",
  "Things Made of Metal",
  "Things That Melt",
  "Things You Plug In",
  "Things in a Classroom",
  "Things in an Office",
  "Things in a Grocery Store",
  "Things in a Restaurant",
  "Things at a Birthday Party",
  "Things at a Picnic",
  "Things in a Park",
  "Things in a Garage",
  "Things in a Library",
  "Things in a Hospital",
  "Things in a Hotel",
  "Things in a Theater",
  "Things in a Museum",
  "Things in a Toolbox",
  "Things on a Desk",
  "Things on a Wall",
  "Things Under a Bed",
  "Things in a Junk Drawer",
  "Things in a Freezer",
  "Things in a Lunchbox",
  "Things You Drink",
  "Things You Bake",
  "Things You Cut",
  "Things You Fold",
  "Things You Throw",
  "Things You Open",
  "Things That Ring",
  "Things That Float",
  "Things That Sink",
  "Things That Smell Good",
  "Things That Are Sticky",
  "Things That Are Soft",
  "Things That Are Loud",
  "Things That Are Tiny",
  "Things That Are Heavy",
  "Things That Are Green",
  "Things That Are Red",
  "Things That Are Cold",
  "Things That Are Hot",
  "Things With Handles",
];

const medium = [
  "Two-Word Answers",
  "One-Word Answers Only",
  "Jobs",
  "Places People Work",
  "Places to Hide",
  "Vacation Spots",
  "Things at an Airport",
  "Things on a Train",
  "Things on a Ship",
  "Things in Space",
  "Weather Words",
  "Natural Disasters",
  "Kinds of Trees",
  "Kinds of Flowers",
  "Ocean Animals",
  "Forest Animals",
  "Desert Things",
  "Mountain Things",
  "Musical Instruments",
  "Things in a Band",
  "Movie Genres",
  "Book Genres",
  "TV Show Settings",
  "Famous Fictional Places",
  "Sports Equipment",
  "Olympic Sports",
  "Things in a Gym",
  "Things at a Wedding",
  "Things at a Parade",
  "Things at a County Fair",
  "Holiday Decorations",
  "Halloween Things",
  "Winter Things",
  "Summer Things",
  "Rainy Day Things",
  "Things in a Castle",
  "Things in a Lab",
  "Things in a Workshop",
  "Things on a Menu",
  "Desserts",
  "Sandwich Fillings",
  "Pizza Toppings",
  "Soup Ingredients",
  "Things in a Salad",
  "Things You Can Rent",
  "Things You Can Borrow",
  "Things You Can Collect",
  "Things With Buttons",
  "Things With Screens",
  "Things With Strings",
  "Things With Keys",
  "Things With Spots",
  "Things With Stripes",
  "Things That Come in Pairs",
  "Things That Need Batteries",
  "Things That Use Water",
  "Things That Make Light",
  "Things That Make Noise",
  "Things That Need a Ticket",
  "Things You Might Lose",
];

const spicy = [
  "Famous Duos",
  "Things With Silent Letters",
  "Words That Start and End With the Same Letter",
  "Things People Argue About",
  "Things That Are Hard to Explain",
  "Things That Can Be Broken",
  "Things That Can Be Shared",
  "Things That Can Be Measured",
  "Things That Can Be Delivered",
  "Things That Can Be Printed",
  "Things That Can Be Recycled",
  "Things That Can Be Framed",
  "Things That Can Be Locked",
  "Things That Can Be Charged",
  "Things That Can Be Pickled",
  "Things That Can Be Haunted",
  "Things That Can Be Folded Twice",
  "Things That Have a Shell",
  "Things That Have a Tail",
  "Things That Have a Crown",
  "Things That Have a Screen But Are Not Phones",
  "Things That Are Better Fresh",
  "Things That Are Better Old",
  "Things That Are Usually Hidden",
  "Things That Are Usually Numbered",
  "Things That Are Usually Borrowed",
  "Things That Are Usually Shared",
  "Things That Are Usually Locked",
  "Things That Are Usually Folded",
  "Things That Are Usually Frozen",
  "Things That Are Usually Spicy",
  "Things That Are Usually Fragile",
  "Things You Can Hear But Not See",
  "Things You Can See But Not Touch",
  "Things You Can Draw With One Line",
  "Things You Can Balance",
  "Things You Can Stack",
  "Things You Can Spin",
  "Things You Can Whistle",
  "Things You Can Tie",
  "Things You Can Peel",
  "Things You Can Tune",
  "Things You Can Shuffle",
  "Things You Can Launch",
  "Things You Can Plant",
  "Things You Can Patch",
  "Things You Can Polish",
  "Things You Can Stretch",
  "Things You Can Name After Someone",
  "Things You Can Find on a Map",
  "Things You Can Find in a Song Title",
  "Things You Can Find in a Fairy Tale",
  "Things You Can Find in a Mystery Story",
  "Things You Can Find in a Science Lab",
  "Things You Can Find in a Time Capsule",
  "Things You Can Find in a Parade",
  "Things You Can Find in a Farmers Market",
  "Things You Can Find in a Sewing Kit",
  "Things You Can Find in a First-Aid Kit",
  "Things You Can Find in a Campsite",
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
