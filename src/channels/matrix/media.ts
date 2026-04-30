// src/channels/matrix/media.ts
import { createDecipheriv, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { getChannelDir } from "../config";
import type { ChannelMessageAttachment } from "../types";

export const MATRIX_DEFAULT_MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024;
export const MATRIX_INLINE_IMAGE_MAX_BYTES = 5 * 1024 * 1024;

// Maps Matrix msgtype to our attachment kind
export function matrixMsgtypeToKind(
  msgtype: string,
  mimeType?: string,
): "image" | "video" | "audio" | "file" {
  if (msgtype === "m.image") return "image";
  if (msgtype === "m.video") return "video";
  if (msgtype === "m.audio") return "audio";
  if (msgtype === "m.file") {
    if (mimeType?.startsWith("image/")) return "image";
    if (mimeType?.startsWith("video/")) return "video";
    if (mimeType?.startsWith("audio/")) return "audio";
    return "file";
  }
  return "file";
}

// Maps kind back to Matrix msgtype for uploads
export function kindToMatrixMsgtype(mimeType: string): string {
  if (mimeType.startsWith("image/")) return "m.image";
  if (mimeType.startsWith("video/")) return "m.video";
  if (mimeType.startsWith("audio/")) return "m.audio";
  return "m.file";
}

export function inferMimeTypeFromExtension(filename: string): string {
  const ext = extname(filename).toLowerCase();
  const map: Record<string, string> = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".mp4": "video/mp4",
    ".mov": "video/quicktime",
    ".webm": "video/webm",
    ".mp3": "audio/mpeg",
    ".ogg": "audio/ogg",
    ".opus": "audio/opus",
    ".m4a": "audio/mp4",
    ".pdf": "application/pdf",
  };
  return map[ext] ?? "application/octet-stream";
}

// Matrix EncryptedFile (MSC1767 / Matrix spec section on end-to-end encryption)
// Present in content.file for media in E2EE rooms.
export interface MatrixEncryptedFile {
  url: string;
  key: {
    kty: string;
    key_ops: string[];
    alg: string;
    k: string; // base64url-encoded 256-bit AES key
    ext: boolean;
  };
  iv: string; // base64url-encoded 16-byte IV (AES-256-CTR)
  hashes: {
    sha256: string; // base64url-encoded SHA-256 of ciphertext
  };
  v: string; // "v2"
}

export interface MatrixMediaCandidate {
  mxcUrl: string;
  msgtype: string;
  filename?: string;
  mimeType?: string;
  sizeBytes?: number;
  isVoice?: boolean;
  /** Present when the media is encrypted (E2EE room). Caller must decrypt before use. */
  encryptedFile?: MatrixEncryptedFile;
}

function parseBase64Url(b64url: string): Buffer {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64.padEnd(b64.length + ((4 - (b64.length % 4)) % 4), "=");
  return Buffer.from(padded, "base64");
}

/**
 * Decrypt a Matrix encrypted attachment downloaded from an E2EE room.
 * Matrix uses AES-256-CTR with a JWK key and 128-bit IV per the spec.
 */
export function decryptMatrixAttachment(
  encrypted: ArrayBuffer | Buffer,
  file: MatrixEncryptedFile,
): Buffer {
  const key = parseBase64Url(file.key.k);
  const iv = parseBase64Url(file.iv);
  const decipher = createDecipheriv("aes-256-ctr", key, iv);
  const data = Buffer.isBuffer(encrypted) ? encrypted : Buffer.from(encrypted);
  return Buffer.concat([decipher.update(data), decipher.final()]);
}

export function collectMatrixMediaCandidate(
  event: Record<string, unknown>,
): MatrixMediaCandidate | null {
  const content = event.content as Record<string, unknown> | undefined;
  if (!content) return null;

  const msgtype = content.msgtype as string | undefined;
  if (
    !msgtype ||
    !["m.image", "m.video", "m.audio", "m.file"].includes(msgtype)
  ) {
    return null;
  }

  const info = content.info as Record<string, unknown> | undefined;

  // Non-E2EE: media URL is in content.url
  const plainUrl = content.url as string | undefined;
  if (plainUrl?.startsWith("mxc://")) {
    const mimeType =
      (info?.mimetype as string | undefined) ??
      (content.filename
        ? inferMimeTypeFromExtension(content.filename as string)
        : undefined);

    return {
      mxcUrl: plainUrl,
      msgtype,
      filename:
        (content.filename as string | undefined) ??
        (content.body as string | undefined),
      mimeType,
      sizeBytes: info?.size as number | undefined,
      isVoice:
        msgtype === "m.audio" &&
        (content["org.matrix.msc3245.voice"] != null || content.voice != null),
    };
  }

  // E2EE: media URL and encryption info are in content.file
  const encryptedFile = content.file as Record<string, unknown> | undefined;
  const encryptedUrl = encryptedFile?.url as string | undefined;
  if (!encryptedUrl?.startsWith("mxc://")) return null;

  // Validate the encrypted file object has the fields we need for decryption
  const key = encryptedFile?.key as Record<string, unknown> | undefined;
  const iv = encryptedFile?.iv as string | undefined;
  const hashes = encryptedFile?.hashes as Record<string, unknown> | undefined;
  if (!key?.k || !iv || !hashes?.sha256) {
    console.warn(
      "[matrix] E2EE media found but missing key/iv/hashes — cannot decrypt",
    );
    return null;
  }

  const mimeType =
    (info?.mimetype as string | undefined) ??
    (content.filename
      ? inferMimeTypeFromExtension(content.filename as string)
      : undefined);

  const parsedFile: MatrixEncryptedFile = {
    url: encryptedUrl,
    key: {
      kty: (key.kty as string | undefined) ?? "oct",
      key_ops: (key.key_ops as string[] | undefined) ?? [],
      alg: (key.alg as string | undefined) ?? "A256CTR",
      k: key.k as string,
      ext: (key.ext as boolean | undefined) ?? true,
    },
    iv,
    hashes: { sha256: hashes.sha256 as string },
    v: (encryptedFile?.v as string | undefined) ?? "v2",
  };

  return {
    mxcUrl: encryptedUrl,
    msgtype,
    filename:
      (content.filename as string | undefined) ??
      (content.body as string | undefined),
    mimeType,
    sizeBytes: info?.size as number | undefined,
    isVoice:
      msgtype === "m.audio" &&
      (content["org.matrix.msc3245.voice"] != null || content.voice != null),
    encryptedFile: parsedFile,
  };
}

export async function downloadMatrixAttachment(
  candidate: MatrixMediaCandidate,
  buffer: ArrayBuffer | Buffer,
  accountId: string,
  maxBytes: number,
  transcribeVoice: boolean,
): Promise<ChannelMessageAttachment | null> {
  if (candidate.sizeBytes != null && candidate.sizeBytes > maxBytes) {
    console.warn(
      `[matrix] Skipping attachment: size ${candidate.sizeBytes} exceeds limit ${maxBytes}`,
    );
    return null;
  }

  if (buffer.byteLength > maxBytes) {
    console.warn(
      `[matrix] Skipping attachment: downloaded size ${buffer.byteLength} exceeds limit ${maxBytes}`,
    );
    return null;
  }

  const bufferNorm = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  let downloaded: Buffer;
  if (candidate.encryptedFile) {
    try {
      downloaded = decryptMatrixAttachment(bufferNorm, candidate.encryptedFile);
    } catch (err) {
      console.warn(
        "[matrix] Failed to decrypt E2EE attachment:",
        err instanceof Error ? err.message : err,
      );
      return null;
    }
  } else {
    downloaded = bufferNorm;
  }

  const ext = candidate.filename ? extname(candidate.filename) : "";
  const filename = `${Date.now()}-${randomUUID()}${ext || ".bin"}`;
  const dir = join(getChannelDir("matrix"), "inbound", accountId);
  await mkdir(dir, { recursive: true });
  const localPath = join(dir, filename);
  await writeFile(localPath, downloaded);

  const mimeType = candidate.mimeType ?? inferMimeTypeFromExtension(filename);
  const kind = matrixMsgtypeToKind(candidate.msgtype, mimeType);

  const attachment: ChannelMessageAttachment = {
    name: candidate.filename,
    mimeType,
    sizeBytes: downloaded.byteLength,
    kind,
    localPath,
  };

  if (
    kind === "image" &&
    downloaded.byteLength <= MATRIX_INLINE_IMAGE_MAX_BYTES
  ) {
    attachment.imageDataBase64 = downloaded.toString("base64");
  }

  if (candidate.isVoice && transcribeVoice) {
    const { transcribeAudioFile } = await import("../transcription/index");
    const result = await transcribeAudioFile(localPath);
    if (result.success && result.text) {
      attachment.transcription = result.text;
    }
  }

  return attachment;
}
