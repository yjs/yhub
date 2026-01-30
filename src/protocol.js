import * as Y from '@y/y'
import * as error from 'lib0/error'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import * as array from 'lib0/array'
import * as awarenessProtocol from '@y/protocols/awareness'
import * as buffer from 'lib0/buffer'
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
 * @todo this should emit a single message
 *
 * Merge messages for easier comsumption by the client.
 *
 * This is useful, for example, when the server catches messages from a pubsub / stream.
 * Before the server sends the messages to the clients, we can merge updates, and filter out older
 * awareness messages.
 *
 * @param {Array<Uint8Array<ArrayBuffer>>} messages
 */
export const mergeMessages = messages => {
  return messages
  // @todo the below doesn't work anymore. Probably need to parse messages before merging them
  if (messages.length < 2) {
    return messages
  }
  const aw = new awarenessProtocol.Awareness(new Y.Doc())
  /**
   * @type {Array<Uint8Array<ArrayBuffer>>}
   */
  const updates = []
  messages.forEach(m => {
    const decoder = decoding.createDecoder(m)
    try {
      const messageType = decoding.readUint8(decoder)
      switch (messageType) {
        case messageSync: {
          const syncType = decoding.readUint8(decoder)
          if (syncType === messageSyncUpdate) {
            updates.push(decoding.readVarUint8Array(decoder))
          } else {
            error.unexpectedCase()
          }
          break
        }
        case messageAwareness: {
          awarenessProtocol.applyAwarenessUpdate(aw, decoding.readVarUint8Array(decoder), null)
          break
        }
        default: {
          error.unexpectedCase()
        }
      }
    } catch (e) {
      log(logging.RED, 'Error parsing message', buffer.toBase64(m), e)
    }
  })
  /**
   * @type {Array<Uint8Array>}
   */
  const result = []
  updates.length > 0 && result.push(encoding.encode(encoder => {
    encoding.writeVarUint(encoder, messageSync)
    encoding.writeVarUint(encoder, messageSyncUpdate) // update
    encoding.writeVarUint8Array(encoder, Y.mergeUpdates(updates))
  }))
  aw.states.size > 0 && result.push(encoding.encode(encoder => {
    encoding.writeVarUint(encoder, messageAwareness)
    encoding.writeVarUint8Array(
      encoder,
      awarenessProtocol.encodeAwarenessUpdate(
        aw,
        array.from(aw.getStates().keys())
      )
    )
  }))
  return result
}

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
