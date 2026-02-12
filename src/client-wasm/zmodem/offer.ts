export function createOfferHandler (pendingSaveRef: { current: any }, sendLog: (msg: string) => void, onCompleteReset?: () => void) {
  return async function onOffer (xfer: any) {
    console.log('zmodem offer received', xfer)
    // Prefer the details provided by the Offer interface
    const details = (typeof xfer.get_details === 'function') ? xfer.get_details() : (xfer.file_info || {})
    const offeredName = details && details.name ? details.name : (xfer.name || xfer.file_name || 'download.bin')
    const offeredSize = details && details.size ? details.size : null

    sendLog(`zmodem offer: ${offeredName}${offeredSize ? ` (${offeredSize} bytes)` : ''}`)

    let writable: any = null
    let chunks: Uint8Array[] = []
    let saveDesc = ''

    if ((pendingSaveRef as any).current) {
      const p = (pendingSaveRef as any).current
      writable = p.writable || null
      if (p.chunks) chunks = p.chunks
      saveDesc = p.name || offeredName;
      (pendingSaveRef as any).current = null
    } else {
      const useFileSystem = typeof (window as any).showSaveFilePicker === 'function'
      if (useFileSystem) {
        try {
          const handle = await (window as any).showSaveFilePicker({ suggestedName: offeredName })
          writable = await handle.createWritable()
          saveDesc = `File picker (name: ${offeredName})`
        } catch (err) {
          console.error('Save file picker cancelled', err)
          sendLog('Save file picker cancelled')
          xfer.reject && xfer.reject()
          return
        }
      } else {
        saveDesc = `Browser download (name: ${offeredName})`
      }
    }

    sendLog(`Receiving ${offeredName}... saving to: ${saveDesc}`)

    xfer.on && xfer.on('input', async (payload: Uint8Array) => {
      try {
        if (writable) {
          await writable.write(new Uint8Array(payload))
        } else {
          chunks.push(new Uint8Array(payload))
        }
      } catch (e) {
        console.error('Error writing chunk', e)
        sendLog(`Error writing chunk: ${e}`)
      }
    })

    try {
      // Accept will resolve when the transfer completes (and returns spooled data if used)
      const result = await xfer.accept()

      if (writable) {
        try { await writable.close() } catch (e) { console.warn('close writable failed', e) }
        sendLog(`File received: ${offeredName} -> ${saveDesc}`)
      } else {
        const blob = new Blob(chunks)
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = offeredName
        document.body.appendChild(a)
        a.click()
        a.remove()
        URL.revokeObjectURL(url)
        sendLog(`File received: ${offeredName} -> downloaded as ${offeredName}`)
      }

      console.log('zmodem transfer finished', offeredName, result)
      sendLog(`zmodem transfer finished: ${offeredName}`)

      // Give sentry a moment to process any trailing protocol bytes,
      // then optionally reset it to recover from protocol edge-cases
      // (OSC sequences arriving right after ZFIN can leave sentry in
      // a state where it expects OO; rebuilding the sentry returns
      // the terminal to normal operation).
      try {
        if (onCompleteReset != null) {
          setTimeout(() => {
            try { onCompleteReset() } catch (e) { console.error('onCompleteReset failed', e) }
          }, 50)
        }
      } catch (e) {}
    } catch (err) {
      console.error('zmodem accept failed', err)
      sendLog(`zmodem accept failed: ${err}`)
    }
  }
}
