import * as Y from '@y/y'
import * as encoding from 'lib0/encoding'
import * as awarenessProtocol from '@y/protocols/awareness'
import * as logging from 'lib0/logging'

const log = logging.createModuleLogger('@y/hub/protocol')

export const messageSync = 0
export const messageAwareness = 1
export const messageAuth = 2
export const messageQueryAwareness = 3

export const messageSyncStep1 = 0
export const messageSyncStep2 = 1
export const messageSyncUpdate = 2

/**
 * @param {Array<Uint8Array>} ms
 */
export const mergeAwarenessUpdates = ms => {
  const aw = new awarenessProtocol.Awareness(new Y.Doc())
  ms.forEach(m => {
    awarenessProtocol.applyAwarenessUpdate(aw, m, null)
  })
  return aw
}

/**
 * @param {Uint8Array} sv
 */
export const encodeSyncStep1 = sv => encoding.encode(encoder => {
  encoding.writeVarUint(encoder, messageSync)
  encoding.writeVarUint(encoder, messageSyncStep1)
  encoding.writeVarUint8Array(encoder, sv)
})

/**
 * @param {Uint8Array} diff
 */
export const encodeSyncStep2 = diff => encoding.encode(encoder => {
  encoding.writeVarUint(encoder, messageSync)
  encoding.writeVarUint(encoder, messageSyncStep2)
  encoding.writeVarUint8Array(encoder, diff)
})

/**
 * @param {encoding.Encoder} encoder
 * @param {Uint8Array} update
 */
export const writeSyncUpdate = (encoder, update) => {
  encoding.writeVarUint(encoder, messageSync)
  encoding.writeVarUint(encoder, messageSyncUpdate)
  encoding.writeVarUint8Array(encoder, update)
}

/**
 * @param {Uint8Array} update
 */
export const encodeSyncUpdate = update => encoding.encode(encoder => writeSyncUpdate(encoder, update))

/**
 * @param {encoding.Encoder} encoder
 * @param {Uint8Array} awUpdate
 */
export const writeAwarenessUpdate = (encoder, awUpdate) => {
  encoding.writeVarUint(encoder, messageAwareness)
  encoding.writeVarUint8Array(encoder, awUpdate)
}

/**
 * @param {awarenessProtocol.Awareness} awareness
 * @param {Array<number>} clients
 */
export const encodeAwareness = (awareness, clients) => encoding.encode(encoder => {
  writeAwarenessUpdate(encoder, awarenessProtocol.encodeAwarenessUpdate(awareness, clients))
})

/**
 * @param {number} clientid
 * @param {number} lastClock
 */
export const encodeAwarenessUserDisconnected = (clientid, lastClock) =>
  encoding.encode(encoder => {
    encoding.writeVarUint(encoder, 1) // one change
    encoding.writeVarUint(encoder, clientid)
    encoding.writeVarUint(encoder, lastClock + 1)
    encoding.writeVarString(encoder, JSON.stringify(null))
  })
