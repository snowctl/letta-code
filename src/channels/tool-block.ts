export interface ToolCallGroup {
  key: string;
  label: string;
  count: number;
}

export function makeToolCallKey(
  toolName: string,
  description?: string,
): string {
  return description ? `${toolName}\0${description}` : toolName;
}

export function makeToolCallLabel(
  toolName: string,
  description?: string,
): string {
  return description ? `${toolName} — ${description}` : toolName;
}

export function renderToolBlock(groups: ToolCallGroup[]): string {
  if (groups.length === 0) return "";
  const lines = groups.map((g) =>
    g.count === 1 ? g.label : `${g.label} (x${g.count})`,
  );
  return `🔧 Tools used:\n${lines.join("\n")}`;
}

export function upsertToolCallGroup(
  groups: ToolCallGroup[],
  toolName: string,
  description?: string,
): ToolCallGroup[] {
  const key = makeToolCallKey(toolName, description);
  const idx = groups.findIndex((g) => g.key === key);
  if (idx !== -1) {
    return groups.map((g, i) => (i === idx ? { ...g, count: g.count + 1 } : g));
  }
  return [
    ...groups,
    { key, label: makeToolCallLabel(toolName, description), count: 1 },
  ];
}
