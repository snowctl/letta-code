/**"
 * Voice memo transcription with local Whisper (Parakeet/faster-whisper) and cloud fallback.
 *
 * Priority:
 *   1. PARAKEET_WHISPER_URL — remote local Whisper API endpoint (most private)
 *   2. whisply CLI — local faster-whisper inference
 *   3. OPENAI_API_KEY — OpenAI Whisper cloud API (fallback)
 *
 * Outputs transcription with confidence scoring and XML wrapping for the agent.
 */

import { readFileSync } from "node:fs";
import { basename, extname } from "node:path";
import { execSync } from "node:child_process";

export interface TranscriptionResult {
  success: boolean;
  text?: string;
  confidence?: number; // 0-1 scale
  confidenceLabel?: "high" | "medium" | "low";
  error?: string;
}

/** XML-wrap transcribed text with confidence metadata for the agent. */
export function formatTranscribed(
  text: string,
  confidence: number,
): string {
  const label: "high" | "medium" | "low" =
    confidence > 0.9 ? "high" : confidence >= 0.7 ? "medium" : "low";
  const escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return `<transcribed confidence="${label}">${escaped}</transcribed>`;
}

const PARAKEET_WHISPER_URL = process.env.PARAKEET_WHISPER_URL || "";
const WHISPER_API_URL = "https://api.openai.com/v1/audio/transcriptions";
const TRANSCRIPTION_TIMEOUT_MS = 10_000;
const LOCAL_TRANSCRIPTION_TIMEOUT_MS = 60_000;

export function isCloudTranscriptionConfigured(): boolean {
  return !!process.env.OPENAI_API_KEY;
}

export function isLocalTranscriptionConfigured(): boolean {
  if (PARAKEET_WHISPER_URL) return true;
  try {
    execSync("which whisply 2>/dev/null || which whisper 2>/dev/null", {
      stdio: "pipe",
      timeout: 2_000,
    });
    return true;
  } catch {
    return false;
  }
}

export function isTranscriptionConfigured(): boolean {
  return isCloudTranscriptionConfigured() || isLocalTranscriptionConfigured();
}

function estimateConfidence(rawResult: { text: string }): number {
  // OpenAI API doesn't expose logprobs; conservative default
  return 0.9;
}

export async function transcribeAudioFile(
  localPath: string,
): Promise<TranscriptionResult> {
  if (PARAKEET_WHISPER_URL) {
    return transcribeViaLocalApi(localPath);
  }
  if (isLocalTranscriptionConfigured()) {
    return transcribeViaWhisply(localPath);
  }
  return transcribeViaCloudApi(localPath);
}

async function transcribeViaLocalApi(
  localPath: string,
): Promise<TranscriptionResult> {
  try {
    const buffer = readFileSync(localPath);
    const filename = basename(localPath);
    const formData = new FormData();
    formData.append("file", new Blob([buffer], { type: "audio/ogg" }), filename);
    formData.append("model", "whisper-1");
    formData.append("response_format", "verbose_json");

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), LOCAL_TRANSCRIPTION_TIMEOUT_MS);

    try {
      const response = await fetch(
        PARAKEET_WHISPER_URL + "/v1/audio/transcriptions",
        { method: "POST", body: formData, signal: controller.signal },
      );

      if (!response.ok) {
        const errorText = await response.text();
        return { success: false, error: "Local Whisper API error: " + errorText };
      }

      const data = (await response.json()) as {
        text: string;
        segments?: Array<{ avg_logprob?: number; no_speech_prob?: number }>;
      };

      let confidence = 0.9;
      if (data.segments && data.segments.length > 0) {
        const logprobs = data.segments
          .map((s) => s.avg_logprob ?? 0)
          .filter((p) => p < 0);
        if (logprobs.length > 0) {
          const mean = logprobs.reduce((a, b) => a + b, 0) / logprobs.length;
          confidence = Math.min(1.0, Math.exp(mean + 0.5));
        }
      }

      return { success: true, text: data.text, confidence };
    } finally {
      clearTimeout(timeout);
    }
  } catch (error) {
    return { success: false, error: String(error) };
  }
}

async function transcribeViaWhisply(
  localPath: string,
): Promise<TranscriptionResult> {
  try {
    const venvPython = "/home/cypher/.local/venvs/lettabot/bin/python3";
    const cmd = venvPython + " -m whisply run --files " + localPath + " --json 2>/dev/null";

    const output = execSync(cmd, {
      timeout: LOCAL_TRANSCRIPTION_TIMEOUT_MS,
      maxBuffer: 10 * 1024 * 1024,
      encoding: "utf-8",
    });

    const jsonMatch = output.match(/\{.*\}/s);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]) as {
        text?: string;
        confidence?: number;
      };
      return {
        success: true,
        text: parsed.text ?? output.trim(),
        confidence: parsed.confidence ?? 0.9,
      };
    }

    const text = output.trim();
    if (text) {
      return { success: true, text, confidence: 0.9 };
    }

    return { success: false, error: "whisply produced no output" };
  } catch {
    return transcribeViaCloudApi(localPath);
  }
}

async function transcribeViaCloudApi(
  localPath: string,
): Promise<TranscriptionResult> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return {
      success: false,
      error: "No transcription backend: set OPENAI_API_KEY, PARAKEET_WHISPER_URL, or install whisply.",
    };
  }

  try {
    const buffer = readFileSync(localPath);
    const filename = basename(localPath);
    const formData = new FormData();
    formData.append("file", new Blob([buffer], { type: "audio/ogg" }), filename);
    formData.append("model", "whisper-1");

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TRANSCRIPTION_TIMEOUT_MS);

    try {
      const response = await fetch(WHISPER_API_URL, {
        method: "POST",
        headers: { Authorization: "Bearer " + apiKey },
        body: formData,
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        return { success: false, error: "Whisper API error: " + errorText };
      }

      const data = (await response.json()) as { text: string };
      return { success: true, text: data.text, confidence: estimateConfidence(data) };
    } finally {
      clearTimeout(timeout);
    }
  } catch (error) {
    return { success: false, error: String(error) };
  }
}

export async function transcribeAndFormat(
  localPath: string,
): Promise<{ success: boolean; text?: string; error?: string }> {
  const result = await transcribeAudioFile(localPath);
  if (!result.success || !result.text) {
    return { success: false, error: result.error };
  }
  const formatted = formatTranscribed(result.text, result.confidence ?? 0.9);
  return { success: true, text: formatted };
}
