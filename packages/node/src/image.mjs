// Image reads for Read: png/jpg/gif/webp are returned as base64 for MCP image content.
// The type comes from the file's magic bytes; dimensions are parsed from the header so
// images the Claude API would reject come back as a hint instead of an attachment.
import { readFile, stat } from 'node:fs/promises';

export const IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|webp)$/i;
export const IMAGE_MAX_BYTES = 3.75 * 1024 * 1024; // 5 MB once base64-encoded (API limit)
export const IMAGE_MAX_SIDE = 8000;

/** {mimeType, width, height} from the header, or null if the bytes are not a supported image. */
export function probeImage(b) {
  if (b.length >= 24 && b.readUInt32BE(0) === 0x89504e47) return { mimeType: 'image/png', width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  if (b.length >= 10 && b.toString('latin1', 0, 4) === 'GIF8') return { mimeType: 'image/gif', width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
  if (b.length >= 30 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') {
    const kind = b.toString('latin1', 12, 16);
    if (kind === 'VP8X') return { mimeType: 'image/webp', width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
    if (kind === 'VP8L') { const v = b.readUInt32LE(21); return { mimeType: 'image/webp', width: 1 + (v & 0x3fff), height: 1 + ((v >> 14) & 0x3fff) }; }
    return { mimeType: 'image/webp', width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    for (let i = 2; i + 9 < b.length;) {
      if (b[i] !== 0xff) { i++; continue; }
      const marker = b[i + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0xff) { i += marker === 0xff ? 1 : 2; continue; }
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { mimeType: 'image/jpeg', width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5) };
      }
      i += 2 + b.readUInt16BE(i + 2);
    }
    return { mimeType: 'image/jpeg', width: 0, height: 0 };
  }
  return null;
}

/** Read an image file. Returns null when the file is not a supported image (caller reads it as text). */
export async function readImage(abs, display) {
  const { size } = await stat(abs);
  const kb = `${Math.round(size / 1024)} KB`;
  const resize = 'Downscale it first, e.g. Bash: magick in.png -resize 1600x1600 out.png, or PowerShell System.Drawing';
  if (size > IMAGE_MAX_BYTES) {
    return { text: `Image not attached: ${display} is ${kb}, over the ${IMAGE_MAX_BYTES / 1024 / 1024} MiB limit. ${resize}.`, data: { path: display, size, attached: false } };
  }
  const bytes = await readFile(abs);
  const info = probeImage(bytes);
  if (!info) return null;
  const dims = `${info.width}x${info.height}`;
  if (info.width > IMAGE_MAX_SIDE || info.height > IMAGE_MAX_SIDE) {
    return { text: `Image not attached: ${display} is ${dims}, over ${IMAGE_MAX_SIDE} px per side. ${resize}.`, data: { path: display, size, ...info, attached: false } };
  }
  return { text: `Image: ${display} (${info.mimeType}, ${dims}, ${kb})`, data: { path: display, size, ...info, attached: true }, image: { mimeType: info.mimeType, data: bytes.toString('base64') } };
}
