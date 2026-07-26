const crypto = require("crypto");
const { executionError } = require("../execution.errors");

const MIME_SIGNATURES = Object.freeze({
  "image/jpeg": (buffer) => buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer.at(-2) === 0xff && buffer.at(-1) === 0xd9,
  "image/png": (buffer) => buffer.length >= 33 && buffer.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")) && buffer.subarray(12, 16).toString("ascii") === "IHDR",
  "image/webp": (buffer) => buffer.length >= 30 && buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP",
  "video/mp4": (buffer) => buffer.length >= 32 && buffer.subarray(4, 8).toString("ascii") === "ftyp",
  "video/webm": (buffer) => buffer.length >= 16 && buffer.subarray(0, 4).equals(Buffer.from("1a45dfa3", "hex")),
});
const EXECUTABLE_SIGNATURES = [Buffer.from("4d5a", "hex"), Buffer.from("7f454c46", "hex"), Buffer.from("2321", "hex")];

function ratioMatches(width, height, accepted = [], tolerance = 0.01) {
  if (!accepted.length) return true;
  return accepted.some((ratio) => {
    const match = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(String(ratio));
    return match && Math.abs(width / height - Number(match[1]) / Number(match[2])) <= tolerance;
  });
}

function jpegDimensions(buffer) {
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) { offset += 1; continue; }
    const marker = buffer[offset + 1];
    if (marker === 0xd8 || marker === 0xd9) { offset += 2; continue; }
    const length = buffer.readUInt16BE(offset + 2);
    if (length < 2 || offset + 2 + length > buffer.length) break;
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      return { width: buffer.readUInt16BE(offset + 7), height: buffer.readUInt16BE(offset + 5), frameCount: 1, hasTransparency: false };
    }
    offset += 2 + length;
  }
  throw executionError("INVALID_EXECUTION_PLAN", { field: "media", reasonCode: "MALFORMED_OR_TRUNCATED_MEDIA" });
}

function webpDimensions(buffer) {
  const chunk = buffer.subarray(12, 16).toString("ascii");
  if (chunk === "VP8X" && buffer.length >= 30) {
    return {
      width: 1 + buffer.readUIntLE(24, 3), height: 1 + buffer.readUIntLE(27, 3),
      frameCount: buffer[20] & 0x02 ? null : 1, hasTransparency: Boolean(buffer[20] & 0x10),
    };
  }
  if (chunk === "VP8 " && buffer.length >= 30 && buffer.subarray(23, 26).equals(Buffer.from("9d012a", "hex"))) {
    return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff, frameCount: 1, hasTransparency: false };
  }
  if (chunk === "VP8L" && buffer.length >= 25 && buffer[20] === 0x2f) {
    const bits = buffer.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1, frameCount: 1, hasTransparency: true };
  }
  throw executionError("INVALID_EXECUTION_PLAN", { field: "media", reasonCode: "MALFORMED_OR_TRUNCATED_MEDIA" });
}

function findMp4Box(buffer, name, start = 0, end = buffer.length) {
  let offset = start;
  while (offset + 8 <= end) {
    let size = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString("ascii");
    if (size === 1) { if (offset + 16 > end) break; size = Number(buffer.readBigUInt64BE(offset + 8)); }
    if (size < 8 || offset + size > end) break;
    if (type === name) return { offset, size, header: size === 1 ? 16 : 8 };
    offset += size;
  }
  return null;
}

function mp4Metadata(buffer) {
  const moov = findMp4Box(buffer, "moov");
  if (!moov) throw executionError("INVALID_EXECUTION_PLAN", { field: "media", reasonCode: "MALFORMED_OR_TRUNCATED_MEDIA" });
  const mvhd = findMp4Box(buffer, "mvhd", moov.offset + moov.header, moov.offset + moov.size);
  let durationMs = null;
  if (mvhd) {
    const base = mvhd.offset + mvhd.header;
    const version = buffer[base];
    const timescaleOffset = base + (version === 1 ? 20 : 12);
    const durationOffset = timescaleOffset + 4;
    const timescale = buffer.readUInt32BE(timescaleOffset);
    const duration = version === 1 ? Number(buffer.readBigUInt64BE(durationOffset)) : buffer.readUInt32BE(durationOffset);
    if (timescale > 0) durationMs = Math.round(duration / timescale * 1000);
  }
  let width = null; let height = null;
  let cursor = moov.offset + moov.header;
  while ((cursor = buffer.indexOf(Buffer.from("tkhd"), cursor)) !== -1 && cursor < moov.offset + moov.size) {
    const boxOffset = cursor - 4;
    const size = boxOffset >= 0 ? buffer.readUInt32BE(boxOffset) : 0;
    if (size >= 84 && boxOffset + size <= buffer.length) {
      width = buffer.readUInt32BE(boxOffset + size - 8) / 65536;
      height = buffer.readUInt32BE(boxOffset + size - 4) / 65536;
      if (width && height) break;
    }
    cursor += 4;
  }
  if (!durationMs || !width || !height) throw executionError("INVALID_EXECUTION_PLAN", { field: "media", reasonCode: "MANDATORY_MEDIA_METADATA_UNAVAILABLE" });
  return { width, height, durationMs, container: "mp4", codec: buffer.subarray(8, 12).toString("ascii"), hasAudio: buffer.includes(Buffer.from("soun")), frameCount: null, hasTransparency: null };
}

function extractMediaMetadata(buffer, mimeType) {
  if (!MIME_SIGNATURES[mimeType]?.(buffer)) throw executionError("INVALID_EXECUTION_PLAN", { field: "media.mimeType", reasonCode: "MIME_OR_SIGNATURE_NOT_ALLOWED" });
  if (EXECUTABLE_SIGNATURES.some((signature) => buffer.subarray(0, signature.length).equals(signature))) {
    throw executionError("INVALID_EXECUTION_PLAN", { field: "media", reasonCode: "EXECUTABLE_OR_POLYGLOT_MEDIA" });
  }
  if (mimeType === "image/png") {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20), frameCount: buffer.includes(Buffer.from("acTL")) ? null : 1, hasTransparency: [4, 6].includes(buffer[25]), durationMs: null, codec: "png", container: "png", hasAudio: false };
  }
  if (mimeType === "image/jpeg") return { ...jpegDimensions(buffer), durationMs: null, codec: "jpeg", container: "jpeg", hasAudio: false };
  if (mimeType === "image/webp") return { ...webpDimensions(buffer), durationMs: null, codec: "webp", container: "webp", hasAudio: false };
  if (mimeType === "video/mp4") return mp4Metadata(buffer);
  throw executionError("PROVIDER_CAPABILITY_UNAVAILABLE", { field: "media", reasonCode: "MEDIA_METADATA_PARSER_UNAVAILABLE", mimeType });
}

async function validateMedia(input, {
  limits = {}, malwareScanner = null, checksumLookup = null,
  maxInputBytes = 250 * 1024 * 1024, scanFailurePolicy = "BLOCK",
} = {}) {
  const buffer = input?.bytes;
  if (!Buffer.isBuffer(buffer)) throw executionError("INVALID_EXECUTION_PLAN", { field: "media.bytes", reasonCode: "MEDIA_BYTES_REQUIRED" });
  if (!buffer.length || buffer.length > maxInputBytes) throw executionError("INVALID_EXECUTION_PLAN", { field: "media.bytes", reasonCode: "MEDIA_INPUT_BOUNDS_EXCEEDED" });
  const mimeType = String(input.mimeType || "").toLowerCase();
  if (!limits.allowedMimeTypes?.includes(mimeType)) throw executionError("INVALID_EXECUTION_PLAN", { field: "media.mimeType", reasonCode: "MIME_OR_SIGNATURE_NOT_ALLOWED" });
  const metadata = extractMediaMetadata(buffer, mimeType);
  if (limits.maxBytes != null && buffer.length > limits.maxBytes) throw executionError("INVALID_EXECUTION_PLAN", { field: "media.bytes", reasonCode: "MEDIA_TOO_LARGE" });
  if (limits.minWidth && metadata.width < limits.minWidth || limits.maxWidth && metadata.width > limits.maxWidth || limits.minHeight && metadata.height < limits.minHeight || limits.maxHeight && metadata.height > limits.maxHeight) throw executionError("INVALID_EXECUTION_PLAN", { field: "media.dimensions", reasonCode: "MEDIA_DIMENSIONS_UNSUPPORTED" });
  if (!ratioMatches(metadata.width, metadata.height, limits.aspectRatios, limits.aspectRatioTolerance)) throw executionError("INVALID_EXECUTION_PLAN", { field: "media.aspectRatio", reasonCode: "MEDIA_ASPECT_RATIO_UNSUPPORTED" });
  const durationSeconds = metadata.durationMs == null ? null : metadata.durationMs / 1000;
  if (mimeType.startsWith("video/") && (limits.maxDurationSeconds && durationSeconds > limits.maxDurationSeconds || limits.minDurationSeconds && durationSeconds < limits.minDurationSeconds)) throw executionError("INVALID_EXECUTION_PLAN", { field: "media.durationSeconds", reasonCode: "MEDIA_DURATION_UNSUPPORTED" });
  if (limits.allowedCodecs?.length && !limits.allowedCodecs.includes(metadata.codec)) throw executionError("INVALID_EXECUTION_PLAN", { field: "media.codec", reasonCode: "MEDIA_CODEC_UNSUPPORTED" });
  const checksum = crypto.createHash("sha256").update(buffer).digest("hex");
  const duplicate = checksumLookup ? await checksumLookup(checksum) : null;
  let scan = { status: "NOT_CONFIGURED", scanner: null };
  if (malwareScanner) scan = await malwareScanner.scan(buffer, { checksum, mimeType, timeoutMs: 5000, maxResponseBytes: 4096 });
  const malwareScanStatus = String(scan?.status || "UNKNOWN").toUpperCase();
  if (!["NOT_CONFIGURED", "PENDING", "CLEAN", "INFECTED", "ERROR", "UNKNOWN"].includes(malwareScanStatus)) scan.status = "UNKNOWN";
  const mustBlock = malwareScanStatus === "INFECTED" || malwareScanStatus === "PENDING" ||
    (malwareScanStatus !== "CLEAN" && (limits.malwareScanRequired || scanFailurePolicy === "BLOCK"));
  if (mustBlock) throw executionError("INVALID_EXECUTION_PLAN", { field: "media", reasonCode: `MEDIA_MALWARE_${malwareScanStatus}` });
  return Object.freeze({ mimeType, byteLength: buffer.length, ...metadata, durationSeconds, checksum, duplicateMediaId: duplicate?.id || null, malwareScanStatus, scannerEvidence: { status: malwareScanStatus, scanner: scan?.scanner || null, checkedAt: scan?.checkedAt || null } });
}

module.exports = { MIME_SIGNATURES, ratioMatches, extractMediaMetadata, validateMedia };
