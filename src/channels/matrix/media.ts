// src/channels/matrix/media.ts
import { randomUUID } from "node:crypto";
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

export interface MatrixMediaCandidate {
  mxcUrl: string;
  msgtype: string;
  filename?: string;
  mimeType?: string;
  sizeBytes?: number;
  isVoice?: boolean;
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

  const url = content.url as string | undefined;
  if (!url?.startsWith("mxc://")) return null;

  const info = content.info as Record<string, unknown> | undefined;
  const mimeType =
    (info?.mimetype as string | undefined) ??
    (content.filename
      ? inferMimeTypeFromExtension(content.filename as string)
      : undefined);

  return {
    mxcUrl: url,
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

export async function downloadMatrixAttachment(
  candidate: MatrixMediaCandidate,
  buffer: ArrayBuffer,
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

  const downloaded = Buffer.from(buffer);

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
