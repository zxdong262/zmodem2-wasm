import express from 'express'
import expressWs from 'express-ws'
import { Client } from 'ssh2'
import WebSocket from 'ws'
import fs from 'fs'
import dotenv from 'dotenv'

dotenv.config()

const app = express()
expressWs(app)

function getSshConfig() {
  const host = process.env.SSH_HOST || process.env.TEST_HOST || 'localhost'
  const port = parseInt(process.env.SSH_PORT || process.env.TEST_PORT || '22', 10)
  const user = process.env.SSH_USER || process.env.TEST_USER || 'root'
  const password = process.env.SSH_PASS || process.env.TEST_PASS
  const privateKeyPath = process.env.SSH_KEY_PATH || process.env.TEST_KEY_PATH

  const config: any = {
    host,
    port,
    username: user
  }

  if (privateKeyPath) {
    try {
      config.privateKey = fs.readFileSync(privateKeyPath)
    } catch (err) {
      console.error('Failed to read private key file:', err)
      throw new Error(`Cannot read private key from ${privateKeyPath}`)
    }
  } else if (password) {
    config.password = password
  } else {
    throw new Error('Either SSH_KEY_PATH or SSH_PASS must be provided')
  }

  return config
}

// Test SSH connection on startup
console.log('Testing SSH connection...')
const testSsh = new Client()
testSsh.on('ready', () => {
  console.log('SSH test connection successful')
  testSsh.end()
})
testSsh.on('error', (err: any) => {
  console.error('SSH test connection failed:', err)
})
testSsh.connect(getSshConfig())

app.ws('/terminal', (ws: WebSocket, req) => {
  console.log('WebSocket connection established from:', req.connection.remoteAddress)
  console.log('Upgrade request url:', req.url)
  console.log('Upgrade request headers:', JSON.stringify(req.headers))

  const ssh = new Client()

  ssh.on('ready', () => {
    console.log('SSH connection ready')
    ssh.shell({
      term: 'xterm-256color',
      cols: 80,
      rows: 24
    }, (err, stream) => {
      if (err) {
        console.error('SSH shell error:', err)
        ws.send(`SSH shell failed: ${err.message}`)
        ws.close(1011, 'SSH shell failed')
        ssh.end()
        return
      }

      console.log('SSH shell opened')

      ws.on('message', (data: Buffer) => {
        const msgStr = data.toString()
        try {
          const parsed = JSON.parse(msgStr)
          if (parsed.type === 'log') {
            // Log on server only. The frontend will write logs to the terminal locally
            console.log('CLIENT LOG:', parsed.message)
            return
          }
        } catch {}
        console.log('WebSocket message received, length:', data.length)
        // Send all data as binary to SSH stream
        stream.write(data)
      })

      stream.on('data', (data: Buffer) => {
        console.log('SSH data received, length:', data.length)
        ws.send(data)
      })

      stream.on('close', () => {
        console.log('SSH stream closed')
        ssh.end()
        ws.close()
      })

      stream.on('error', (err) => {
        console.error('SSH stream error:', err)
      })
    })
  })

  ssh.on('error', (err: any) => {
    console.error('SSH connection error:', err)
    ws.send(`SSH connection failed: ${err.message}`)
    ws.close(1011, 'SSH connection failed') // 1011 = Internal Error
  })

  ssh.connect(getSshConfig())

  ws.on('close', () => {
    console.log('WebSocket closed')
    ssh.end()
  })

  ws.on('error', (err) => {
    console.error('WebSocket error:', err)
  })
})

app.listen(8081, () => {
  console.log('Server running on port 8081')
})
