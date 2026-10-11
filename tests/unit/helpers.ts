import type { RawNode, RawSnapshot, WindowInfo } from "../../src/protocol.ts";

export function windowInfo(overrides: Partial<WindowInfo> = {}): WindowInfo {
  return {
    hwnd: 100,
    title: "Fixture",
    className: "WindowsForms10.Window",
    pid: 42,
    processName: "fixture.exe",
    exePath: "C:\\fixture.exe",
    rect: { x: 0, y: 0, width: 800, height: 600 },
    minimized: false,
    maximized: false,
    foreground: true,
    enabled: true,
    owner: null,
    appWindow: true,
    dpi: 96,
    ...overrides,
  };
}

type NodeSpec = Partial<RawNode> & { role: string; children?: NodeSpec[] };

/** Build a helper snapshot from a nested spec, numbering nodes depth-first. */
export function snapshot(root: NodeSpec, snapshotId = 1, window = windowInfo()): RawSnapshot {
  const nodes: RawNode[] = [];
  const visit = (spec: NodeSpec, parent: number, depth: number) => {
    const { children, ...rest } = spec;
    const id = nodes.length;
    nodes.push({
      id,
      parent,
      depth,
      rect: { x: 10, y: 10, width: 50, height: 20 },
      enabled: true,
      offscreen: false,
      focused: false,
      focusable: false,
      actions: [],
      ...rest,
    } as RawNode);
    for (const child of children ?? []) visit(child, id, depth + 1);
  };
  visit(root, -1, 0);
  return { snapshotId, window, nodes, truncated: false, elapsedMs: 1 };
}

export const form = (status = "Status: ready", extra: NodeSpec[] = []): NodeSpec => ({
  role: "Window",
  name: "Fixture",
  runtimeId: "42.1",
  children: [
    { role: "Text", name: "Full name", runtimeId: "42.2" },
    { role: "Edit", name: "Full name", runtimeId: "42.3", actions: ["setValue", "readText"], focusable: true, automationId: "fullName" },
    {
      role: "Pane",
      runtimeId: "42.4",
      children: [
        { role: "Button", name: "Save draft", runtimeId: "42.5", actions: ["invoke"] },
        { role: "Button", name: "Submit", runtimeId: "42.6", actions: ["invoke"] },
        { role: "Button", name: "Delete all data", runtimeId: "42.7", actions: ["invoke"], rect: { x: 700, y: 550, width: 80, height: 20 } },
      ],
    },
    { role: "Text", name: status, runtimeId: "42.8" },
    ...extra,
    { role: "TitleBar", runtimeId: "42.99", children: [{ role: "Button", name: "Close", runtimeId: "42.100", actions: ["invoke"] }] },
  ],
});
