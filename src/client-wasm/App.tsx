import React, { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import AddonZmodemWasm from './zmodem/addon-wasm'

const App: React.FC = () => {
  const terminalRef = useRef<HTMLDivElement | null>(null)
  const terminal = useRef<Terminal | null>(null)
  const ws = useRef<WebSocket | null>(null)
  const zmodemAddon = useRef<AddonZmodemWasm | null>(null)

  useEffect(() => {
    if (terminalRef.current == null) return

    const term = new Terminal()
    terminal.current = term

    term.loadAddon(new WebLinksAddon())

    const addon = new AddonZmodemWasm()
    zmodemAddon.current = addon
    term.loadAddon(addon as any)

    term.open(terminalRef.current)

    // Using same port as original demo server, assuming it serves both
    // Or we might need to change port if user runs a different server?
    // Original demo uses localhost:8081/terminal
    const websocket = new WebSocket('ws://localhost:8081/terminal')
    ws.current = websocket

    websocket.binaryType = 'arraybuffer'

    websocket.onopen = () => {
      console.log('WebSocket connected')
      term.writeln('Connected to server (WASM Client)')
    }

    websocket.onmessage = (event) => {
      if (typeof event.data === 'string') {
        term.write(event.data)
      } else {
        // Binary data usually means ZMODEM or just binary output
        // Pass to addon to check/handle
        addon.consume(event.data)
      }
    }

    websocket.onclose = (event) => {
      console.log('WebSocket closed:', event.code, event.reason)
      term.writeln(`\r\nConnection closed: ${event.code} ${event.reason}`)
    }

    websocket.onerror = (error) => {
      console.error('WebSocket error:', error)
      term.writeln('\r\nWebSocket error occurred')
    }

    term.onData((data) => {
      // If ZMODEM session is active, maybe we should block input?
      // For now, just send it.
      if (websocket.readyState === WebSocket.OPEN) {
        websocket.send(data)
      }
    })

    addon.zmodemAttach({
      socket: websocket,
      term,
      onDetect: (type) => {
          if (type === 'send') {
              handleSendFile(addon)
          }
      }
    })

    return () => {
      websocket.close()
      term.dispose()
    }
  }, [])

  const handleSendFile = async (addon: AddonZmodemWasm) => {
      try {
          // Use modern File System Access API if available
          if ('showOpenFilePicker' in window) {
              const picks = await (window as any).showOpenFilePicker()
              if (picks && picks.length > 0) {
                  const file = await picks[0].getFile()
                  addon.sendFile(file)
              } else {
                  // User cancelled
              }
          } else {
              // Fallback to hidden input
              const input = document.createElement('input')
              input.type = 'file'
              input.style.display = 'none'
              input.onchange = (e) => {
                  const files = (e.target as HTMLInputElement).files
                  if (files && files.length > 0) {
                      addon.sendFile(files[0])
                  }
              }
              document.body.appendChild(input)
              input.click()
              document.body.removeChild(input)
          }
      } catch (e) {
          console.error('File selection failed', e)
          terminal.current?.writeln('\r\nFile selection cancelled or failed.')
      }
  }

  return (
    <div style={{ width: '100vw', height: '100vh', backgroundColor: '#000' }}>
      <div ref={terminalRef} style={{ width: '100%', height: '100%' }} />
    </div>
  )
}

export default App
