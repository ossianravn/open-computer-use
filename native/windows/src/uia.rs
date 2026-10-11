//! UI Automation: accessibility-tree snapshots and element-level actions.
//!
//! A snapshot walks one top-level window with a single cached subtree request (one
//! cross-process round trip), numbers the elements depth-first, and keeps the live
//! element references so later actions can address them by number.

use std::collections::HashMap;
use std::time::Instant;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use windows::Win32::Foundation::POINT;
use windows::Win32::System::Com::{CLSCTX_INPROC_SERVER, CoCreateInstance};
use windows::Win32::System::Variant::{VARIANT, VT_ARRAY, VT_BOOL, VT_BSTR, VT_I4, VT_R8, VariantClear};
use windows::Win32::UI::Accessibility::*;
use windows::Win32::UI::WindowsAndMessaging::{GA_ROOT, GetAncestor};
use windows::core::Interface;

use crate::rpc::{RpcError, parse};
use crate::windows_enum::{Rect, describe_window, ensure_window, hwnd_value};

const MAX_RETAINED_WINDOWS: usize = 32;

pub struct Session {
    automation: IUIAutomation,
    control_view: IUIAutomationCacheRequest,
    /// Control view without offscreen elements: the provider skips serializing them,
    /// which matters for long web pages.
    onscreen_view: IUIAutomationCacheRequest,
    raw_view: IUIAutomationCacheRequest,
    single: IUIAutomationCacheRequest,
    snapshots: HashMap<i64, Snapshot>,
    next_snapshot: u64,
}

struct Snapshot {
    id: u64,
    taken: Instant,
    elements: Vec<IUIAutomationElement>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Node {
    pub id: usize,
    pub parent: i64,
    pub depth: u32,
    /// UIA runtime id, unique for the element's lifetime ("42.1234.5").
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runtime_id: Option<String>,
    pub role: &'static str,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub localized_role: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub automation_id: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub class_name: String,
    pub rect: Rect,
    pub enabled: bool,
    pub offscreen: bool,
    pub focused: bool,
    pub focusable: bool,
    pub actions: Vec<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub toggle_state: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expand_state: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selected: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub read_only: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub range: Option<RangeInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scroll: Option<ScrollInfo>,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub default_action: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub help_text: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub accelerator: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub access_key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub native_hwnd: Option<i64>,
}

#[derive(Serialize)]
pub struct RangeInfo {
    pub value: f64,
    pub min: f64,
    pub max: f64,
}

#[derive(Serialize)]
pub struct ScrollInfo {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vertical: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub horizontal: Option<f64>,
}

const PROPERTIES: &[UIA_PROPERTY_ID] = &[
    UIA_RuntimeIdPropertyId,
    UIA_NamePropertyId,
    UIA_ControlTypePropertyId,
    UIA_LocalizedControlTypePropertyId,
    UIA_AutomationIdPropertyId,
    UIA_ClassNamePropertyId,
    UIA_BoundingRectanglePropertyId,
    UIA_IsEnabledPropertyId,
    UIA_IsOffscreenPropertyId,
    UIA_HasKeyboardFocusPropertyId,
    UIA_IsKeyboardFocusablePropertyId,
    UIA_HelpTextPropertyId,
    UIA_AcceleratorKeyPropertyId,
    UIA_AccessKeyPropertyId,
    UIA_NativeWindowHandlePropertyId,
    UIA_IsInvokePatternAvailablePropertyId,
    UIA_IsTogglePatternAvailablePropertyId,
    UIA_IsValuePatternAvailablePropertyId,
    UIA_IsSelectionItemPatternAvailablePropertyId,
    UIA_IsExpandCollapsePatternAvailablePropertyId,
    UIA_IsScrollPatternAvailablePropertyId,
    UIA_IsScrollItemPatternAvailablePropertyId,
    UIA_IsRangeValuePatternAvailablePropertyId,
    UIA_IsLegacyIAccessiblePatternAvailablePropertyId,
    UIA_IsTextPatternAvailablePropertyId,
    UIA_ValueValuePropertyId,
    UIA_ValueIsReadOnlyPropertyId,
    UIA_ToggleToggleStatePropertyId,
    UIA_ExpandCollapseExpandCollapseStatePropertyId,
    UIA_SelectionItemIsSelectedPropertyId,
    UIA_RangeValueValuePropertyId,
    UIA_RangeValueMinimumPropertyId,
    UIA_RangeValueMaximumPropertyId,
    UIA_LegacyIAccessibleDefaultActionPropertyId,
    UIA_ScrollVerticallyScrollablePropertyId,
    UIA_ScrollHorizontallyScrollablePropertyId,
    UIA_ScrollVerticalScrollPercentPropertyId,
    UIA_ScrollHorizontalScrollPercentPropertyId,
];

/// An owned VARIANT that is cleared on drop.
struct Var(VARIANT);

impl Drop for Var {
    fn drop(&mut self) {
        unsafe {
            let _ = VariantClear(&mut self.0);
        }
    }
}

impl Var {
    fn bool(&self) -> Option<bool> {
        unsafe {
            let inner = &self.0.Anonymous.Anonymous;
            (inner.vt == VT_BOOL).then(|| inner.Anonymous.boolVal.0 != 0)
        }
    }
    fn i32(&self) -> Option<i32> {
        unsafe {
            let inner = &self.0.Anonymous.Anonymous;
            (inner.vt == VT_I4).then(|| inner.Anonymous.lVal)
        }
    }
    fn f64(&self) -> Option<f64> {
        unsafe {
            let inner = &self.0.Anonymous.Anonymous;
            (inner.vt == VT_R8).then(|| inner.Anonymous.dblVal)
        }
    }
    fn int_array(&self) -> Option<Vec<i32>> {
        unsafe {
            let inner = &self.0.Anonymous.Anonymous;
            if inner.vt.0 != (VT_ARRAY.0 | VT_I4.0) {
                return None;
            }
            let array = inner.Anonymous.parray;
            if array.is_null() || (*array).cDims != 1 {
                return None;
            }
            let count = (*array).rgsabound[0].cElements as usize;
            let data = (*array).pvData as *const i32;
            if data.is_null() {
                return None;
            }
            Some(std::slice::from_raw_parts(data, count).to_vec())
        }
    }
    fn string(&self) -> Option<String> {
        unsafe {
            let inner = &self.0.Anonymous.Anonymous;
            (inner.vt == VT_BSTR).then(|| inner.Anonymous.bstrVal.to_string())
        }
    }
}

fn cached(element: &IUIAutomationElement, property: UIA_PROPERTY_ID) -> Option<Var> {
    unsafe { element.GetCachedPropertyValue(property).ok().map(Var) }
}

fn cached_bool(element: &IUIAutomationElement, property: UIA_PROPERTY_ID) -> bool {
    cached(element, property).and_then(|v| v.bool()).unwrap_or(false)
}

pub fn role_name(control_type: UIA_CONTROLTYPE_ID) -> &'static str {
    match control_type.0 {
        50000 => "Button",
        50001 => "Calendar",
        50002 => "CheckBox",
        50003 => "ComboBox",
        50004 => "Edit",
        50005 => "Hyperlink",
        50006 => "Image",
        50007 => "ListItem",
        50008 => "List",
        50009 => "Menu",
        50010 => "MenuBar",
        50011 => "MenuItem",
        50012 => "ProgressBar",
        50013 => "RadioButton",
        50014 => "ScrollBar",
        50015 => "Slider",
        50016 => "Spinner",
        50017 => "StatusBar",
        50018 => "Tab",
        50019 => "TabItem",
        50020 => "Text",
        50021 => "ToolBar",
        50022 => "ToolTip",
        50023 => "Tree",
        50024 => "TreeItem",
        50025 => "Custom",
        50026 => "Group",
        50027 => "Thumb",
        50028 => "DataGrid",
        50029 => "DataItem",
        50030 => "Document",
        50031 => "SplitButton",
        50032 => "Window",
        50033 => "Pane",
        50034 => "Header",
        50035 => "HeaderItem",
        50036 => "Table",
        50037 => "TitleBar",
        50038 => "Separator",
        50039 => "SemanticZoom",
        50040 => "AppBar",
        _ => "Unknown",
    }
}

fn truncate(mut text: String, max_chars: usize) -> String {
    if let Some((index, _)) = text.char_indices().nth(max_chars) {
        text.truncate(index);
        text.push('…');
    }
    text
}

fn describe(element: &IUIAutomationElement, id: usize, parent: i64, depth: u32, max_value: usize) -> Node {
    unsafe {
        let string = |property| cached(element, property).and_then(|v| v.string()).unwrap_or_default();
        let has = |property| cached_bool(element, property);

        let mut actions = Vec::new();
        if has(UIA_IsInvokePatternAvailablePropertyId) {
            actions.push("invoke");
        }
        if has(UIA_IsTogglePatternAvailablePropertyId) {
            actions.push("toggle");
        }
        if has(UIA_IsSelectionItemPatternAvailablePropertyId) {
            actions.push("select");
        }
        let expandable = has(UIA_IsExpandCollapsePatternAvailablePropertyId);
        let value_pattern = has(UIA_IsValuePatternAvailablePropertyId);
        let range_pattern = has(UIA_IsRangeValuePatternAvailablePropertyId);
        let scrollable = has(UIA_IsScrollPatternAvailablePropertyId);
        if has(UIA_IsScrollItemPatternAvailablePropertyId) {
            actions.push("scrollIntoView");
        }
        if has(UIA_IsTextPatternAvailablePropertyId) {
            actions.push("readText");
        }

        let read_only = value_pattern.then(|| has(UIA_ValueIsReadOnlyPropertyId));
        if value_pattern && read_only == Some(false) || range_pattern {
            actions.push("setValue");
        }

        let expand_state = if expandable {
            match cached(element, UIA_ExpandCollapseExpandCollapseStatePropertyId).and_then(|v| v.i32()) {
                Some(0) => Some("collapsed"),
                Some(1) => Some("expanded"),
                Some(2) => Some("partial"),
                _ => None, // leaf nodes report 3 and cannot expand
            }
        } else {
            None
        };
        if let Some(state) = expand_state {
            actions.push(if state == "expanded" { "collapse" } else { "expand" });
        }

        let scroll = if scrollable {
            let vertical = has(UIA_ScrollVerticallyScrollablePropertyId)
                .then(|| cached(element, UIA_ScrollVerticalScrollPercentPropertyId).and_then(|v| v.f64()))
                .flatten();
            let horizontal = has(UIA_ScrollHorizontallyScrollablePropertyId)
                .then(|| cached(element, UIA_ScrollHorizontalScrollPercentPropertyId).and_then(|v| v.f64()))
                .flatten();
            if vertical.is_some() || horizontal.is_some() {
                actions.push("scroll");
                Some(ScrollInfo { vertical, horizontal })
            } else {
                None
            }
        } else {
            None
        };

        let default_action = if has(UIA_IsLegacyIAccessiblePatternAvailablePropertyId) {
            string(UIA_LegacyIAccessibleDefaultActionPropertyId)
        } else {
            String::new()
        };
        if !default_action.is_empty() {
            actions.push("defaultAction");
        }

        let value = value_pattern
            .then(|| cached(element, UIA_ValueValuePropertyId).and_then(|v| v.string()))
            .flatten()
            .filter(|value| !value.is_empty())
            .map(|value| truncate(value, max_value));

        let range = range_pattern
            .then(|| {
                Some(RangeInfo {
                    value: cached(element, UIA_RangeValueValuePropertyId)?.f64()?,
                    min: cached(element, UIA_RangeValueMinimumPropertyId)?.f64()?,
                    max: cached(element, UIA_RangeValueMaximumPropertyId)?.f64()?,
                })
            })
            .flatten();

        let toggle_state = has(UIA_IsTogglePatternAvailablePropertyId)
            .then(|| match cached(element, UIA_ToggleToggleStatePropertyId).and_then(|v| v.i32()) {
                Some(0) => Some("off"),
                Some(1) => Some("on"),
                Some(2) => Some("indeterminate"),
                _ => None,
            })
            .flatten();

        let selected = has(UIA_IsSelectionItemPatternAvailablePropertyId)
            .then(|| has(UIA_SelectionItemIsSelectedPropertyId));

        let native = element.CachedNativeWindowHandle().ok().filter(|h| !h.is_invalid()).map(hwnd_value);

        let runtime_id = cached(element, UIA_RuntimeIdPropertyId)
            .and_then(|v| v.int_array())
            .filter(|ids| !ids.is_empty())
            .map(|ids| ids.iter().map(i32::to_string).collect::<Vec<_>>().join("."));

        Node {
            id,
            parent,
            depth,
            runtime_id,
            role: role_name(element.CachedControlType().unwrap_or_default()),
            localized_role: element.CachedLocalizedControlType().map(|s| s.to_string()).unwrap_or_default(),
            name: truncate(element.CachedName().map(|s| s.to_string()).unwrap_or_default(), max_value),
            value,
            automation_id: element.CachedAutomationId().map(|s| s.to_string()).unwrap_or_default(),
            class_name: element.CachedClassName().map(|s| s.to_string()).unwrap_or_default(),
            rect: element.CachedBoundingRectangle().map(Rect::from).unwrap_or_default(),
            enabled: element.CachedIsEnabled().map(|b| b.as_bool()).unwrap_or(true),
            offscreen: element.CachedIsOffscreen().map(|b| b.as_bool()).unwrap_or(false),
            focused: element.CachedHasKeyboardFocus().map(|b| b.as_bool()).unwrap_or(false),
            focusable: element.CachedIsKeyboardFocusable().map(|b| b.as_bool()).unwrap_or(false),
            actions,
            toggle_state,
            expand_state,
            selected,
            read_only,
            range,
            scroll,
            default_action,
            help_text: truncate(element.CachedHelpText().map(|s| s.to_string()).unwrap_or_default(), max_value),
            accelerator: element.CachedAcceleratorKey().map(|s| s.to_string()).unwrap_or_default(),
            access_key: element.CachedAccessKey().map(|s| s.to_string()).unwrap_or_default(),
            native_hwnd: native,
        }
    }
}

fn cache_request(
    automation: &IUIAutomation,
    scope: TreeScope,
    filter: Option<IUIAutomationCondition>,
) -> windows::core::Result<IUIAutomationCacheRequest> {
    unsafe {
        let request = automation.CreateCacheRequest()?;
        for &property in PROPERTIES {
            request.AddProperty(property)?;
        }
        request.SetTreeScope(scope)?;
        if let Some(filter) = filter {
            request.SetTreeFilter(&filter)?;
        }
        // Full mode keeps live references, so actions can reach the elements later.
        request.SetAutomationElementMode(AutomationElementMode_Full)?;
        Ok(request)
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotParams {
    hwnd: i64,
    #[serde(default = "default_max_nodes")]
    max_nodes: usize,
    #[serde(default = "default_max_depth")]
    max_depth: u32,
    #[serde(default)]
    include_offscreen: bool,
    #[serde(default)]
    raw: bool,
    #[serde(default = "default_max_value")]
    max_value_length: usize,
}

fn default_max_nodes() -> usize {
    5000
}
fn default_max_depth() -> u32 {
    64
}
fn default_max_value() -> usize {
    400
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ElementParams {
    hwnd: i64,
    element_id: usize,
    #[serde(default)]
    snapshot_id: Option<u64>,
    #[serde(default)]
    action: String,
    #[serde(default)]
    value: Option<String>,
    #[serde(default)]
    direction: Option<String>,
    #[serde(default)]
    amount: Option<u32>,
    #[serde(default)]
    page: bool,
    #[serde(default)]
    max_length: Option<i32>,
    #[serde(default)]
    wait_ms: Option<u64>,
}

#[derive(Deserialize)]
struct PointParams {
    x: i32,
    y: i32,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct FocusParams {
    hwnd: Option<i64>,
}

/// A UIA element handed to a worker thread. The helper runs in the multithreaded
/// apartment, where element proxies may be used from any thread.
struct SendElement(IUIAutomationElement);
unsafe impl Send for SendElement {}

fn perform(element: &IUIAutomationElement, params: &ElementParams) -> Result<Value, RpcError> {
    let action = params.action.as_str();
    let unsupported = || RpcError::new("unsupported", format!("Element {} does not support {action}.", params.element_id));
    unsafe {
        match action {
            "invoke" => element
                .GetCurrentPatternAs::<IUIAutomationInvokePattern>(UIA_InvokePatternId)
                .map_err(|_| unsupported())?
                .Invoke()?,
            "toggle" => element
                .GetCurrentPatternAs::<IUIAutomationTogglePattern>(UIA_TogglePatternId)
                .map_err(|_| unsupported())?
                .Toggle()?,
            "select" | "addToSelection" | "removeFromSelection" => {
                let pattern = element
                    .GetCurrentPatternAs::<IUIAutomationSelectionItemPattern>(UIA_SelectionItemPatternId)
                    .map_err(|_| unsupported())?;
                match action {
                    "select" => pattern.Select()?,
                    "addToSelection" => pattern.AddToSelection()?,
                    _ => pattern.RemoveFromSelection()?,
                }
            }
            "expand" | "collapse" => {
                let pattern = element
                    .GetCurrentPatternAs::<IUIAutomationExpandCollapsePattern>(UIA_ExpandCollapsePatternId)
                    .map_err(|_| unsupported())?;
                if action == "expand" { pattern.Expand()? } else { pattern.Collapse()? }
            }
            "setValue" => {
                let value = params.value.clone().unwrap_or_default();
                if let Ok(pattern) = element.GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId) {
                    pattern.SetValue(&windows::core::BSTR::from(value.as_str()))?;
                    // Report what the control holds now, so callers can verify the write.
                    let now = pattern.CurrentValue().map(|v| v.to_string()).ok();
                    return Ok(json!({ "ok": true, "value": now }));
                } else if let Ok(pattern) =
                    element.GetCurrentPatternAs::<IUIAutomationRangeValuePattern>(UIA_RangeValuePatternId)
                {
                    let number: f64 = value
                        .trim()
                        .parse()
                        .map_err(|_| RpcError::new("bad_params", "This element takes a numeric value."))?;
                    pattern.SetValue(number)?;
                } else {
                    return Err(unsupported());
                }
            }
            "focus" => element.SetFocus()?,
            "scrollIntoView" => element
                .GetCurrentPatternAs::<IUIAutomationScrollItemPattern>(UIA_ScrollItemPatternId)
                .map_err(|_| unsupported())?
                .ScrollIntoView()?,
            "defaultAction" => element
                .GetCurrentPatternAs::<IUIAutomationLegacyIAccessiblePattern>(UIA_LegacyIAccessiblePatternId)
                .map_err(|_| unsupported())?
                .DoDefaultAction()?,
            "showContextMenu" => element.cast::<IUIAutomationElement3>().map_err(|_| unsupported())?.ShowContextMenu()?,
            "scroll" => {
                let pattern = element
                    .GetCurrentPatternAs::<IUIAutomationScrollPattern>(UIA_ScrollPatternId)
                    .map_err(|_| unsupported())?;
                let (forward, backward) = if params.page {
                    (ScrollAmount_LargeIncrement, ScrollAmount_LargeDecrement)
                } else {
                    (ScrollAmount_SmallIncrement, ScrollAmount_SmallDecrement)
                };
                let (horizontal, vertical) = match params.direction.as_deref().unwrap_or("down") {
                    "down" => (ScrollAmount_NoAmount, forward),
                    "up" => (ScrollAmount_NoAmount, backward),
                    "right" => (forward, ScrollAmount_NoAmount),
                    "left" => (backward, ScrollAmount_NoAmount),
                    other => return Err(RpcError::new("bad_params", format!("Unknown scroll direction {other}"))),
                };
                for _ in 0..params.amount.unwrap_or(1).clamp(1, 50) {
                    pattern.Scroll(horizontal, vertical)?;
                }
            }
            "readText" => {
                let pattern = element
                    .GetCurrentPatternAs::<IUIAutomationTextPattern>(UIA_TextPatternId)
                    .map_err(|_| unsupported())?;
                let text = pattern.DocumentRange()?.GetText(params.max_length.unwrap_or(20000))?;
                return Ok(json!({ "ok": true, "text": text.to_string() }));
            }
            other => return Err(RpcError::new("bad_params", format!("Unknown element action {other}"))),
        }
    }
    Ok(json!({ "ok": true }))
}

impl Session {
    pub fn new() -> windows::core::Result<Self> {
        unsafe {
            let automation: IUIAutomation = CoCreateInstance(&CUIAutomation8, None, CLSCTX_INPROC_SERVER)
                .or_else(|_| CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER))?;
            if let Ok(automation2) = automation.cast::<IUIAutomation2>() {
                // A hung app must not hang the helper.
                let _ = automation2.SetConnectionTimeout(2000);
                let _ = automation2.SetTransactionTimeout(8000);
            }
            let control_view = cache_request(&automation, TreeScope_Subtree, Some(automation.ControlViewCondition()?))?;
            let mut onscreen = VARIANT::default();
            (*onscreen.Anonymous.Anonymous).vt = VT_BOOL;
            (*onscreen.Anonymous.Anonymous).Anonymous.boolVal = windows::Win32::Foundation::VARIANT_BOOL(0);
            let not_offscreen = automation.CreatePropertyCondition(UIA_IsOffscreenPropertyId, &onscreen)?;
            let onscreen_condition = automation.CreateAndCondition(&automation.ControlViewCondition()?, &not_offscreen)?;
            let onscreen_view = cache_request(&automation, TreeScope_Subtree, Some(onscreen_condition))?;
            let raw_view = cache_request(&automation, TreeScope_Subtree, Some(automation.RawViewCondition()?))?;
            let single = cache_request(&automation, TreeScope_Element, None)?;
            Ok(Self { automation, control_view, onscreen_view, raw_view, single, snapshots: HashMap::new(), next_snapshot: 1 })
        }
    }

    pub fn snapshot(&mut self, params: Value) -> Result<Value, RpcError> {
        let params: SnapshotParams = parse(params)?;
        let hwnd = ensure_window(params.hwnd)?;
        let started = Instant::now();
        let request = if params.raw {
            &self.raw_view
        } else if params.include_offscreen {
            &self.control_view
        } else {
            &self.onscreen_view
        };
        let root = unsafe { self.automation.ElementFromHandleBuildCache(hwnd, request)? };

        let mut nodes: Vec<Node> = Vec::new();
        let mut elements: Vec<IUIAutomationElement> = Vec::new();
        let mut truncated = false;
        let mut stack: Vec<(IUIAutomationElement, i64, u32)> = vec![(root, -1, 0)];
        while let Some((element, parent, depth)) = stack.pop() {
            if nodes.len() >= params.max_nodes {
                truncated = true;
                break;
            }
            let node = describe(&element, nodes.len(), parent, depth, params.max_value_length);
            // Offscreen elements are left out, but their children are still visited:
            // some frameworks flag containers offscreen while their content is visible.
            let include = depth == 0 || params.include_offscreen || !node.offscreen;
            let child_parent = if include {
                let id = node.id as i64;
                nodes.push(node);
                elements.push(element.clone());
                id
            } else {
                parent
            };
            if depth >= params.max_depth {
                continue;
            }
            if let Ok(children) = unsafe { element.GetCachedChildren() } {
                let count = unsafe { children.Length() }.unwrap_or(0);
                for index in (0..count).rev() {
                    if let Ok(child) = unsafe { children.GetElement(index) } {
                        stack.push((child, child_parent, depth + 1));
                    }
                }
            }
        }

        let id = self.next_snapshot;
        self.next_snapshot += 1;
        if self.snapshots.len() >= MAX_RETAINED_WINDOWS && !self.snapshots.contains_key(&params.hwnd) {
            if let Some(oldest) = self.snapshots.iter().min_by_key(|(_, s)| s.taken).map(|(k, _)| *k) {
                self.snapshots.remove(&oldest);
            }
        }
        self.snapshots.insert(params.hwnd, Snapshot { id, taken: Instant::now(), elements });

        Ok(json!({
            "snapshotId": id,
            "window": describe_window(hwnd),
            "nodes": nodes,
            "truncated": truncated,
            "elapsedMs": started.elapsed().as_millis() as u64,
        }))
    }

    fn element(&self, hwnd: i64, element_id: usize, snapshot_id: Option<u64>) -> Result<&IUIAutomationElement, RpcError> {
        let snapshot = self.snapshots.get(&hwnd).ok_or_else(|| {
            RpcError::new("no_snapshot", "No app state for this window yet. Get the app state first.")
        })?;
        if let Some(expected) = snapshot_id {
            if expected != snapshot.id {
                return Err(RpcError::new(
                    "stale_snapshot",
                    "The app state was refreshed since these element indices were issued. Use the latest indices.",
                ));
            }
        }
        snapshot
            .elements
            .get(element_id)
            .ok_or_else(|| RpcError::new("bad_element", format!("No element {element_id} in the latest app state.")))
    }

    pub fn element_action(&mut self, params: Value) -> Result<Value, RpcError> {
        let params: ElementParams = parse(params)?;
        ensure_window(params.hwnd)?;
        crate::guard::check_stop()?;
        let element = SendElement(self.element(params.hwnd, params.element_id, params.snapshot_id)?.clone());
        // Some providers only return from Invoke once a modal dialog it opened closes.
        // Run the action on a worker so the helper stays responsive, and report it as
        // still running when it outlasts the wait.
        let wait = std::time::Duration::from_millis(params.wait_ms.unwrap_or(1500).clamp(50, 30000));
        let (sender, receiver) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let element = element;
            unsafe {
                let _ = windows::Win32::System::Com::CoInitializeEx(None, windows::Win32::System::Com::COINIT_MULTITHREADED);
            }
            let _ = sender.send(perform(&element.0, &params));
        });
        match receiver.recv_timeout(wait) {
            Ok(result) => result,
            Err(_) => Ok(json!({ "ok": true, "pending": true })),
        }
    }

    /// Fresh geometry and state for one element, used before physical input.
    pub fn element_info(&mut self, params: Value) -> Result<Value, RpcError> {
        let params: ElementParams = parse(params)?;
        ensure_window(params.hwnd)?;
        let element = self.element(params.hwnd, params.element_id, params.snapshot_id)?.clone();
        unsafe {
            let fresh = element.BuildUpdatedCache(&self.single)?;
            let node = describe(&fresh, params.element_id, -1, 0, 400);
            let mut point = POINT::default();
            let clickable = element.GetClickablePoint(&mut point).map(|got| got.as_bool()).unwrap_or(false);
            let clickable_point = if clickable {
                Some(json!({ "x": point.x, "y": point.y }))
            } else {
                None
            };
            Ok(json!({ "node": node, "clickablePoint": clickable_point }))
        }
    }

    fn describe_detached(&self, element: &IUIAutomationElement) -> Result<Value, RpcError> {
        unsafe {
            let fresh = element.BuildUpdatedCache(&self.single)?;
            let node = describe(&fresh, 0, -1, 0, 400);
            let native = fresh.CachedNativeWindowHandle().ok().filter(|h| !h.is_invalid());
            let top = native.map(|h| GetAncestor(h, GA_ROOT)).filter(|h| !h.is_invalid());
            Ok(json!({ "node": node, "topWindow": top.map(hwnd_value) }))
        }
    }

    pub fn element_at_point(&mut self, params: Value) -> Result<Value, RpcError> {
        let params: PointParams = parse(params)?;
        let element = unsafe { self.automation.ElementFromPoint(POINT { x: params.x, y: params.y })? };
        let mut result = self.describe_detached(&element)?;
        // The element itself may be windowless; the root window under the point is reliable.
        let window = unsafe {
            windows::Win32::UI::WindowsAndMessaging::WindowFromPoint(POINT { x: params.x, y: params.y })
        };
        if !window.is_invalid() {
            result["topWindow"] = json!(hwnd_value(unsafe { GetAncestor(window, GA_ROOT) }));
        }
        Ok(result)
    }

    /// Type text, confirming against the focused element's value as it goes.
    pub fn type_text(&mut self, params: Value) -> Result<Value, RpcError> {
        let automation = self.automation.clone();
        crate::input::type_text(params, move || unsafe {
            let element = automation.GetFocusedElement().ok()?;
            let pattern = element.GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId).ok()?;
            Some(pattern.CurrentValue().ok()?.len())
        })
    }

    pub fn focused_element(&mut self, params: Value) -> Result<Value, RpcError> {
        let params: FocusParams = parse(params)?;
        let element = unsafe { self.automation.GetFocusedElement()? };
        let mut result = self.describe_detached(&element)?;
        // Report the snapshot index when the focused element is in the window's latest state.
        if let Some(hwnd) = params.hwnd {
            if let Some(snapshot) = self.snapshots.get(&hwnd) {
                for (index, candidate) in snapshot.elements.iter().enumerate() {
                    if unsafe { self.automation.CompareElements(&element, candidate) }.is_ok_and(|same| same.as_bool()) {
                        result["elementId"] = json!(index);
                        break;
                    }
                }
            }
        }
        Ok(result)
    }
}
