'use strict';

const fs = require('fs');
const { PNG } = require('pngjs');

// Screenshots are the dominant context cost for an agent playing a game: a
// 1280x720 PNG is roughly 1200 tokens. Frames are downscaled by default so a
// long navigation stays affordable, and only widened on explicit request.
const DEFAULT_SCALE = 0.5;

function readPng(file) {
  return PNG.sync.read(fs.readFileSync(file));
}

function clampScale(scale) {
  const value = Number(scale);
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_SCALE;
  return Math.min(1, value);
}

// Box filter. Averaging over the source rectangle keeps thin game sprites and
// small UI text legible, which nearest-neighbour sampling loses.
function resize(source, scale) {
  const ratio = clampScale(scale);
  if (ratio === 1) return source;
  const width = Math.max(1, Math.round(source.width * ratio));
  const height = Math.max(1, Math.round(source.height * ratio));
  const target = new PNG({ width, height });

  for (let y = 0; y < height; y += 1) {
    const topEdge = Math.floor((y * source.height) / height);
    const bottomEdge = Math.max(topEdge + 1, Math.floor(((y + 1) * source.height) / height));
    for (let x = 0; x < width; x += 1) {
      const leftEdge = Math.floor((x * source.width) / width);
      const rightEdge = Math.max(leftEdge + 1, Math.floor(((x + 1) * source.width) / width));
      let red = 0;
      let green = 0;
      let blue = 0;
      let samples = 0;
      for (let sourceY = topEdge; sourceY < bottomEdge; sourceY += 1) {
        for (let sourceX = leftEdge; sourceX < rightEdge; sourceX += 1) {
          const index = (source.width * sourceY + sourceX) << 2;
          red += source.data[index];
          green += source.data[index + 1];
          blue += source.data[index + 2];
          samples += 1;
        }
      }
      const out = (width * y + x) << 2;
      target.data[out] = Math.round(red / samples);
      target.data[out + 1] = Math.round(green / samples);
      target.data[out + 2] = Math.round(blue / samples);
      target.data[out + 3] = 255;
    }
  }
  return target;
}

// Clamped so a model-supplied region can never throw; an out-of-bounds ask
// yields the nearest valid rectangle instead of failing the turn.
function crop(source, region) {
  const x = Math.max(0, Math.min(Math.round(Number(region.x) || 0), source.width - 1));
  const y = Math.max(0, Math.min(Math.round(Number(region.y) || 0), source.height - 1));
  const width = Math.max(1, Math.min(Math.round(Number(region.width) || 0), source.width - x));
  const height = Math.max(1, Math.min(Math.round(Number(region.height) || 0), source.height - y));
  const target = new PNG({ width, height });
  PNG.bitblt(source, target, x, y, width, height, 0, 0);
  return { png: target, region: { x, y, width, height } };
}

function encode(png) {
  return PNG.sync.write(png).toString('base64');
}

// Reads a screenshot off disk and returns an MCP image content block plus the
// dimensions actually sent, so a caller can map coordinates back if needed.
function imageBlock(file, options = {}) {
  let png = readPng(file);
  let region = null;
  if (options.region) {
    const cropped = crop(png, options.region);
    png = cropped.png;
    region = cropped.region;
  }
  const scale = options.fullRes ? 1 : clampScale(options.scale ?? DEFAULT_SCALE);
  const sourceWidth = png.width;
  const sourceHeight = png.height;
  png = resize(png, scale);
  return {
    block: { type: 'image', data: encode(png), mimeType: 'image/png' },
    width: png.width,
    height: png.height,
    sourceWidth,
    sourceHeight,
    scale,
    region,
  };
}

module.exports = {
  DEFAULT_SCALE,
  clampScale,
  crop,
  encode,
  imageBlock,
  readPng,
  resize,
};
