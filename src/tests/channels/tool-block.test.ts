// src/tests/channels/tool-block.test.ts
import { expect, test } from "bun:test";
import {
  renderToolBlock,
  upsertToolCallGroup,
  type ToolCallGroup,
} from "../../channels/tool-block";

test("renderToolBlock: empty groups returns empty string", () => {
  expect(renderToolBlock([])).toBe("");
});

test("renderToolBlock: single tool no description", () => {
  const groups: ToolCallGroup[] = [{ key: "bash", label: "bash", count: 1 }];
  expect(renderToolBlock(groups)).toBe("🔧 Tools used:\n• bash");
});

test("renderToolBlock: single tool count > 1", () => {
  const groups: ToolCallGroup[] = [
    { key: "bash", label: "bash", count: 3 },
  ];
  expect(renderToolBlock(groups)).toBe("🔧 Tools used:\n• bash ×3");
});

test("renderToolBlock: tool with description", () => {
  const groups: ToolCallGroup[] = [
    { key: "bash\0Run tests", label: "bash — Run tests", count: 2 },
  ];
  expect(renderToolBlock(groups)).toBe("🔧 Tools used:\n• bash — Run tests ×2");
});

test("renderToolBlock: multiple tools preserves order", () => {
  const groups: ToolCallGroup[] = [
    { key: "read_file", label: "read_file", count: 4 },
    { key: "bash\0Run tests", label: "bash — Run tests", count: 1 },
    { key: "glob", label: "glob", count: 2 },
  ];
  expect(renderToolBlock(groups)).toBe(
    "🔧 Tools used:\n• read_file ×4\n• bash — Run tests\n• glob ×2",
  );
});

test("upsertToolCallGroup: first call creates group", () => {
  const result = upsertToolCallGroup([], "bash");
  expect(result).toEqual([{ key: "bash", label: "bash", count: 1 }]);
});

test("upsertToolCallGroup: second call increments count", () => {
  const initial = upsertToolCallGroup([], "bash");
  const result = upsertToolCallGroup(initial, "bash");
  expect(result).toEqual([{ key: "bash", label: "bash", count: 2 }]);
});

test("upsertToolCallGroup: description creates distinct key from bare name", () => {
  const initial = upsertToolCallGroup([], "bash");
  const result = upsertToolCallGroup(initial, "bash", "Run tests");
  expect(result).toHaveLength(2);
  expect(result[0]).toEqual({ key: "bash", label: "bash", count: 1 });
  expect(result[1]).toEqual({
    key: "bash\0Run tests",
    label: "bash — Run tests",
    count: 1,
  });
});

test("upsertToolCallGroup: same description groups together", () => {
  const g0 = upsertToolCallGroup([], "bash", "List files");
  const g1 = upsertToolCallGroup(g0, "bash", "List files");
  expect(g1).toHaveLength(1);
  expect(g1[0]?.count).toBe(2);
});

test("upsertToolCallGroup: preserves order of existing groups", () => {
  const g0 = upsertToolCallGroup([], "read_file");
  const g1 = upsertToolCallGroup(g0, "glob");
  const g2 = upsertToolCallGroup(g1, "read_file");
  expect(g2.map((g) => g.key)).toEqual(["read_file", "glob"]);
  expect(g2[0]?.count).toBe(2);
});
