import type { RawNode, RawSnapshot, Rect, WindowInfo } from "./protocol.ts";

/** A node of the latest snapshot, addressed by a stable, agent-facing index. */
export type StateNode = RawNode & {
  index: number;
  parentIndex: number | null;
  children: StateNode[];
};

export type ScreenshotMapping = {
  id: number;
  scale: number;
  width: number;
  height: number;
  /** The window frame when the screenshot was taken, in screen pixels. */
  frame: Rect;
};

/**
 * Gives each element a number that stays the same for as long as the element exists.
 * Keys are UI Automation runtime ids where the provider has them, else the element's
 * path. First-seen order matches depth-first tree order, so a fresh window reads 0..n.
 */
export class IdentityMap {
  private readonly indices = new Map<string, number>();
  private next = 0;

  index(key: string): number {
    let index = this.indices.get(key);
    if (index === undefined) {
      index = this.next++;
      this.indices.set(key, index);
    }
    return index;
  }

  toJSON(): { next: number; keys: [string, number][] } {
    return { next: this.next, keys: [...this.indices] };
  }

  static from(data: { next: number; keys: [string, number][] } | undefined): IdentityMap {
    const map = new IdentityMap();
    if (data) {
      for (const [key, index] of data.keys) map.indices.set(key, index);
      map.next = data.next;
    }
    return map;
  }
}

/** Everything known about one top-level window: its latest snapshot and screenshot. */
export class WindowState {
  readonly hwnd: number;
  window: WindowInfo;
  readonly identities: IdentityMap;
  snapshotId = 0;
  takenAt = 0;
  truncated = false;
  root: StateNode | undefined;
  readonly byIndex = new Map<number, StateNode>();
  /** Helper element id (position in the helper's latest snapshot) per stable index. */
  readonly helperIds = new Map<number, number>();
  screenshot: ScreenshotMapping | undefined;

  constructor(window: WindowInfo, identities = new IdentityMap()) {
    this.hwnd = window.hwnd;
    this.window = window;
    this.identities = identities;
  }

  get nodes(): StateNode[] {
    return [...this.byIndex.values()];
  }

  get focused(): StateNode | undefined {
    for (const node of this.byIndex.values()) if (node.focused) return node;
    return undefined;
  }

  update(snapshot: RawSnapshot): void {
    this.window = snapshot.window;
    this.snapshotId = snapshot.snapshotId;
    this.takenAt = Date.now();
    this.truncated = snapshot.truncated;
    this.byIndex.clear();
    this.helperIds.clear();
    this.root = undefined;

    const byHelperId = new Map<number, StateNode>();
    const keys = new Map<number, string>();
    const siblingCounts = new Map<string, number>();
    for (const raw of snapshot.nodes) {
      const parent = byHelperId.get(raw.parent);
      let key = raw.runtimeId ? `rt:${raw.runtimeId}` : undefined;
      if (!key) {
        const base = `${keys.get(raw.parent) ?? "root"}>${raw.role}:${raw.automationId || raw.name || ""}`;
        const ordinal = siblingCounts.get(base) ?? 0;
        siblingCounts.set(base, ordinal + 1);
        key = `${base}#${ordinal}`;
      }
      keys.set(raw.id, key);
      const node: StateNode = { ...raw, index: this.identities.index(key), parentIndex: parent?.index ?? null, children: [] };
      byHelperId.set(raw.id, node);
      this.byIndex.set(node.index, node);
      this.helperIds.set(node.index, raw.id);
      if (parent) parent.children.push(node);
      else if (!this.root) this.root = node;
    }
  }

  ancestors(node: StateNode): StateNode[] {
    const chain: StateNode[] = [];
    let current = node.parentIndex === null ? undefined : this.byIndex.get(node.parentIndex);
    while (current) {
      chain.push(current);
      current = current.parentIndex === null ? undefined : this.byIndex.get(current.parentIndex);
    }
    return chain;
  }
}
