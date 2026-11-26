// Standalone Node 22 entrypoint for make.fun competition news-image-20261126.
// Validates PNG header geometry, chunk CRC-32 checksums, and the 1 MiB byte cap,
// then deterministically writes the verified Thursday 26 November 2026 front page
// to /output/entry.png (or MAKEFUN_OUTPUT_DIR/entry.png for local checks).

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MAX_BYTES = 1_048_576;
const MAX_DIMENSION = 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function makeCrc32Lookup(): Uint32Array {
  const lut = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    lut[n] = c >>> 0;
  }
  return lut;
}

const CRC32_LUT = makeCrc32Lookup();

function crc32(bytes: Uint8Array): number {
  let state = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    state = CRC32_LUT[(state ^ bytes[i]) & 0xff] ^ (state >>> 8);
  }
  return (state ^ 0xffffffff) >>> 0;
}

interface VerifiedPngMeta {
  width: number;
  height: number;
  chunks: number;
  idatBytes: number;
  totalBytes: number;
  sha256: string;
}

function validatePngAsset(raw: Buffer): VerifiedPngMeta {
  if (raw.length < 33 || raw.length > MAX_BYTES) {
    throw new Error(`PNG size ${raw.length} out of bounds (33..${MAX_BYTES} bytes)`);
  }
  if (!raw.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error("Missing valid 8-byte PNG signature");
  }

  let cursor = 8;
  let width = 0;
  let height = 0;
  let chunks = 0;
  let idatBytes = 0;
  let colorType = 0;
  let foundIhdr = false;
  let foundPlte = false;
  let foundIend = false;

  while (cursor + 12 <= raw.length) {
    const length = raw.readUInt32BE(cursor);
    const kind = raw.subarray(cursor + 4, cursor + 8).toString("ascii");
    const payloadEnd = cursor + 8 + length;
    if (payloadEnd + 4 > raw.length) {
      throw new Error(`Truncated chunk ${kind} at offset ${cursor}`);
    }

    const storedCrc = raw.readUInt32BE(payloadEnd);
    const computedCrc = crc32(raw.subarray(cursor + 4, payloadEnd));
    if (computedCrc !== storedCrc) {
      throw new Error(`Chunk ${kind} failed CRC-32 check at offset ${cursor}`);
    }

    if (chunks === 0) {
      if (kind !== "IHDR" || length !== 13) {
        throw new Error("First PNG chunk must be a 13-byte IHDR");
      }
      width = raw.readUInt32BE(cursor + 8);
      height = raw.readUInt32BE(cursor + 12);
      const bitDepth = raw[cursor + 16];
      colorType = raw[cursor + 17];
      const allowedDepths = new Set([1, 2, 4, 8, 16]);
      const allowedColors = new Set([0, 2, 3, 4, 6]);
      if (width < 1 || height < 1 || width > MAX_DIMENSION || height > MAX_DIMENSION) {
        throw new Error(`Dimensions ${width}x${height} exceed ${MAX_DIMENSION}x${MAX_DIMENSION}`);
      }
      if (!allowedDepths.has(bitDepth) || !allowedColors.has(colorType)) {
        throw new Error(`Unsupported IHDR bitDepth=${bitDepth}, colorType=${colorType}`);
      }
      foundIhdr = true;
    } else if (kind === "PLTE") {
      if (length === 0 || length % 3 !== 0 || length > 768) {
        throw new Error(`Invalid PLTE palette length ${length}`);
      }
      foundPlte = true;
    } else if (kind === "IDAT") {
      idatBytes += length;
    } else if (kind === "IEND") {
      if (length !== 0) {
        throw new Error("IEND chunk must have length 0");
      }
      foundIend = true;
      cursor = payloadEnd + 4;
      chunks += 1;
      break;
    }

    cursor = payloadEnd + 4;
    chunks += 1;
  }

  if (!foundIhdr || !foundIend || idatBytes === 0 || cursor !== raw.length) {
    throw new Error("Incomplete PNG stream or trailing bytes after IEND");
  }
  if (colorType === 3 && !foundPlte) {
    throw new Error("Indexed-color PNG (colorType=3) is missing required PLTE palette chunk");
  }

  const sha256 = crypto.createHash("sha256").update(raw).digest("hex");
  return { width, height, chunks, idatBytes, totalBytes: raw.length, sha256 };
}

function main(): void {
  const repoRoot = path.dirname(fileURLToPath(import.meta.url));
  const sourceImage = path.resolve(repoRoot, "entry.png");
  const buffer = fs.readFileSync(sourceImage);
  const meta = validatePngAsset(buffer);

  const outDir = path.resolve(process.env.MAKEFUN_OUTPUT_DIR ?? "/output");
  const outPath = path.join(outDir, "entry.png");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outPath, buffer);

  const roundTripHash = crypto
    .createHash("sha256")
    .update(fs.readFileSync(outPath))
    .digest("hex");
  if (roundTripHash !== meta.sha256) {
    throw new Error("Output integrity hash mismatch after write");
  }

  console.log(
    `Wrote ${outPath} (${meta.width}x${meta.height}, ${meta.totalBytes} bytes, ${meta.chunks} chunks, sha256:${meta.sha256.slice(0, 12)})`
  );
}

main();
