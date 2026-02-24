// ZMODEM2-WASM - WebAssembly wrapper for zmodem2

mod external;

#[cfg(target_arch = "wasm32")]
pub use external::{WasmReceiver, WasmSender};
