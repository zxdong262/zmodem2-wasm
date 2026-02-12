# zmodem2-wasm

[English](./README.md)

**本项目仅将 [zmodem2](https://codeberg.org/jarkko/zmodem2) Rust crate 编译为 WebAssembly。**

ZMODEM 协议实现的所有功劳均归原作者 **Jarkko Sakkinen** 以及 [zmodem2](https://codeberg.org/jarkko/zmodem2) 项目的贡献者所有。本仓库仅提供 WASM 封装和 NPM 打包，以便在基于 Web 的终端环境中使用。

## 特性

- **高性能**: 由 Rust 和 WebAssembly 驱动。
- **现代 API**: 为 ZMODEM 发送者和接收者提供易于使用的 TypeScript 接口。
- **xterm.js 集成**: 可以轻松集成到 xterm.js 中，实现终端文件传输。
- **小体积**: 高效编译的 WASM 二进制文件。

## 安装

```bash
npm install zmodem2-wasm
```

## 运行 Demo

仓库包含一个完整的 Demo，展示了如何将 `zmodem2-wasm` 与 `xterm.js` 以及 Node.js 后端配合使用。

### 前置条件

- [Rust 和 wasm-pack](https://rustwasm.github.io/wasm-pack/installer/)
- Node.js 和 npm

### 步骤

1. **安装依赖**:
   ```bash
   npm install
   ```

2. **启动后端**:
   后端负责处理 SSH/终端会话。
   ```bash
   npm run backend
   ```

3. **启动前端**:
   这将编译 WASM 并启动 Vite 开发服务器。
   ```bash
   npm start
   ```

4. **访问 Demo**:
   在浏览器中打开 `http://localhost:3002`。

## 使用方法

### 初始化

```typescript
import init, { WasmReceiver, WasmSender } from 'zmodem2-wasm';

async function setup() {
    await init();
    const receiver = new WasmReceiver();
    const sender = new WasmSender();
}
```

### 接收文件

```typescript
const receiver = new WasmReceiver();

// 从网络读取数据并输入
receiver.feed(data);

// 轮询事件
const event = receiver.poll();
if (event && event.type === 'file_start') {
    console.log(`正在接收文件: ${event.name}, 大小: ${event.size}`);
}

// 提取待发送回对端的数据
const outgoing = receiver.drain_outgoing();
socket.send(outgoing);

// 提取已接收的文件数据
const fileData = receiver.drain_file();
// 保存 fileData...
```

### 发送文件

```typescript
const sender = new WasmSender();

// 开始发送文件
sender.start_file("hello.txt", data.length);

// 输入文件内容
sender.feed_file(data);

// 提取待通过网络发送的数据
const outgoing = sender.drain_outgoing();
socket.send(outgoing);
```

## 许可证

MIT OR Apache-2.0 (与 zmodem2 相同)
