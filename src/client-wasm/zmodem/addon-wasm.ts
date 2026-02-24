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
  
  // Double buffering for efficient large file uploads
  _currentBuffer: Uint8Array | null = null
  _currentBufferOffset = 0
  _nextBuffer: Uint8Array | null = null
  _nextBufferOffset = 0
  _reading = false
  _preloading = false
  
  // Threshold: files smaller than this get fully preloaded
  readonly SMALL_FILE_THRESHOLD = 50 * 1024 * 1024 // 50MB
  // Buffer size for large files
  readonly BUFFER_SIZE = 32 * 1024 * 1024 // 32MB
  
  // For small files, preload entire content
  _preloadedFile: Uint8Array | null = null
  _preloadedFileSize = 0
  
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
    this._currentBuffer = null
    this._nextBuffer = null
    this._preloadedFile = null
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
      this._preloading = false
      this._currentBuffer = null
      this._currentBufferOffset = 0
      this._nextBuffer = null
      this._nextBufferOffset = 0
      this.senderStartTime = Date.now()
      this.senderBytesSent = 0
      this.senderLastLogTime = 0
      
      this.term?.writeln(`\r\n[ZMODEM] Starting Sender for ${file.name} (${file.size} bytes)`)
      
      try {
          // For small files, preload entire file into memory
          if (file.size <= this.SMALL_FILE_THRESHOLD) {
              this.term?.writeln(`\r\n[ZMODEM] Small file, preloading into memory...`)
              const arrayBuffer = await file.arrayBuffer()
              this._preloadedFile = new Uint8Array(arrayBuffer)
              this._preloadedFileSize = file.size
              this.term?.writeln(`\r\n[ZMODEM] File preloaded (${this._preloadedFile.length} bytes)`)
          } else {
              // For large files, use double buffering
              this.term?.writeln(`\r\n[ZMODEM] Large file, using double buffering...`)
              // Preload first buffer
              await this.loadInitialBuffer()
          }
          
          this.sender.start_file(file.name, file.size)
          this.pumpSender()
      } catch (e) {
          console.error('Failed to start sender', e)
          this.sender = null
          this._preloadedFile = null
      }
  }

  async loadInitialBuffer() {
      if (!this.sendingFile) return
      
      const end = Math.min(this.BUFFER_SIZE, this.sendingFile.size)
      const slice = this.sendingFile.slice(0, end)
      const buffer = await slice.arrayBuffer()
      
      this._currentBuffer = new Uint8Array(buffer)
      this._currentBufferOffset = 0
      
      // Start preloading next buffer in background
      this.preloadNextBuffer(end)
  }

  async preloadNextBuffer(offset: number) {
      if (!this.sendingFile || this._preloading) return
      if (offset >= this.sendingFile.size) return
      
      this._preloading = true
      
      try {
          const end = Math.min(offset + this.BUFFER_SIZE, this.sendingFile.size)
          const slice = this.sendingFile.slice(offset, end)
          const buffer = await slice.arrayBuffer()
          
          this._nextBuffer = new Uint8Array(buffer)
          this._nextBufferOffset = offset
          
          // console.log(`Preloaded buffer at offset ${offset}, size ${this._nextBuffer.length}`)
      } catch (e) {
          console.error('Preload error:', e)
      } finally {
          this._preloading = false
      }
  }

  handleSender(data: ArrayBuffer | Uint8Array | string) {
      if (!this.sender) return
      const u8 = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data)

      console.log(`[DEBUG] handleSender: received ${u8.length} bytes`)
      
      let offset = 0
      let loopCount = 0
      
      while (offset < u8.length && loopCount++ < 1000) {
          if (!this.sender) break
          try {
              const chunk = u8.subarray(offset)
              const consumed = this.sender.feed(chunk)
              console.log(`[DEBUG] feed consumed ${consumed} bytes`)
              offset += consumed
              
              const drained = this.pumpSender()
              
              // If we didn't consume input, try to pump more data
              // The sender might be waiting for file data
              if (consumed === 0) {
                  // Try to pump one more time in case there's pending work
                  if (!drained) {
                      // Still no progress, but don't break immediately
                      // The sender might need more input data
                      if (offset < u8.length) {
                          // There's more input, continue trying
                          continue
                      }
                      break
                  }
              }
          } catch (e) {
              console.error('Sender error:', e)
              this.term?.writeln('\r\nZMODEM Sender Error: ' + e)
              this.sender = null
              this.sendingFile = null
              this._currentBuffer = null
              this._nextBuffer = null
              this._preloadedFile = null
              break
          }
      }
      
      console.log(`[DEBUG] handleSender done: processed ${offset}/${u8.length} bytes`)
  }

  pumpSender(): boolean {
      if (!this.sender) return false
      let didWork = false
      
      const outgoingChunks: Uint8Array[] = []
      let totalOutgoingSize = 0
      const FLUSH_THRESHOLD = 64 * 1024 // 64KB
      
      let needFileDataCount = 0
      let totalDataSent = 0

      const flushOutgoing = () => {
          if (outgoingChunks.length === 0) return
          console.log(`[DEBUG] Sending ${totalOutgoingSize} bytes, ${outgoingChunks.length} chunks`)
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
              didWork = true

              if (e.type === 'need_file_data') {
                  const start = e.offset
                  const length = e.length

                  needFileDataCount++
                  totalDataSent += length
                  
                  // Debug: log request size
                  console.log(`[DEBUG] need_file_data #${needFileDataCount}: offset=${start}, length=${length}, preloaded=${!!this._preloadedFile}`)

                  // 1. Fast path: serve from preloaded small file (synchronous)
                  if (this._preloadedFile && start + length <= this._preloadedFileSize) {
                      const chunk = this._preloadedFile.subarray(start, start + length)
                      this.sender.feed_file(chunk)
                      
                      this.senderBytesSent = start + length
                      this.logSenderProgress()

                      const outgoing = this.sender.drain_outgoing()
                      if (outgoing && outgoing.length > 0) {
                          console.log(`[DEBUG] drain_outgoing after feed: ${outgoing.length} bytes`)
                          outgoingChunks.push(outgoing)
                          totalOutgoingSize += outgoing.length
                          
                          if (totalOutgoingSize > FLUSH_THRESHOLD) {
                              flushOutgoing()
                          }
                      }
                      
                      continue
                  }

                  // 2. Try current buffer (synchronous)
                  if (this._currentBuffer && 
                      start >= this._currentBufferOffset && 
                      (start + length) <= (this._currentBufferOffset + this._currentBuffer.byteLength)) {
                      
                      const relativeStart = start - this._currentBufferOffset
                      const chunk = this._currentBuffer.subarray(relativeStart, relativeStart + length)
                      this.sender.feed_file(chunk)
                      
                      this.senderBytesSent = start + length
                      this.logSenderProgress()

                      const outgoing = this.sender.drain_outgoing()
                      if (outgoing && outgoing.length > 0) {
                          outgoingChunks.push(outgoing)
                          totalOutgoingSize += outgoing.length
                          
                          if (totalOutgoingSize > FLUSH_THRESHOLD) {
                              flushOutgoing()
                          }
                      }
                      
                      continue
                  }

                  // 3. Try next buffer (swap buffers - synchronous if already loaded)
                  if (this._nextBuffer && 
                      start >= this._nextBufferOffset && 
                      (start + length) <= (this._nextBufferOffset + this._nextBuffer.byteLength)) {
                      
                      // Swap buffers
                      this._currentBuffer = this._nextBuffer
                      this._currentBufferOffset = this._nextBufferOffset
                      this._nextBuffer = null
                      
                      // Start preloading next chunk
                      this.preloadNextBuffer(this._currentBufferOffset + this._currentBuffer.length)
                      
                      // Now serve from current buffer
                      const relativeStart = start - this._currentBufferOffset
                      const chunk = this._currentBuffer.subarray(relativeStart, relativeStart + length)
                      this.sender.feed_file(chunk)
                      
                      this.senderBytesSent = start + length
                      this.logSenderProgress()

                      const outgoing = this.sender.drain_outgoing()
                      if (outgoing && outgoing.length > 0) {
                          outgoingChunks.push(outgoing)
                          totalOutgoingSize += outgoing.length
                          
                          if (totalOutgoingSize > FLUSH_THRESHOLD) {
                              flushOutgoing()
                          }
                      }
                      
                      continue
                  }

                  // 4. Data not in any buffer - need to load synchronously
                  // This should rarely happen with proper preloading
                  if (this.sendingFile && !this._reading) {
                      flushOutgoing()
                      this._reading = true
                      this.loadBufferAndFeed(start, length)
                      break
                  } else if (this._reading) {
                      break
                  }
              } else if (e.type === 'file_complete') {
                  this.term?.writeln('\r\nZMODEM: File sent.')
                  this.sender.finish_session()
              } else if (e.type === 'session_complete') {
                  this.term?.writeln('\r\nZMODEM: Session complete.')
                  this.sender = null
                  this.sendingFile = null
                  this._currentBuffer = null
                  this._nextBuffer = null
                  this._preloadedFile = null
                  this._preloadedFileSize = 0
                  flushOutgoing()
                  return true
              }
          }
      } catch (e) {
          console.error('Pump Sender Error:', e)
          this.term?.writeln('\r\nZMODEM Pump Error: ' + e)
          this.sender = null
          this._preloadedFile = null
      }
      
      flushOutgoing()
      
      if (needFileDataCount > 0) {
          console.log(`[DEBUG] pumpSender done: ${needFileDataCount} need_file_data events, ${totalDataSent} bytes total`)
      }
      
      return didWork
  }

  async loadBufferAndFeed(offset: number, length: number) {
      if (!this.sender || !this.sendingFile) {
          this._reading = false
          return
      }
      try {
          // Read a larger chunk
          const readSize = Math.max(length, this.BUFFER_SIZE)
          const end = Math.min(offset + readSize, this.sendingFile.size)
          const slice = this.sendingFile.slice(offset, end)

          const buffer = await slice.arrayBuffer()
          if (!this.sender) return
          const u8 = new Uint8Array(buffer)

          // Update current buffer
          this._currentBuffer = u8
          this._currentBufferOffset = offset

          // Feed the requested part
          const feedLen = Math.min(length, u8.length)
          const chunk = u8.subarray(0, feedLen)
          
          this.sender.feed_file(chunk)
          
          this.senderBytesSent = offset + feedLen
          this.logSenderProgress()
          
          // Start preloading next buffer
          this.preloadNextBuffer(offset + u8.length)
          
          // Unlock
          this._reading = false
          
          this.pumpSender()
      } catch (e) {
          console.error('Buffer read error', e)
          this._reading = false
          try { this.pumpSender() } catch (_) {}
      }
  }

  logSenderProgress() {
      if (!this.sendingFile || !this.term) return
      
      const now = Date.now()
      
      // Only log every 500ms to reduce overhead
      if (now - this.senderLastLogTime < 500 && this.senderBytesSent < this.sendingFile.size) {
          return
      }
      
      const percent = ((this.senderBytesSent / this.sendingFile.size) * 100).toFixed(2)
      const elapsed = (now - this.senderStartTime) / 1000
      const speed = elapsed > 0 ? (this.senderBytesSent / elapsed / 1024 / 1024).toFixed(2) : '0.00'
      
      this.term.writeln(`\r[ZMODEM Send] Progress: ${percent}% | Speed: ${speed} MB/s | Sent: ${this.senderBytesSent}/${this.sendingFile.size} bytes`)
      this.senderLastLogTime = now
  }

  logReceiverProgress() {
      if (!this.currentFile || !this.term) return
      
      const now = Date.now()
      
      // Only log every 500ms to reduce overhead
      if (now - this.receiverLastLogTime < 500 && this.receiverBytesReceived < this.currentFile.size) {
          return
      }
      
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
            didWork = true
            
            if (e.type === 'file_start') {
                this.term?.writeln(`\r\nZMODEM: Receiving ${e.name} (${e.size} bytes)...`)
                this.currentFile = { name: e.name, size: e.size, data: [] }
                this.receiverStartTime = Date.now()
                this.receiverBytesReceived = 0
                this.receiverLastLogTime = 0
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
