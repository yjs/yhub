import * as api from './api.js'
import * as map from 'lib0/map'
import * as array from 'lib0/array'

/**
 * @typedef {function(string,Array<Uint8Array>):void} SubHandler
 */

/**
 * @param {Subscriber} subscriber
 */
const run = async subscriber => {
  while (true) {
    try {
      const ms = await subscriber.client.getMessages(array.from(subscriber.subs.entries()).map(([stream, s]) => ({ key: stream, id: s.id })))
      for (let i = 0; i < ms.length; i++) {
        const m = ms[i]
        const sub = subscriber.subs.get(m.stream)
        if (sub == null) continue
        sub.id = m.lastId
        if (sub.nextId != null) {
          sub.id = sub.nextId
          sub.nextId = null
        }
        sub.fs.forEach(f => f(m.stream, m.messages))
      }
    } catch (e) {
      console.error(e)
    }
  }
}

/**
 * @param {import('./storage.js').Storage} store
 * @param {string} redisPrefix
 */
export const createSubscriber = async (store, redisPrefix) => {
  const client = await api.createApiClient(store, redisPrefix)
  return new Subscriber(client)
}

export class Subscriber {
  /**
   * @param {api.Api} client
   */
  constructor (client) {
    this.client = client
    /**
     * @type {Map<string,{fs:Set<SubHandler>,id:string,nextId:string?}>}
     */
    this.subs = new Map()
    run(this)
  }

  /**
   * @param {string} stream
   * @param {string} id
   */
  ensureSubId (stream, id) {
    const sub = this.subs.get(stream)
    if (sub != null && api.isSmallerRedisId(id, sub.id)) {
      sub.nextId = id
    }
  }

  /**
   * @param {string} stream
   * @param {SubHandler} f
   */
  subscribe (stream, f) {
    const sub = map.setIfUndefined(this.subs, stream, () => ({ fs: new Set(), id: '0', nextId: null }))
    sub.fs.add(f)
    return {
      redisId: sub.id
    }
  }

  /**
   * @param {string} stream
   * @param {SubHandler} f
   */
  unsubscribe (stream, f) {
    const sub = this.subs.get(stream)
    if (sub) {
      sub.fs.delete(f)
      if (sub.fs.size === 0) {
        this.subs.delete(stream)
      }
    }
  }

  destroy () {
    this.client.destroy()
  }
}
