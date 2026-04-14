const COLORS = [
  "pink",
  "amber",
  "azure",
  "ivory",
  "jade",
  "mauve",
  "pearl",
  "coral",
  "mint",
  "plum",
  "ruby",
  "sable",
];

const CONCEPTS = [
  "algebra",
  "orbit",
  "vector",
  "kernel",
  "matrix",
  "quantum",
  "signal",
  "syntax",
  "glyph",
  "tensor",
  "fractal",
  "lambda",
];

const ADJECTIVES = [
  "open",
  "silent",
  "quick",
  "brave",
  "steady",
  "vivid",
  "gentle",
  "sharp",
  "luminous",
  "eager",
  "bold",
  "calm",
];

const NOUNS = [
  "basket",
  "harbor",
  "forest",
  "anchor",
  "bridge",
  "canyon",
  "garden",
  "meadow",
  "signal",
  "lantern",
  "tower",
  "compass",
];

const randomIndex = (max: number): number => {
  const arr = new Uint32Array(1);
  crypto.getRandomValues(arr);
  return arr[0] % max;
};

const randomItem = (items: string[]): string => items[randomIndex(items.length)];

export const generateWorktreeSlug = (): string => {
  return [
    randomItem(COLORS),
    randomItem(CONCEPTS),
    randomItem(ADJECTIVES),
    randomItem(NOUNS),
  ].join("-");
};

export const generateWorktreeSuffix = (length = 4): string => {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < length; i += 1) {
    out += chars[randomIndex(chars.length)];
  }
  return out;
};
