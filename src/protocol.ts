// Wire types shared with the platform helper (native/windows). A helper for another
// platform implements the same NDJSON methods, so everything above this layer stays
// platform-neutral.

export type Rect = { x: number; y: number; width: number; height: number };

export type WindowInfo = {
  hwnd: number;
  title: string;
  className: string;
  pid: number;
  processName: string;
  exePath: string | null;
  rect: Rect;
  minimized: boolean;
  maximized: boolean;
  foreground: boolean;
  enabled: boolean;
  owner: number | null;
  /** Shown in the taskbar / Alt+Tab (dialogs and popups are not). */
  appWindow: boolean;
  dpi: number;
};

/** Element actions a helper may report for a node. */
export type ElementAction =
  | "invoke"
  | "toggle"
  | "select"
  | "expand"
  | "collapse"
  | "setValue"
  | "scroll"
  | "scrollIntoView"
  | "defaultAction"
  | "readText";

export type RawNode = {
  id: number;
  parent: number;
  depth: number;
  runtimeId?: string;
  role: string;
  localizedRole?: string;
  name?: string;
  value?: string;
  automationId?: string;
  className?: string;
  rect: Rect;
  enabled: boolean;
  offscreen: boolean;
  focused: boolean;
  focusable: boolean;
  actions: ElementAction[];
  toggleState?: "on" | "off" | "indeterminate";
  expandState?: "collapsed" | "expanded" | "partial";
  selected?: boolean;
  readOnly?: boolean;
  range?: { value: number; min: number; max: number };
  scroll?: { vertical?: number; horizontal?: number };
  defaultAction?: string;
  helpText?: string;
  accelerator?: string;
  accessKey?: string;
  nativeHwnd?: number;
};

export type RawSnapshot = {
  snapshotId: number;
  window: WindowInfo;
  nodes: RawNode[];
  truncated: boolean;
  elapsedMs: number;
};

export type Screenshot = {
  data: string;
  mimeType: string;
  width: number;
  height: number;
  /** Screen pixels per image pixel: screen = origin + image * scale. */
  scale: number;
  origin: Rect;
  source: "window" | "screen";
};

export type ElementActionResult = { ok: true; pending?: boolean; value?: string | null; text?: string };

export type DetachedElement = { node: RawNode; topWindow: number | null; elementId?: number };

export type GuardStatus = {
  enabled: boolean;
  lastPhysicalInputMsAgo: number | null;
  lastEscMsAgo: number | null;
  stopped: boolean;
};

export type HelperMethods = {
  ping: { params: Record<string, never>; result: { version: string; platform: string } };
  listWindows: { params: { includeAll?: boolean }; result: WindowInfo[] };
  snapshot: {
    params: { hwnd: number; maxNodes?: number; maxDepth?: number; includeOffscreen?: boolean; raw?: boolean; maxValueLength?: number };
    result: RawSnapshot;
  };
  elementAction: {
    params: {
      hwnd: number;
      elementId: number;
      snapshotId?: number;
      action: ElementAction | "focus" | "showContextMenu" | "addToSelection" | "removeFromSelection";
      value?: string;
      direction?: "up" | "down" | "left" | "right";
      amount?: number;
      page?: boolean;
      maxLength?: number;
      waitMs?: number;
    };
    result: ElementActionResult;
  };
  elementInfo: {
    params: { hwnd: number; elementId: number; snapshotId?: number };
    result: { node: RawNode; clickablePoint: { x: number; y: number } | null };
  };
  elementAtPoint: { params: { x: number; y: number }; result: DetachedElement };
  focusedElement: { params: { hwnd?: number }; result: DetachedElement };
  activateWindow: { params: { hwnd: number }; result: { foreground: boolean; window: WindowInfo } };
  click: {
    params: {
      x: number;
      y: number;
      hwnd?: number;
      button?: "left" | "right" | "middle";
      count?: number;
      modifiers?: string[];
      restoreCursor?: boolean;
      allowOtherWindow?: boolean;
    };
    result: { ok: true; foreground: boolean };
  };
  moveMouse: { params: { x: number; y: number; hwnd?: number }; result: { ok: true } };
  drag: {
    params: { from: { x: number; y: number }; to: { x: number; y: number }; hwnd?: number; button?: string; steps?: number };
    result: { ok: true; foreground: boolean };
  };
  scroll: { params: { x: number; y: number; dx?: number; dy?: number; hwnd?: number }; result: { ok: true } };
  typeText: {
    params: { text: string; hwnd?: number };
    /** `unconfirmed`: characters the focused element's text did not show in time. */
    result: { ok: true; foreground: boolean; characters: number; unicodePackets: number; unconfirmed: number };
  };
  pressKey: { params: { key: string; hwnd?: number; repeat?: number }; result: { ok: true; foreground: boolean } };
  screenshot: {
    params: { hwnd?: number; maxEdge?: number; format?: "jpeg" | "png"; quality?: number };
    result: Screenshot;
  };
  guardStatus: { params: Record<string, never>; result: GuardStatus };
  /** Show (or keep showing) the "agent is using your computer" overlay on the window's monitor. */
  overlayShow: { params: { hwnd: number; label: string; idleMs?: number }; result: { ok: true; enabled: boolean } };
  overlayHide: { params: Record<string, never>; result: { ok: true; enabled: boolean } };
  clearStop: { params: Record<string, never>; result: { ok: true } };
};

export type HelperMethod = keyof HelperMethods;
