import * as Y from '@y/y'
import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'
import express from 'express'
import formidable from 'formidable'
import { JSONFilePreset } from 'lowdb/node'
import * as jwt from 'lib0/crypto/jwt'
import * as time from 'lib0/time'
import * as ecdsa from 'lib0/crypto/ecdsa'
import * as env from 'lib0/environment'
import * as fs from 'fs/promises'
import * as promise from 'lib0/promise'

/** @type {{docs: {id: string, title: string, updated: string, created: string}[]}} */
const defaultData = { docs: [] }
const db = await JSONFilePreset('db.json', defaultData)
await db.read()
await db.write()

const app = express()
const port = 5173

// serve static files
app.use(express.static('./'))
app.use(express.json())

// Read the AUTH_PRIVATE_KEY environment variable and import the JWK
export const authPrivateKey = await ecdsa.importKeyJwk(
  JSON.parse(env.ensureConf('auth-private-key'))
)
// Read the AUTH_PUBLIC_KEY environment variable and import the JWK
export const authPublicKey = await ecdsa.importKeyJwk(
  JSON.parse(env.ensureConf('auth-public-key'))
)

const appName = 'my-express-app'

// This endpoint is called in regular intervals when the document changes.
// The request contains a multi-part formdata field that can be read, for example, with formidable:
app.put('/ydoc/:room', async (req, res, next) => {
  const room = req.params.room
  const timestamp = new Date().toISOString()

  const ydocUpdate = await promise.create((resolve, reject) => {
    const form = formidable({})
    form.parse(req, (err, _fields, files) => {
      if (err) {
        next(err)
        reject(err)
        return
      }
      if (files.ydoc) {
        // formidable writes the data to a file by default. This might be a good idea for your
        // application. Check the documentation to find a non-temporary location for the read file.
        // You should probably delete it if it is no longer being used.
        const file = files.ydoc[0]
        // we are just going to log the content and delete the temporary file
        fs.readFile(file.filepath).then(resolve, reject)
      }
    })
  })
  const ydoc = new Y.Doc()
  Y.applyUpdateV2(ydoc, ydocUpdate)
  console.log(
    `BlockSuite doc in room "${room}" updated, block count: ${ydoc.getMap('blocks').size}`
  )

  await db.read()
  const docIndex = db.data.docs.findIndex((doc) => doc.id === room)
  if (docIndex !== -1) {
    db.data.docs[docIndex].updated = timestamp
    await db.write()
  }

  res.sendStatus(200)
})

// This example server always grants read-write permission to all requests.
// Modify it to your own needs or implement the same API in your own backend!
app.get('/auth/token', async (_req, res) => {
  const token = await jwt.encodeJwt(authPrivateKey, {
    iss: appName,
    exp: time.getUnixTime() + 1000 * 60 * 60, // token expires in an hour
    yuserid: 'user1' // associate the client with a unique id that can will be used to check permissions
  })
  res.send(token)
})

// This api is called to check whether a specific user (identified by the unique "yuserid") has
// access to a specific room. This rest endpoint is called by the yredis server, not the client.
app.get('/auth/perm/:room/:userid', async (req, res) => {
  const yroom = req.params.room
  const yuserid = req.params.userid
  // This sample-server always grants full acess
  res.send(
    JSON.stringify({
      yroom,
      yaccess: 'rw', // alternatively, specify "read-only" or "no-access"
      yuserid
    })
  )
})

app.get('/docs', async (req, res) => {
  await db.read()
  res.json(db.data.docs)
})

app.post('/docs', async (req, res) => {
  const timestamp = new Date().toISOString()
  const id = `${Date.now()}`
  const title = ''
  await db.read()
  db.data.docs.push({ id, title, created: timestamp, updated: timestamp })
  await db.write()

  res.status(201).json({ id, title })
})

app.delete('/docs/:id', async (req, res) => {
  const docId = req.params.id
  await db.read()
  db.data.docs = db.data.docs.filter(({ id }) => id !== docId)
  await db.write()

  res.send('Document removed')
})

app.patch('/docs/:id/title', async (req, res) => {
  const { id } = req.params
  const { title } = req.body

  if (typeof title !== 'string') return res.status(400).send('Missing title')

  await db.read()
  const doc = db.data.docs.find(doc => doc.id === id)
  if (doc) {
    doc.title = title
    doc.updated = new Date().toISOString()
    await db.write()
    res.status(200).json({ id: doc.id, title: doc.title })
  } else {
    res.status(404).send('Document not found')
  }
})

app.get('*', (req, res) => {
  const __filename = fileURLToPath(import.meta.url)
  const __dirname = dirname(__filename)
  res.sendFile(resolve(__dirname, 'index.html'))
})

const server = app.listen(port, () => {
  console.log(`Express Demo BlockSuite server listening on port ${port}`)
})

// Gracefully shut down the server when running in Docker
process.on('SIGTERM', shutDown)
process.on('SIGINT', shutDown)

function shutDown () {
  console.log('Received SIGTERM/SIGINT - shutting down gracefully')
  server.close(() => {
    console.log('Closed out remaining connections - shutting down')
    process.exit(0)
  })
  setTimeout(() => {
    console.error("Couldn't close connections - forcefully shutting down")
    process.exit(1)
  }, 10000)
}
