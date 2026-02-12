import React, { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import AddonZmodem from './zmodem/addon'
import { createOfferHandler } from './zmodem/offer'
import { sendFiles } from './zmodem/send'

const App: React.FC = () => {
  const terminalRef = useRef<HTMLDivElement | null>(null)
  const terminal = useRef<Terminal | null>(null)
  const ws = useRef<WebSocket | null>(null)
  const zmodemAddon = useRef<AddonZmodem | null>(null)

  const sendLog = (msg: string) => {
    // write locally to terminal so user sees progress immediately
    (terminal.current != null) && (terminal.current as any).writeln && (terminal.current as any).writeln(`[zmodem] ${msg}`)

    if ((ws.current != null) && ws.current.readyState === WebSocket.OPEN) {
      ws.current.send(JSON.stringify({ type: 'log', message: msg }))
    }
  }

  useEffect(() => {
    if (terminalRef.current == null) return

    const term = new Terminal()
    terminal.current = term

    term.loadAddon(new WebLinksAddon())

    const addon = new AddonZmodem()
    zmodemAddon.current = addon
    term.loadAddon(addon as any)

    term.open(terminalRef.current)

    const websocket = new WebSocket('ws://localhost:8081/terminal')
    ws.current = websocket

    websocket.onopen = () => {
      console.log('WebSocket connected')
      term.writeln('Connected to server')
    }

    websocket.onmessage = (event) => {
      if (typeof event.data === 'string') {
        // text messages include server/log messages and normal shell output
        term.write(event.data)
      } else {
        console.log('WebSocket message received (binary)')
        addon.zsentry?.consume(event.data)
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

    // We rely on zmodem-ts to detect rz/sz and provide offer metadata.
    // Just forward terminal input to the backend; zmodem handlers will
    // prompt file pickers / saves when appropriate via offers.
    term.onData((data) => {
      websocket.send(data)
    })

    addon.zmodemAttach({
      socket: websocket,
      term,
      onZmodem: true,
      onzmodemRetract: () => {
        console.log('zmodem retract')
        sendLog('zmodem retract')
      },
      onZmodemDetect: (detection: any) => {
        console.log('zmodem detect', detection)
        // Avoid dumping the full detection object to the terminal; log only session type
        const detType = (detection && (detection._session_type || detection.type || (detection.sess && detection.sess.type))) || 'unknown'
        sendLog(`zmodem detect: ${detType}`)
        const zsession = detection.confirm()
        if (zsession && zsession.type === 'receive') {
          // remote will send files to us; offer handler will prompt save
          zsession.on('offer', createOfferHandler({ current: null }, sendLog, () => (zmodemAddon.current != null) && (zmodemAddon.current as any).resetSentry && (zmodemAddon.current as any).resetSentry()))
          // start the receive session (do not await) - offer handler manages each file
          zsession.start()
        } else if (zsession) {
          // we should send files to remote; sendFiles will prompt picker
          ;(async () => {
            await sendFiles(zsession, { current: null }, sendLog)
          })()
        }
      },
      onOffer: createOfferHandler({ current: null }, sendLog, () => (zmodemAddon.current != null) && (zmodemAddon.current as any).resetSentry && (zmodemAddon.current as any).resetSentry())
    })

    return () => {
      websocket.close()
      term.dispose()
      addon.dispose()
    }
  }, [])

  return (
    <div>
      <h1>Zmodem Terminal</h1>
      <div ref={terminalRef} style={{ width: '100%', height: '400px' }} />
    </div>
  )
}

export default App
