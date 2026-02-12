export async function sendFiles (zsession: any, pendingUploadRef: { current: any }, sendLog: (msg: string) => void) {
  // Confirm zsession if detection passed the raw detection here callers should pass confirmed session
  const filesToSend: File[] = []
  if (pendingUploadRef.current && pendingUploadRef.current.uploadFile) {
    filesToSend.push(pendingUploadRef.current.uploadFile)
    pendingUploadRef.current = null
  } else {
    try {
      const picks = await (window as any).showOpenFilePicker()
      for (const h of picks) {
        const f = await h.getFile()
        filesToSend.push(f)
      }
    } catch (e) {
      sendLog('Open file picker cancelled')
      return
    }
  }

  if (filesToSend.length === 0) return

  sendLog(`Starting zmodem send for ${filesToSend.length} file(s)`)

  let filesRemaining = filesToSend.length
  let sizeRemaining = filesToSend.reduce((a, b) => a + (b.size || 0), 0)

  const CHUNK = 64 * 1024 // 64KB chunks

  for (const file of filesToSend) {
    const offer = {
      obj: file,
      name: file.name,
      size: file.size,
      files_remaining: filesRemaining,
      bytes_remaining: sizeRemaining
    }

    let xfer: any
    try {
      sendLog(`Sending file: ${file.name} (${file.size} bytes)`)
      xfer = await zsession.send_offer(offer)
    } catch (err) {
      console.error('send_offer failed', err)
      sendLog(`send_offer failed: ${err}`)
      return
    }

    if (!xfer) {
      sendLog('Transfer cancelled or not available')
      return
    }

    // stream file by slicing
    let offset = 0
    while (offset < file.size) {
      const end = Math.min(offset + CHUNK, file.size)
      const slice = file.slice(offset, end)
      const buf = new Uint8Array(await slice.arrayBuffer())
      try {
        await xfer.send(buf)
      } catch (err) {
        console.error('xfer.send failed', err)
        sendLog(`xfer.send failed: ${err}`)
        try { await xfer.end() } catch (e) {}
        return
      }
      offset = end
    }

    try {
      await xfer.end()
    } catch (err) {
      console.error('xfer.end failed', err)
      sendLog(`xfer.end failed: ${err}`)
      return
    }

    filesRemaining -= 1
    sizeRemaining -= file.size || 0
    sendLog(`Finished sending ${file.name} (${file.size} bytes)`)
  }

  try {
    if (zsession && zsession.close) {
      await zsession.close().catch(() => {})
    }
  } catch (e) {}
}
