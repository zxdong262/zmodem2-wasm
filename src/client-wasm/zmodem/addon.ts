import Zmodem from 'zmodem-ts'
import type { Terminal } from '@xterm/xterm'

const {
  Sentry
} = Zmodem

export default class AddonZmodem {
  _disposables: any[] = []
  socket: WebSocket | null = null
  term: Terminal | null = null
  ctx: any = null
  zsentry: any = null

  activate (terminal: Terminal) {
    (terminal as any).zmodemAttach = this.zmodemAttach.bind(this)
  }

  sendWebSocket = (octets: number[]) => {
    if ((this.socket != null) && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(new Uint8Array(octets))
    } else {
      console.error('WebSocket is not open')
    }
  }

  zmodemAttach = (ctx: any) => {
    this.socket = ctx.socket
    this.term = ctx.term
    this.ctx = ctx
    this.createSentry()
    this.socket.binaryType = 'arraybuffer'

    // Offer events are emitted on the confirmed zsession; handlers should
    // attach to the `zsession` returned by detection.confirm(). Do not
    // attempt to call `.on('offer')` on the sentry object (it has no such API).
  }

  createSentry () {
    const ctx = this.ctx || {}
    this.zsentry = new Sentry({
      to_terminal: (octets: number[]) => {
        if (ctx.onZmodem) {
          try {
            (this.term != null) && this.term.write(String.fromCharCode.apply(String, octets as any))
          } catch (e) {
            console.error('to_terminal write failed', e)
          }
        }
      },
      sender: this.sendWebSocket,
      on_retract: ctx.onzmodemRetract,
      on_detect: ctx.onZmodemDetect
    })

    // Offer events are provided by the confirmed zsession returned from
    // `detection.confirm()`. Do not attempt to call `.on('offer')` on the
    // sentry itself — it does not expose that API.
  }

  // Recreate the internal zsentry to recover from protocol errors
  resetSentry () {
    try {
      if (this.zsentry && (this.zsentry).dispose) {
        try { (this.zsentry).dispose() } catch (e) {}
      }
    } catch (e) {}
    this.createSentry()
  }

  dispose () {
    this._disposables.forEach((d: any) => d.dispose && d.dispose())
    this._disposables = []
    this.socket = null
    this.term = null
    this.ctx = null
    this.zsentry = null
  }
}
