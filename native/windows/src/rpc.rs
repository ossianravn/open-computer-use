use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::Value;

#[derive(Deserialize)]
pub struct Request {
    #[serde(default)]
    pub id: Value,
    pub method: String,
    #[serde(default)]
    pub params: Value,
}

#[derive(Serialize)]
pub struct Response {
    pub id: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<RpcError>,
}

impl Response {
    pub fn ok(id: Value, result: Value) -> Self {
        Self { id, result: Some(result), error: None }
    }
    pub fn err(id: Value, error: RpcError) -> Self {
        Self { id, result: None, error: Some(error) }
    }
}

#[derive(Serialize, Debug)]
pub struct RpcError {
    pub code: String,
    pub message: String,
}

impl RpcError {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self { code: code.to_string(), message: message.into() }
    }
}

impl From<windows::core::Error> for RpcError {
    fn from(error: windows::core::Error) -> Self {
        // UIA_E_ELEMENTNOTAVAILABLE: the element left the tree since the snapshot.
        if error.code().0 as u32 == 0x80040201 {
            return RpcError::new(
                "element_unavailable",
                "The element is no longer available. Refresh the app state and use the new index.",
            );
        }
        // UIA_E_TIMEOUT: the app did not answer in time.
        if error.code().0 as u32 == 0x80131505 {
            return RpcError::new("timeout", "The app did not respond to UI Automation in time.");
        }
        RpcError::new("windows_error", format!("{} ({:#010x})", error.message(), error.code().0 as u32))
    }
}

/// Parse request params into a typed struct; `null` params behave like `{}`.
pub fn parse<T: DeserializeOwned>(params: Value) -> Result<T, RpcError> {
    let params = if params.is_null() { Value::Object(Default::default()) } else { params };
    serde_json::from_value(params).map_err(|error| RpcError::new("bad_params", error.to_string()))
}

pub fn to_value<T: Serialize>(value: T) -> Result<Value, RpcError> {
    serde_json::to_value(value).map_err(|error| RpcError::new("encode_failed", error.to_string()))
}
