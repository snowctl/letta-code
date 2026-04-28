# Architectural Plan: Voice Message Auto-Transcription with Parakeet

**Status**: [ready-for-assignment]  
**Scope**: Telegram/Matrix voice messages → Parakeet transcription with confidence XML  
**Effort**: 2-3 days  
**Dependencies**: Parakeet service endpoint (configurable)

---

## 1. Problem Statement

Current implementation uses OpenAI Whisper API, requiring cloud API key. Users need:
- Self-hosted transcription via Parakeet (local/private)
- Confidence scoring in transcription output
- Configurable per-channel enablement

---

## 2. Current State Analysis

### Existing Transcription (Whisper)
```typescript
// src/channels/transcription/index.ts
export interface TranscriptionResult {
  success: boolean;
  text?: string;
  error?: string;
}
```

Used in:
- `src/channels/telegram/media.ts:580-590` - Voice memo transcription
- `src/channels/types.ts:32` - `ChannelMessageAttachment.transcription?: string`

---

## 3. Proposed Architecture

### 3.1 Enhanced Transcription Interface

```typescript
// src/channels/transcription/types.ts
export type ConfidenceLevel = "high" | "medium" | "low";

export interface TranscriptionResult {
  success: boolean;
  text?: string;
  confidence?: ConfidenceLevel;
  // Raw confidence score (0-1) from provider
  confidenceScore?: number;
  error?: string;
  provider: "whisper" | "parakeet" | "none";
}

export interface TranscriptionConfig {
  provider: "whisper" | "parakeet" | "disabled";
  // Provider-specific endpoints
  parakeet?: {
    baseUrl: string;  // e.g., "http://localhost:8000"
    timeoutMs: number;
    confidenceThresholds: {
      high: number;   // default 0.9
      medium: number; // default 0.7
      low: number;    // default 0.0
    };
  };
  whisper?: {
    apiKey: string;
    timeoutMs: number;
  };
}
```

### 3.2 Parakeet Provider Implementation

```typescript
// src/channels/transcription/parakeet.ts
export async function transcribeWithParakeet(
  localPath: string,
  config: TranscriptionConfig["parakeet"]
): Promise<TranscriptionResult> {
  const buffer = readFileSync(localPath);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const response = await fetch(`${config.baseUrl}/v1/transcribe`, {
      method: "POST",
      headers: {
        "Content-Type": "audio/ogg",
      },
      body: buffer,
      signal: controller.signal,
    });

    if (!response.ok) {
      return {
        success: false,
        error: `Parakeet error (${response.status}): ${await response.text()}`,
        provider: "parakeet"
      };
    }

    const data = await response.json() as {
      text: string;
      confidence?: number;
    };

    const confidence = data.confidence ?? 0.5;
    return {
      success: true,
      text: data.text,
      confidence: scoreToLevel(confidence, config.confidenceThresholds),
      confidenceScore: confidence,
      provider: "parakeet"
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      provider: "parakeet"
    };
  } finally {
    clearTimeout(timeout);
  }
}

function scoreToLevel(
  score: number,
  thresholds: { high: number; medium: number; low: number }
): ConfidenceLevel {
  if (score >= thresholds.high) return "high";
  if (score >= thresholds.medium) return "medium";
  return "low";
}
```

### 3.3 Unified Transcription Provider

```typescript
// src/channels/transcription/index.ts
import { transcribeWithParakeet } from "./parakeet.js";
import { transcribeWithWhisper } from "./whisper.js";

export async function transcribeAudioFile(
  localPath: string,
  config?: TranscriptionConfig
): Promise<TranscriptionResult> {
  // Use provided config or load from environment
  const effectiveConfig = config ?? loadConfigFromEnv();

  switch (effectiveConfig.provider) {
    case "parakeet":
      if (!effectiveConfig.parakeet) {
        return {
          success: false,
          error: "Parakeet configured but no parakeet config provided",
          provider: "none"
        };
      }
      return transcribeWithParakeet(localPath, effectiveConfig.parakeet);

    case "whisper":
      return transcribeWithWhisper(localPath, effectiveConfig.whisper);

    case "disabled":
    default:
      return {
        success: false,
        error: "Transcription disabled",
        provider: "none"
      };
  }
}

function loadConfigFromEnv(): TranscriptionConfig {
  // Priority: Parakeet > Whisper > Disabled
  if (process.env.PARAKEET_BASE_URL) {
    return {
      provider: "parakeet",
      parakeet: {
        baseUrl: process.env.PARAKEET_BASE_URL,
        timeoutMs: parseInt(process.env.PARAKEET_TIMEOUT_MS ?? "30000", 10),
        confidenceThresholds: {
          high: parseFloat(process.env.PARAKEET_HIGH_THRESHOLD ?? "0.9"),
          medium: parseFloat(process.env.PARAKEET_MEDIUM_THRESHOLD ?? "0.7"),
          low: 0.0
        }
      }
    };
  }

  if (process.env.OPENAI_API_KEY) {
    return {
      provider: "whisper",
      whisper: {
        apiKey: process.env.OPENAI_API_KEY,
        timeoutMs: 10000
      }
    };
  }

  return { provider: "disabled" };
}
```

### 3.4 Confidence XML Formatting

```typescript
// src/channels/xml.ts
export function formatTranscriptionForAgent(
  transcription: TranscriptionResult
): string {
  if (!transcription.success || !transcription.text) {
    return "";
  }

  const confidence = transcription.confidence ?? "medium";

  // Format: <transcribed confidence="high">text</transcribed>
  return `<transcribed confidence="${confidence}">${escapeXml(transcription.text)}</transcribed>`;
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
```

### 3.5 Channel Configuration Updates

```typescript
// src/channels/types.ts - Add to channel configs
export interface TelegramChannelConfig {
  channel: "telegram";
  enabled: boolean;
  token: string;
  dmPolicy: DmPolicy;
  allowedUsers: string[];
  // DEPRECATED: Use transcription.provider instead
  transcribeVoice?: boolean;
  // NEW: Granular transcription config
  transcription?: {
    provider: "parakeet" | "whisper" | "disabled";
    // Channel-specific overrides
    parakeet?: Partial<TranscriptionConfig["parakeet"]>;
  };
}

export interface MatrixChannelConfig {
  // ... existing fields ...
  transcribeVoice?: boolean;  // Legacy
  transcription?: {
    provider: "parakeet" | "whisper" | "disabled";
    parakeet?: Partial<TranscriptionConfig["parakeet"]>;
  };
}
```

---

## 4. Integration Points

### 4.1 Telegram Adapter Changes

```typescript
// src/channels/telegram/media.ts
// Modify downloadTelegramAttachment function:

if (candidate.isVoice && params.transcribeVoice) {
  const config = loadTranscriptionConfig(params.accountId);
  const result = await transcribeAudioFile(localPath, config);

  if (result.success && result.text) {
    // Store raw transcription
    attachment.transcription = result.text;
    attachment.transcriptionConfidence = result.confidence;
    attachment.transcriptionProvider = result.provider;
  }
}
```

### 4.2 XML Message Builder

```typescript
// src/channels/xml.ts - In message formatting:
export function buildInboundXml(
  message: InboundChannelMessage
): string {
  let xml = `<message from="${escapeXml(message.senderId)}">`;
  xml += `<text>${escapeXml(message.text)}</text>`;

  // Add transcription as structured XML
  if (message.attachments) {
    for (const attachment of message.attachments) {
      if (attachment.transcription) {
        xml += formatTranscriptionForAgent({
          success: true,
          text: attachment.transcription,
          confidence: attachment.transcriptionConfidence
        });
      }
    }
  }

  xml += `</message>`;
  return xml;
}
```

### 4.3 Matrix Adapter

Matrix adapter needs similar integration as Telegram:

```typescript
// src/channels/matrix/adapter.ts
// In message processing:

if (event.content?.msgtype === "m.audio" || event.content?.msgtype === "m.voice") {
  const audioUrl = event.content.url;
  const localPath = await downloadMatrixMedia(audioUrl);

  if (config.transcription?.provider && config.transcription.provider !== "disabled") {
    const result = await transcribeAudioFile(localPath, {
      provider: config.transcription.provider,
      parakeet: config.transcription.parakeet
    });

    if (result.success) {
      attachments.push({
        kind: "audio",
        localPath,
        transcription: result.text,
        transcriptionConfidence: result.confidence,
        transcriptionProvider: result.provider
      });
    }
  }
}
```

---

## 5. File Changes Required

### New Files
| File | Purpose |
|------|---------|
| `src/channels/transcription/types.ts` | Shared transcription interfaces |
| `src/channels/transcription/parakeet.ts` | Parakeet provider implementation |
| `src/channels/transcription/whisper.ts` | Refactored Whisper provider |
| `src/channels/transcription/config.ts` | Config loading utilities |

### Modified Files
| File | Change |
|------|--------|
| `src/channels/transcription/index.ts` | Unified provider dispatcher |
| `src/channels/types.ts` | Add transcription config to channel types |
| `src/channels/telegram/media.ts` | Use new transcription API |
| `src/channels/telegram/adapter.ts` | Pass transcription config |
| `src/channels/matrix/adapter.ts` | Add voice message transcription |
| `src/channels/xml.ts` | Add transcription formatting |

---

## 6. Configuration

### Environment Variables
```bash
# Parakeet Configuration
PARAKEET_BASE_URL=http://localhost:8000
PARAKEET_TIMEOUT_MS=30000
PARAKEET_HIGH_THRESHOLD=0.9
PARAKEET_MEDIUM_THRESHOLD=0.7

# Legacy (still supported)
OPENAI_API_KEY=sk-...
```

### Channel Config File
```json
{
  "channel": "telegram",
  "transcription": {
    "provider": "parakeet",
    "parakeet": {
      "baseUrl": "http://localhost:8000"
    }
  }
}
```

---

## 7. Testing Plan

| Test | Approach |
|------|----------|
| Parakeet provider | Mock server returning confidence scores |
| Confidence thresholds | Unit test score → level mapping |
| XML formatting | Verify `<transcribed confidence="X">` output |
| Telegram voice memo | Integration test with mock Telegram API |
| Matrix voice message | Integration test with mock Matrix homeserver |
| Config loading | Test env var → config mapping |
| Fallback chain | Parakeet fail → Whisper fallback (if configured) |

---

## 8. Migration Path

### Legacy Config Support
```typescript
// In config loading:
function migrateLegacyConfig(config: ChannelConfig): ChannelConfig {
  if (config.transcribeVoice === true && !config.transcription) {
    return {
      ...config,
      transcription: {
        provider: process.env.PARAKEET_BASE_URL ? "parakeet" : "whisper"
      }
    };
  }
  return config;
}
```

---

## 9. Open Questions

1. **Fallback Strategy**: Should failed Parakeet calls fall back to Whisper?
2. **Confidence in XML**: Should we include raw `confidenceScore` (0-1) in addition to level?
3. **Language Support**: Does Parakeet need language hints?
4. **Batching**: Should we batch multiple voice messages?

---

## 10. Implementation Order

1. **Day 1**: Transcription types + Parakeet provider + tests
2. **Day 2**: Unified dispatcher + Telegram integration
3. **Day 3**: Matrix integration + XML formatting + E2E tests

---

*Plan ready for assignment. Requires coordination with Parakeet deployment if not already available.*
