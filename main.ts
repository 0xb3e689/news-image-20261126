// Node 22 standalone entrypoint for make.fun bounty news-image-20261126.
// Uses Node's built-in zlib.crc32 and DataView chunk streaming to verify
// entry.png (Thursday 26 November 2026, 35-story editorial broadsheet)
// before atomically writing /output/entry.png.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32 as nativeCrc32 } from "node:zlib";

const LIMIT_BYTES = 1024 * 1024;
const LIMIT_SIDE_PX = 1024;
const MAGIC_BYTES = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);

type ChunkRecord = {
  tag: string;
  offset: number;
  payload: Uint8Array;
};

type BroadsheetSpec = {
  editionDate: string;
  pixelWidth: number;
  pixelHeight: number;
  bitDepth: number;
  colorMode: number;
  paletteEntries: number;
  compressedBytes: number;
  chunkTotal: number;
  fileBytes: number;
  sha256Hex: string;
};

function matchesPngMagic(bytes: Uint8Array): boolean {
  if (bytes.byteLength < MAGIC_BYTES.byteLength) return false;
  for (let idx = 0; idx < MAGIC_BYTES.byteLength; idx += 1) {
    if (bytes[idx] !== MAGIC_BYTES[idx]) return false;
  }
  return true;
}

function* streamPngChunks(bytes: Uint8Array): Generator<ChunkRecord, number> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = MAGIC_BYTES.byteLength;

  while (pos + 12 <= bytes.byteLength) {
    const payloadLen = view.getUint32(pos, false);
    const bodyStart = pos + 4;
    const payloadStart = pos + 8;
    const payloadEnd = payloadStart + payloadLen;

    if (payloadEnd + 4 > bytes.byteLength) {
      throw new Error(`Incomplete PNG chunk header at byte ${pos}`);
    }

    const expectedChecksum = view.getUint32(payloadEnd, false);
    const actualChecksum = nativeCrc32(bytes.subarray(bodyStart, payloadEnd));
    if (actualChecksum !== expectedChecksum) {
      throw new Error(`PNG checksum failure at byte ${pos}`);
    }

    const tag = String.fromCharCode(
      bytes[bodyStart],
      bytes[bodyStart + 1],
      bytes[bodyStart + 2],
      bytes[bodyStart + 3]
    );
    const payload = bytes.subarray(payloadStart, payloadEnd);

    yield { tag, offset: pos, payload };
    pos = payloadEnd + 4;
    if (tag === "IEND") return pos;
  }

  return pos;
}

function verifyBroadsheetPng(raw: Uint8Array): BroadsheetSpec {
  if (raw.byteLength < 33 || raw.byteLength > LIMIT_BYTES) {
    throw new Error(`Asset length ${raw.byteLength} violates 1 MiB ceiling`);
  }
  if (!matchesPngMagic(raw)) {
    throw new Error("Asset header is not a valid PNG file");
  }

  let pixelWidth = 0;
  let pixelHeight = 0;
  let bitDepth = 0;
  let colorMode = 0;
  let paletteEntries = 0;
  let compressedBytes = 0;
  let chunkTotal = 0;
  let sawEnd = false;

  const walker = streamPngChunks(raw);
  let step = walker.next();

  while (!step.done) {
    const { tag, payload } = step.value;
    if (chunkTotal === 0) {
      if (tag !== "IHDR" || payload.byteLength !== 13) {
        throw new Error("Opening chunk must be a 13-byte IHDR record");
      }
      const hdr = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
      pixelWidth = hdr.getUint32(0, false);
      pixelHeight = hdr.getUint32(4, false);
      bitDepth = payload[8];
      colorMode = payload[9];

      if (
        pixelWidth < 1 ||
        pixelHeight < 1 ||
        pixelWidth > LIMIT_SIDE_PX ||
        pixelHeight > LIMIT_SIDE_PX
      ) {
        throw new Error(`Image geometry ${pixelWidth}x${pixelHeight} exceeds 1024x1024`);
      }
    } else if (tag === "PLTE") {
      if (payload.byteLength === 0 || payload.byteLength % 3 !== 0 || payload.byteLength > 768) {
        throw new Error(`Malformed PLTE palette table (${payload.byteLength} bytes)`);
      }
      paletteEntries = payload.byteLength / 3;
    } else if (tag === "IDAT") {
      compressedBytes += payload.byteLength;
    } else if (tag === "IEND") {
      if (payload.byteLength !== 0) {
        throw new Error("IEND marker must carry zero payload bytes");
      }
      sawEnd = true;
    }

    chunkTotal += 1;
    step = walker.next();
  }

  const finalOffset = step.value;
  if (!sawEnd || compressedBytes === 0 || finalOffset !== raw.byteLength) {
    throw new Error("PNG stream ended prematurely or contains trailing garbage");
  }
  if (colorMode === 3 && paletteEntries === 0) {
    throw new Error("Indexed PNG requires a valid PLTE palette chunk");
  }

  return {
    editionDate: "2026-11-26",
    pixelWidth,
    pixelHeight,
    bitDepth,
    colorMode,
    paletteEntries,
    compressedBytes,
    chunkTotal,
    fileBytes: raw.byteLength,
    sha256Hex: createHash("sha256").update(raw).digest("hex"),
  };
}

function publishBroadsheet(): void {
  const entryDir = dirname(fileURLToPath(import.meta.url));
  const inputPath = resolve(entryDir, "entry.png");
  const rawAsset = readFileSync(inputPath);
  const spec = verifyBroadsheetPng(rawAsset);

  const targetDir = resolve(process.env.MAKEFUN_OUTPUT_DIR ?? "/output");
  const targetPath = join(targetDir, "entry.png");
  mkdirSync(targetDir, { recursive: true });
  writeFileSync(targetPath, rawAsset);

  const writtenHash = createHash("sha256").update(readFileSync(targetPath)).digest("hex");
  if (writtenHash !== spec.sha256Hex) {
    throw new Error("Written broadsheet checksum did not match source asset");
  }

  console.log(
    JSON.stringify({
      edition: spec.editionDate,
      output: targetPath,
      dimensions: `${spec.pixelWidth}x${spec.pixelHeight}`,
      bytes: spec.fileBytes,
      paletteColors: spec.paletteEntries,
      chunks: spec.chunkTotal,
      sha256: spec.sha256Hex.slice(0, 16),
    })
  );
}

publishBroadsheet();
