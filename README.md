# zmodem2-wasm

[中文版](./README_cn.md)

**This project is a WebAssembly compilation of the [zmodem2](https://codeberg.org/jarkko/zmodem2) Rust crate.** 

All credit for the ZMODEM protocol implementation goes to the original author, **Jarkko Sakkinen**, and the contributors of the [zmodem2](https://codeberg.org/jarkko/zmodem2) project. This repository simply provides a WASM wrapper and NPM packaging for easier use in web-based terminal environments.

## Features

- **High Performance**: Powered by Rust and WebAssembly.
- **Modern API**: Easy-to-use TypeScript interfaces for ZMODEM sender and receiver.
- **xterm.js Integration**: Can be easily integrated with xterm.js for terminal file transfers.
- **Small Footprint**: Efficiently compiled WASM binary.

## Installation

```bash
npm install zmodem2-wasm
```

## Running the Demo

The repository includes a full demo showing how to use `zmodem2-wasm` with `xterm.js` and a Node.js backend.

### Prerequisites

- [Rust and wasm-pack](https://rustwasm.github.io/wasm-pack/installer/)
- Node.js and npm

### Steps

1. **Install Dependencies**:
   ```bash
   npm install
   ```

2. **Start the Docker Test Server** (Optional):
   For testing ZMODEM file transfers, you can run a Docker-based SSH server with ZMODEM support.
   ```bash
   cd src/dockers
   ./build.sh
   ./run.sh
   ```
   This will start an SSH server on port 23355 with user `zxd` (password: `zxd`) or `root` (password: `root`).

3. **Start the Backend**:
   The backend handles SSH/Terminal sessions.
   ```bash
   npm run backend
   ```

4. **Start the Frontend**:
   This will build the WASM and start the Vite dev server.
   ```bash
   npm start
   ```

5. **Access the Demo**:
   Open your browser at `http://localhost:3002`.

## Usage

### Initialization

```typescript
import init, { WasmReceiver, WasmSender } from 'zmodem2-wasm';

async function setup() {
    await init();
    const receiver = new WasmReceiver();
    const sender = new WasmSender();
}
```

### Receiving Files

```typescript
const receiver = new WasmReceiver();

// Feed incoming data from the wire
receiver.feed(data);

// Poll for events
const event = receiver.poll();
if (event && event.type === 'file_start') {
    console.log(`Receiving file: ${event.name}, size: ${event.size}`);
}

// Drain outgoing data to send back to the peer
const outgoing = receiver.drain_outgoing();
socket.send(outgoing);

// Drain received file data
const fileData = receiver.drain_file();
// Save fileData...
```

### Sending Files

```typescript
const sender = new WasmSender();

// Start sending a file
sender.start_file("hello.txt", data.length);

// Feed file data
sender.feed_file(data);

// Drain data to send over the wire
const outgoing = sender.drain_outgoing();
socket.send(outgoing);
```

## License

MIT OR Apache-2.0 (same as zmodem2)
