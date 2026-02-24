use wasm_bindgen::prelude::*;
use super::{Receiver, ReceiverEvent, Sender, SenderEvent, FileRequest};

#[wasm_bindgen]
pub struct WasmReceiver {
    inner: Receiver,
}

#[wasm_bindgen]
impl WasmReceiver {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Result<WasmReceiver, JsValue> {
        let inner = Receiver::new().map_err(|e| JsValue::from_str(&format!("{:?}", e)))?;
        Ok(WasmReceiver { inner })
    }

    pub fn feed(&mut self, data: &[u8]) -> Result<usize, JsValue> {
        self.inner.feed_incoming(data).map_err(|e| JsValue::from_str(&format!("{:?}", e)))
    }

    pub fn drain_outgoing(&mut self) -> Vec<u8> {
        let data = self.inner.drain_outgoing().to_vec();
        self.inner.advance_outgoing(data.len());
        data
    }
    
    pub fn drain_file(&mut self) -> Result<Vec<u8>, JsValue> {
        let data = self.inner.drain_file().to_vec();
        self.inner.advance_file(data.len()).map_err(|e| JsValue::from_str(&format!("{:?}", e)))?;
        Ok(data)
    }

    pub fn poll(&mut self) -> JsValue {
        match self.inner.poll_event() {
            Some(ReceiverEvent::FileStart) => {
                let name = String::from_utf8_lossy(self.inner.file_name()).to_string();
                let size = self.inner.file_size();
                let obj = js_sys::Object::new();
                let _ = js_sys::Reflect::set(&obj, &"type".into(), &"file_start".into());
                let _ = js_sys::Reflect::set(&obj, &"name".into(), &name.into());
                let _ = js_sys::Reflect::set(&obj, &"size".into(), &size.into());
                obj.into()
            },
            Some(ReceiverEvent::FileComplete) => {
                 let obj = js_sys::Object::new();
                let _ = js_sys::Reflect::set(&obj, &"type".into(), &"file_complete".into());
                obj.into()
            },
            Some(ReceiverEvent::SessionComplete) => {
                 let obj = js_sys::Object::new();
                let _ = js_sys::Reflect::set(&obj, &"type".into(), &"session_complete".into());
                obj.into()
            },
            None => JsValue::NULL
        }
    }
}

#[wasm_bindgen]
pub struct WasmSender {
    inner: Sender,
}

#[wasm_bindgen]
impl WasmSender {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Result<WasmSender, JsValue> {
        let inner = Sender::new().map_err(|e| JsValue::from_str(&format!("{:?}", e)))?;
        Ok(WasmSender { inner })
    }

    pub fn start_file(&mut self, file_name: &str, file_size: u32) -> Result<(), JsValue> {
        self.inner.start_file(file_name.as_bytes(), file_size).map_err(|e| JsValue::from_str(&format!("{:?}", e)))
    }

    pub fn finish_session(&mut self) -> Result<(), JsValue> {
        self.inner.finish_session().map_err(|e| JsValue::from_str(&format!("{:?}", e)))
    }

    pub fn feed(&mut self, data: &[u8]) -> Result<usize, JsValue> {
        self.inner.feed_incoming(data).map_err(|e| JsValue::from_str(&format!("{:?}", e)))
    }

    pub fn drain_outgoing(&mut self) -> Vec<u8> {
        let data = self.inner.drain_outgoing().to_vec();
        self.inner.advance_outgoing(data.len());
        data
    }
    
    pub fn feed_file(&mut self, data: &[u8]) -> Result<(), JsValue> {
        self.inner.feed_file(data).map_err(|e| JsValue::from_str(&format!("{:?}", e)))
    }

    pub fn poll(&mut self) -> JsValue {
        // Check events first
        if let Some(event) = self.inner.poll_event() {
            match event {
                SenderEvent::FileComplete => {
                    let obj = js_sys::Object::new();
                    let _ = js_sys::Reflect::set(&obj, &"type".into(), &"file_complete".into());
                    return obj.into();
                },
                SenderEvent::SessionComplete => {
                    let obj = js_sys::Object::new();
                    let _ = js_sys::Reflect::set(&obj, &"type".into(), &"session_complete".into());
                    return obj.into();
                }
            }
        }

        // Check file request
        if let Some(req) = self.inner.poll_file() {
             let obj = js_sys::Object::new();
             let _ = js_sys::Reflect::set(&obj, &"type".into(), &"need_file_data".into());
             let _ = js_sys::Reflect::set(&obj, &"offset".into(), &req.offset.into());
             let _ = js_sys::Reflect::set(&obj, &"length".into(), &(req.len as u32).into());
             return obj.into();
        }

        JsValue::NULL
    }
}
