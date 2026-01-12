import * as uws from 'uws'
import * as jwt from 'lib0/crypto/jwt'
import * as ecdsa from 'lib0/crypto/ecdsa'
import * as json from 'lib0/json'
import * as time from 'lib0/time'
import * as env from 'lib0/environment'
import * as logging from 'lib0/logging'
import * as error from 'lib0/error'
import * as promise from 'lib0/promise'
import * as encoding from 'lib0/encoding'
import * as Y from '@y/y'

const appName = 'Auth-Server-Example'
const authPrivateKey = await ecdsa.importKeyJwk(json.parse(env.ensureConf('auth-private-key')))
const port = 5173

const app = uws.App({})

app.put('/ydoc/:room', async (res, req) => {
  let aborted = false
  res.onAborted(() => {
    aborted = true
  })
  const room = req.getParameter(0)
  const header = req.getHeader('content-type')
  // this "encoder" will accumulate the received data until all data arrived
  const contentEncoder = encoding.createEncoder()
  res.onData((chunk, isLast) => {
    encoding.writeUint8Array(contentEncoder, new Uint8Array(chunk))
    if (isLast && !aborted) {
      const fullContent = encoding.toUint8Array(contentEncoder)
      const parts = uws.getParts(fullContent, header)
      const ydocUpdateData = parts?.find(part => part.name === 'ydoc')?.data
      if (ydocUpdateData == null) {
        console.error('Received empty data')
        return
      }
      const ydocUpdate = new Uint8Array(ydocUpdateData)
      const ydoc = new Y.Doc()
      Y.applyUpdateV2(ydoc, ydocUpdate)
      console.log(`Ydoc in room "${room}" updated. New codemirror content: "${ydoc.get('codemirror').toString()}"`)
      res.endWithoutBody()
    }
  })
})

// This example server always grants read-write permission to all requests.
// Modify it to your own needs or implement the same API in your own backend!
app.get('/auth/token', async (res, _req) => {
  let aborted = false
  res.onAborted(() => {
    aborted = true
  })
  const token = await jwt.encodeJwt(authPrivateKey, {
    iss: appName,
    exp: time.getUnixTime() + 60 * 60 * 1000, // token expires in one hour
    yuserid: 'user1'
  })
  if (aborted) return
  res.cork(() => {
    res.end(token)
  })
})

app.get('/auth/perm/:room/:userid', async (res, req) => {
  const yroom = req.getParameter(0)
  const yuserid = req.getParameter(1)
  res.end(json.stringify({
    yroom,
    yaccess: 'rw',
    yuserid
  }))
})

/**
 * Resolves when the server started.
 */
export const authServerStarted = promise.create((resolve, reject) => {
  const server = app.listen(port, (token) => {
    if (token) {
      logging.print(logging.GREEN, `[${appName}] Listening to port ${port}`)
      resolve()
    } else {
      const err = error.create(`[${appName}] Failed to lisen to port ${port}`)
      reject(err)
      throw err
    }
  })

  // Gracefully shut down the server when running in Docker
  process.on('SIGTERM', shutDown)
  process.on('SIGINT', shutDown)

  function shutDown () {
    console.log('Received SIGTERM/SIGINT - shutting down')
    server.close()
    process.exit(0)
  }
})
