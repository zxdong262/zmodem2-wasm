import { Terminal, IDisposable } from '@xterm/xterm'
import init, { WasmReceiver, WasmSender } from '../../../pkg/zmodem2_wasm.js'

export default class AddonZmodemWasm {
  _disposables: IDisposable[] = []
  socket: WebSocket | null = null
  term: Terminal | null = null
  receiver: WasmReceiver | null = null
  sender: WasmSender | null = null
  wasmInitialized = false
  onDetect: ((type: 'receive' | 'send') => void) | null = null
  isPickingFile = false
  
  // FIX: Add a flag to prevent concurrent reads
  _reading = false
  
  // Buffer for read-ahead
  _fileBuffer: Uint8Array | null = null
  _fileBufferOffset = 0
  readonly BUFFER_SIZE = 10 * 1024 * 1024 // 10MB
  
  currentFile: { name: string, size: number, data: Uint8Array[] } | null = null
  sendingFile: File | null = null

  senderStartTime: number = 0
  senderBytesSent: number = 0
  senderLastLogTime: number = 0
  receiverStartTime: number = 0
  receiverBytesReceived: number = 0
  receiverLastLogTime: number = 0

  constructor() {
    this.initWasm()
  }

  async initWasm() {
    try {
        await init()
        this.wasmInitialized = true
        console.log('ZMODEM WASM initialized')
    } catch (e) {
        console.error('Failed to init WASM', e)
    }
  }

  activate(terminal: Terminal) {
    this.term = terminal
  }

  dispose() {
    this.receiver = null
    this.sender = null
    this._fileBuffer = null
    this._disposables.forEach(d => d.dispose())
    this._disposables = []
  }

  zmodemAttach(ctx: { socket: WebSocket, term: Terminal, onDetect?: (type: 'receive' | 'send') => void }) {
    this.socket = ctx.socket
    this.term = ctx.term
    this.socket.binaryType = 'arraybuffer'
    if (ctx.onDetect) this.onDetect = ctx.onDetect
  }

  consume(data: ArrayBuffer | string) {
    if (!this.wasmInitialized) {
        if (typeof data === 'string') this.term?.write(data)
        else this.term?.write(new Uint8Array(data))
        return
    }

    if (this.receiver) {
      this.handleReceiver(data)
      return
    }

    if (this.sender) {
      this.handleSender(data)
      return
    }
    
    if (typeof data === 'string') {
      this.term?.write(data)
      return
    }

    const u8 = new Uint8Array(data)
    
    // Detection: ** + \x18 + B (ZHEX)
    let foundIdx = -1
    for (let i = 0; i < u8.length - 3; i++) {
      if (u8[i] === 0x2a && u8[i+1] === 0x2a && u8[i+2] === 0x18 && u8[i+3] === 0x42) {
        foundIdx = i
        break
      }
    }
    
    if (foundIdx >= 0) {
      // Check next 2 bytes for Frame Type (Hex Encoded)
      // ZRQINIT = 00 (0x30 0x30) -> Receiver
      // ZRINIT  = 01 (0x30 0x31) -> Sender
      if (foundIdx + 5 < u8.length) {
          const typeHex1 = u8[foundIdx + 4]
          const typeHex2 = u8[foundIdx + 5]
          
          if (typeHex1 === 0x30 && typeHex2 === 0x30) {
              console.log('ZMODEM ZRQINIT detected (Receive)')
               if (foundIdx > 0) {
                this.term?.write(u8.subarray(0, foundIdx))
              }
              this.startReceiver(u8.subarray(foundIdx))
              return
          } else if (typeHex1 === 0x30 && typeHex2 === 0x31) {
              console.log('ZMODEM ZRINIT detected (Send)')
              if (!this.isPickingFile) {
                  this.isPickingFile = true
                  this.onDetect?.('send')
              }
              return
          }
      }
      
      // Fallback if not sure
      this.term?.write(u8)
    } else {
      this.term?.write(u8)
    }
  }

  async sendFile(file: File) {
      this.isPickingFile = false
      this.sendingFile = file
      this.sender = new WasmSender()
      this._reading = false
      this._fileBuffer = null
      this._fileBufferOffset = 0
      this.senderStartTime = Date.now()
      this.senderBytesSent = 0
      this.senderLastLogTime = 0
      
      this.term?.writeln(`\r\n[ZMODEM] Starting Sender for ${file.name} (${file.size} bytes)`)
      try {
          this.sender.start_file(file.name, file.size)
          this.pumpSender()
      } catch (e) {
          console.error('Failed to start sender', e)
          this.sender = null
      }
  }

  handleSender(data: ArrayBuffer | Uint8Array | string) {
      if (!this.sender) return
      const u8 = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data)
      
      let offset = 0
      let loopCount = 0
      
      while (offset < u8.length && loopCount++ < 1000) {
          if (!this.sender) break
          try {
              const chunk = u8.subarray(offset)
              const consumed = this.sender.feed(chunk)
              offset += consumed
              
              const drained = this.pumpSender()
              
              // If we didn't consume input and didn't generate output/events, we are stuck.
              if (consumed === 0 && !drained) {
                  // But maybe the sender is just waiting for file data and can't consume more ACKs?
                  if (loopCount > 1) console.warn('Sender stuck: 0 consumed, 0 drained')
                  break
              }
          } catch (e) {
              console.error('Sender error:', e)
              this.term?.writeln('\r\nZMODEM Sender Error: ' + e)
              this.sender = null
              this.sendingFile = null
              this._fileBuffer = null
              break
          }
      }
  }

  pumpSender(): boolean {
      if (!this.sender) return false
      let didWork = false
      
      const outgoingChunks: Uint8Array[] = []
      let totalOutgoingSize = 0
      const FLUSH_THRESHOLD = 64 * 1024 // 64KB

      const flushOutgoing = () => {
          if (outgoingChunks.length === 0) return
          if (outgoingChunks.length === 1) {
              this.socket?.send(outgoingChunks[0])
          } else {
              this.socket?.send(new Blob(outgoingChunks as any[]))
          }
          outgoingChunks.length = 0
          totalOutgoingSize = 0
      }

      try {
          const outgoing = this.sender.drain_outgoing()
          if (outgoing && outgoing.length > 0) {
              outgoingChunks.push(outgoing)
              totalOutgoingSize += outgoing.length
              didWork = true
          }

          while (true) {
              const event = this.sender.poll()
              if (!event) break

              const e = event as any
            //   console.log('WASM Sender Event:', e)
              didWork = true

              if (e.type === 'need_file_data') {
                  const start = e.offset
                  const length = e.length
                  this.term?.writeln(`\r[ZMODEM] Requesting data: offset=${start}, length=${length}`)

                  // 1. Try to serve from buffer synchronously
                  if (this._fileBuffer && 
                      start >= this._fileBufferOffset && 
                      (start + length) <= (this._fileBufferOffset + this._fileBuffer.byteLength)) {
                      
                      const relativeStart = start - this._fileBufferOffset
                      const chunk = this._fileBuffer.subarray(relativeStart, relativeStart + length)
                      this.sender.feed_file(chunk)
                      
                      this.senderBytesSent = start + length
                      this.logSenderProgress()

                      // IMPORTANT: Drain outgoing data immediately after feeding
                      const outgoing = this.sender.drain_outgoing()
                      if (outgoing && outgoing.length > 0) {
                          outgoingChunks.push(outgoing)
                          totalOutgoingSize += outgoing.length
                          
                          if (totalOutgoingSize > FLUSH_THRESHOLD) {
                              flushOutgoing()
                          }
                      }
                      
                      // Continue loop synchronously
                      continue
                  }

                  // 2. Not in buffer, need to load
                  // FIX: Check if we are already reading to avoid race conditions
                  if (this.sendingFile && !this._reading) {
                      flushOutgoing() // Flush before async break
                      this._reading = true // Lock
                      this.loadBufferAndFeed(start, length)
                      
                      // Break loop to wait for async read
                      break 
                  } else if (this._reading) {
                      // Already reading, break loop and wait for that to finish
                      break
                  }
              } else if (e.type === 'file_complete') {
                  this.term?.writeln('\r\nZMODEM: File sent.')
                  this.sender.finish_session()
              } else if (e.type === 'session_complete') {
                  this.term?.writeln('\r\nZMODEM: Session complete.')
                  this.sender = null
                  this.sendingFile = null
                  this._fileBuffer = null
                  flushOutgoing() // Flush final packets
                  return true
              }
          }
      } catch (e) {
          console.error('Pump Sender Error:', e)
          this.term?.writeln('\r\nZMODEM Pump Error: ' + e)
          this.sender = null
      }
      
      flushOutgoing() // Flush anything remaining at end of loop
      return didWork
  }

  async loadBufferAndFeed(offset: number, length: number) {
      if (!this.sender || !this.sendingFile) {
          this._reading = false
          return
      }
      try {
          // Read a larger chunk to minimize I/O and async overhead
          const readSize = Math.max(length, this.BUFFER_SIZE)
          const end = Math.min(offset + readSize, this.sendingFile.size)
          const slice = this.sendingFile.slice(offset, end)

          const buffer = await slice.arrayBuffer()
          if (!this.sender) return
          const u8 = new Uint8Array(buffer)

          // Update buffer
          this._fileBuffer = u8
          this._fileBufferOffset = offset

          // Feed the requested part
          // Since we read from 'offset', the requested data starts at 0 in the new buffer
          // Note: u8.length might be less than length if we hit EOF
          const feedLen = Math.min(length, u8.length)
          const chunk = u8.subarray(0, feedLen)
          
          this.sender.feed_file(chunk)
          
          this.senderBytesSent = offset + feedLen
          if (this.senderBytesSent % (1024 * 1024) === 0 || this.senderBytesSent === this.sendingFile?.size) {
              this.logSenderProgress()
          }
          
          // Unlock BEFORE pumping
          this._reading = false 
          
          this.pumpSender()
      } catch (e) {
          console.error('Buffer read error', e)
          
          // Ensure we unlock on error
          this._reading = false
          
          // Try to pump again to see if we can recover
          try { this.pumpSender() } catch (_) {}
      }
  }

  logSenderProgress() {
      if (!this.sendingFile || !this.term) return
      
      const now = Date.now()
      const timeSinceLastLog = now - this.senderLastLogTime
      
      const percent = ((this.senderBytesSent / this.sendingFile.size) * 100).toFixed(2)
      const elapsed = (now - this.senderStartTime) / 1000
      const speed = elapsed > 0 ? (this.senderBytesSent / elapsed / 1024 / 1024).toFixed(2) : '0.00'
      
      this.term.writeln(`\r[ZMODEM Send] Progress: ${percent}% | Speed: ${speed} MB/s | Sent: ${this.senderBytesSent}/${this.sendingFile.size} bytes`)
      this.senderLastLogTime = now
  }

  logReceiverProgress() {
      if (!this.currentFile || !this.term) return
      
      const now = Date.now()
      const timeSinceLastLog = now - this.receiverLastLogTime
      
      const percent = ((this.receiverBytesReceived / this.currentFile.size) * 100).toFixed(2)
      const elapsed = (now - this.receiverStartTime) / 1000
      const speed = elapsed > 0 ? (this.receiverBytesReceived / elapsed / 1024 / 1024).toFixed(2) : '0.00'
      
      this.term.writeln(`\r[ZMODEM Receive] Progress: ${percent}% | Speed: ${speed} MB/s | Received: ${this.receiverBytesReceived}/${this.currentFile.size} bytes`)
      this.receiverLastLogTime = now
  }

  startReceiver(initialData: Uint8Array) {
    console.log('Starting Receiver...')
    try {
        this.receiver = new WasmReceiver()
        this.handleReceiver(initialData)
    } catch (e) {
        console.error('Failed to create Receiver', e)
    }
  }

  handleReceiver(data: ArrayBuffer | Uint8Array | string) {
    if (!this.receiver) return
    const u8 = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data)

    let offset = 0
    let loopCount = 0

    while (offset < u8.length && loopCount++ < 1000) {
        if (!this.receiver) break
        try {
            const chunk = u8.subarray(offset)
            const consumed = this.receiver.feed(chunk)
            offset += consumed
            
            const drained = this.pumpReceiver()
            
            if (consumed === 0 && !drained) {
                 if (loopCount > 1) console.warn('Receiver stuck: 0 consumed, 0 drained')
                 break
            }
        } catch (e) {
            console.error('Receiver error:', e)
            this.term?.writeln('\r\nZMODEM: Error ' + e)
            this.receiver = null
            break
        }
    }
  }

  pumpReceiver(): boolean {
      if (!this.receiver) return false
      let didWork = false
      
      try {
        const outgoing = this.receiver.drain_outgoing()
        if (outgoing && outgoing.length > 0) {
            this.socket?.send(outgoing)
            didWork = true
        }
        
        while (true) {
            const event = this.receiver.poll()
            if (!event) break
            
            const e = event as any
            console.log('WASM Event:', e)
            didWork = true
            
            if (e.type === 'file_start') {
                this.term?.writeln(`\r\nZMODEM: Receiving ${e.name} (${e.size} bytes)...`)
                this.currentFile = { name: e.name, size: e.size, data: [] }
                this.receiverStartTime = Date.now()
                this.receiverBytesReceived = 0
                this.receiverLastLogTime = 0
                this.term?.writeln(`\r[ZMODEM] Receiver initialized for ${e.name}`)
            } else if (e.type === 'file_complete') {
                this.term?.writeln('\r\nZMODEM: File complete.')
                this.saveFile()
            } else if (e.type === 'session_complete') {
                this.term?.writeln('\r\nZMODEM: Session complete.')
                this.receiver = null
                this.currentFile = null
                return true
            }
        }
        
        const chunk = this.receiver.drain_file()
        if (chunk && chunk.length > 0) {
            if (this.currentFile) {
                this.currentFile.data.push(chunk)
                this.receiverBytesReceived += chunk.length
                this.logReceiverProgress()
                didWork = true
            }
        }
        
    } catch (e) {
        console.error('Receiver error:', e)
        this.term?.writeln('\r\nZMODEM: Error ' + e)
        this.receiver = null
    }
    return didWork
  }

  saveFile() {
    if (!this.currentFile) return
    const blob = new Blob(this.currentFile.data as any, { type: 'application/octet-stream' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = this.currentFile.name
    a.click()
    URL.revokeObjectURL(url)
    this.currentFile = null
  }
}