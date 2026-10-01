import type { Server } from 'node:http'

/**
 * Binds the relay hook receiver to loopback and resolves with its bound port (null when the
 * address is not an IP socket). Startup errors reject; later server errors are only logged.
 */
export function listenOnLoopback(server: Server, port: number): Promise<number | null> {
  return new Promise<number | null>((resolve, reject) => {
    const onStartupError = (err: Error): void => {
      server.off('listening', onListening)
      reject(err)
    }
    const onListening = (): void => {
      server.off('error', onStartupError)
      server.on('error', (err) => {
        process.stderr.write(`[relay-hook-server] server error: ${err.message}\n`)
      })
      const address = server.address()
      resolve(address && typeof address === 'object' ? address.port : null)
    }
    server.once('error', onStartupError)
    // Why: loopback only — reachable by the in-box agent CLI (127.0.0.1), not from outside the box.
    server.listen(port, '127.0.0.1', onListening)
  })
}
