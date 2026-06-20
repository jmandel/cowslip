import { mkdir, rm } from "node:fs/promises";
import sharp from "sharp";

const outDir = "src/assets";

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });
await mkdir(`${outDir}/letters`, { recursive: true });

type CropPadding = number | { top?: number; right?: number; bottom?: number; left?: number };

async function transparentCrop(
  input: string,
  output: string,
  extract: { left: number; top: number; width: number; height: number },
  options: {
    minAverage?: number;
    maxSpread?: number;
    discardComponentsStartingBelow?: number;
    discardComponentsBelowPixels?: number;
    padding?: CropPadding;
  } = {},
): Promise<void> {
  const { data, info } = await sharp(input).extract(extract).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  clearEdgeConnectedBackground(data, info.width, info.height, info.channels, {
    minAverage: options.minAverage ?? 218,
    maxSpread: options.maxSpread ?? 38,
  });
  if (typeof options.discardComponentsStartingBelow === "number") {
    discardAlphaComponentsStartingBelow(data, info.width, info.height, info.channels, options.discardComponentsStartingBelow);
  }
  if (typeof options.discardComponentsBelowPixels === "number") {
    discardSmallAlphaComponents(data, info.width, info.height, info.channels, options.discardComponentsBelowPixels);
  }
  paintTransparentPixels(data, info.channels);
  const padding = normalizePadding(options.padding ?? 0);
  await sharp(data, {
    raw: {
      width: info.width,
      height: info.height,
      channels: info.channels,
    },
  })
    .trim({ background: { r: 255, g: 255, b: 255, alpha: 0 } })
    .extend({
      top: padding.top,
      right: padding.right,
      bottom: padding.bottom,
      left: padding.left,
      background: { r: 255, g: 255, b: 255, alpha: 0 },
    })
    .png()
    .toFile(output);
}

function normalizePadding(padding: CropPadding): { top: number; right: number; bottom: number; left: number } {
  if (typeof padding === "number") {
    return { top: padding, right: padding, bottom: padding, left: padding };
  }
  return {
    top: padding.top ?? 0,
    right: padding.right ?? 0,
    bottom: padding.bottom ?? 0,
    left: padding.left ?? 0,
  };
}

function clearEdgeConnectedBackground(
  data: Buffer,
  width: number,
  height: number,
  channels: number,
  options: { minAverage: number; maxSpread: number },
): void {
  const seen = new Uint8Array(width * height);
  const stack: number[] = [];

  for (let x = 0; x < width; x += 1) {
    pushIfBackground(x, 0);
    pushIfBackground(x, height - 1);
  }
  for (let y = 1; y < height - 1; y += 1) {
    pushIfBackground(0, y);
    pushIfBackground(width - 1, y);
  }

  while (stack.length) {
    const index = stack.pop()!;
    const x = index % width;
    const y = Math.floor(index / width);
    data[index * channels + 3] = 0;
    pushIfBackground(x + 1, y);
    pushIfBackground(x - 1, y);
    pushIfBackground(x, y + 1);
    pushIfBackground(x, y - 1);
  }

  function pushIfBackground(x: number, y: number): void {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const index = y * width + x;
    if (seen[index]) return;
    seen[index] = 1;
    if (isBackgroundPixel(index * channels, data, options.minAverage, options.maxSpread)) stack.push(index);
  }
}

function clearFlatBackground(data: Buffer, channels: number, threshold: number, maxSpread: number): void {
  for (let i = 0; i < data.length; i += channels) {
    if (isBackgroundPixel(i, data, threshold, maxSpread)) {
      data[i + 3] = 0;
    }
  }
}

function isBackgroundPixel(offset: number, data: Buffer, threshold: number, maxSpread: number): boolean {
  const alpha = data[offset + 3] ?? 255;
  if (alpha === 0) return true;
  const r = data[offset] ?? 0;
  const g = data[offset + 1] ?? 0;
  const b = data[offset + 2] ?? 0;
  const spread = Math.max(r, g, b) - Math.min(r, g, b);
  const average = (r + g + b) / 3;
  return average > threshold && spread < maxSpread;
}

function paintTransparentPixels(data: Buffer, channels: number): void {
  for (let i = 0; i < data.length; i += channels) {
    if ((data[i + 3] ?? 255) === 0) {
      data[i] = 255;
      data[i + 1] = 255;
      data[i + 2] = 255;
    }
  }
}

function discardSmallAlphaComponents(
  data: Buffer,
  width: number,
  height: number,
  channels: number,
  minPixels: number,
): void {
  const seen = new Uint8Array(width * height);
  const stack: number[] = [];
  const component: number[] = [];

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const startIndex = y * width + x;
      if (seen[startIndex] || !(data[startIndex * channels + 3] ?? 0)) continue;
      component.length = 0;
      seen[startIndex] = 1;
      stack.push(startIndex);

      while (stack.length) {
        const index = stack.pop()!;
        component.push(index);
        const cx = index % width;
        const cy = Math.floor(index / width);
        pushOpaque(cx + 1, cy);
        pushOpaque(cx - 1, cy);
        pushOpaque(cx, cy + 1);
        pushOpaque(cx, cy - 1);
      }

      if (component.length < minPixels) {
        for (const index of component) data[index * channels + 3] = 0;
      }
    }
  }

  function pushOpaque(x: number, y: number): void {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const index = y * width + x;
    if (seen[index]) return;
    seen[index] = 1;
    if (data[index * channels + 3]) stack.push(index);
  }
}

function discardAlphaComponentsStartingBelow(
  data: Buffer,
  width: number,
  height: number,
  channels: number,
  maxTop: number,
): void {
  const seen = new Uint8Array(width * height);
  const stack: number[] = [];
  const component: number[] = [];

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const startIndex = y * width + x;
      if (seen[startIndex] || !(data[startIndex * channels + 3] ?? 0)) continue;
      let minY = y;
      component.length = 0;
      seen[startIndex] = 1;
      stack.push(startIndex);

      while (stack.length) {
        const index = stack.pop()!;
        component.push(index);
        const cx = index % width;
        const cy = Math.floor(index / width);
        minY = Math.min(minY, cy);
        pushOpaque(cx + 1, cy);
        pushOpaque(cx - 1, cy);
        pushOpaque(cx, cy + 1);
        pushOpaque(cx, cy - 1);
      }

      if (minY > maxTop) {
        for (const index of component) data[index * channels + 3] = 0;
      }
    }
  }

  function pushOpaque(x: number, y: number): void {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const index = y * width + x;
    if (seen[index]) return;
    seen[index] = 1;
    if (data[index * channels + 3]) stack.push(index);
  }
}

await transparentCrop("sowsear-art.png", `${outDir}/brand-pig.png`, {
  left: 0,
  top: 280,
  width: 470,
  height: 425,
}, {
  minAverage: 205,
  maxSpread: 46,
  padding: { top: 10, right: 14, bottom: 16, left: 10 },
});

await transparentCrop("sowsear-art.png", `${outDir}/brand-title.png`, {
  left: 285,
  top: 0,
  width: 870,
  height: 218,
}, {
  minAverage: 205,
  maxSpread: 46,
  discardComponentsStartingBelow: 150,
  discardComponentsBelowPixels: 700,
  padding: { top: 10, right: 16, bottom: 18, left: 16 },
});

const source = sharp("sowsear-letters.png").ensureAlpha();
const { data, info } = await source.raw().toBuffer({ resolveWithObject: true });

clearFlatBackground(data, info.channels, 214, 14);

const cleanBuffer = await sharp(data, {
  raw: {
    width: info.width,
    height: info.height,
    channels: info.channels,
  },
})
  .png()
  .toBuffer();

const rows = 26;
const columns = 10;
const cellLeft = 0;
const cellRight = Math.floor(info.width / columns);

for (let row = 0; row < rows; row += 1) {
  const letter = String.fromCharCode("A".charCodeAt(0) + row);
  const top = Math.floor(row * (info.height / rows));
  const bottom = Math.floor((row + 1) * (info.height / rows));
  await sharp(cleanBuffer)
    .extract({
      left: cellLeft,
      top,
      width: cellRight - cellLeft,
      height: bottom - top,
    })
    .resize({ height: 40, fit: "inside", withoutEnlargement: true })
    .png()
    .toFile(`${outDir}/letters/${letter}.png`);
}
