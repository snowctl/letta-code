import { expect, test } from "bun:test";
import { type CronTarget, wrapCronPrompt } from "../../cron/scheduler";

// Construct a minimal CronTask — matches the CronTask interface in src/cron/cronFile.ts
const baseTask = {
  id: "t1",
  name: "Daily digest",
  description: "Send daily summary",
  prompt: "Summarize today's events.",
  recurring: true,
  cron: "0 9 * * *",
  fire_count: 2,
  agent_id: "a1",
  conversation_id: "c1",
  status: "active" as const,
  timezone: "UTC",
  created_at: "2026-01-01T00:00:00.000Z",
  expires_at: null,
  last_fired_at: null,
  cancel_reason: null,
  jitter_offset_ms: 0,
  scheduled_for: null,
  fired_at: null,
  missed_at: null,
};

test("wrapCronPrompt includes NotifyUser instruction", () => {
  const result = wrapCronPrompt(baseTask as any, []);
  expect(result).toContain("NotifyUser");
  expect(result).toContain("NOT delivered automatically");
});

test("wrapCronPrompt includes available targets when provided", () => {
  const targets: CronTarget[] = [
    { channel: "telegram", chatId: "-100123", label: "Main chat" },
  ];
  const result = wrapCronPrompt(baseTask as any, targets);
  expect(result).toContain("telegram");
  expect(result).toContain("-100123");
});

test("wrapCronPrompt omits Available targets section when targets is empty", () => {
  const result = wrapCronPrompt(baseTask as any, []);
  expect(result).not.toContain("Available targets");
});
