import * as Y from '@y/y'
import postgres from 'postgres'
import * as buffer from 'lib0/buffer'
import * as promise from 'lib0/promise'
import * as map from 'lib0/map'
import * as set from 'lib0/set'
import * as number from 'lib0/number'
import * as array from 'lib0/array'
import * as object from 'lib0/object'
// eslint-disable-next-line
import * as s from 'lib0/schema'
// eslint-disable-next-line
import * as t from './types.js'

/**
 * @param {string} postgresUrl - postgres://username:password@host:port/database
 * @param {t.PersistencePlugin[]} plugins
 */
export const createPersistence = async (postgresUrl, plugins) => {
  // If a specific database is requested, ensure it exists
  const sql = postgres(postgresUrl, { connect_timeout: 60 })
  try {
    await sql`SELECT 1 as connected`
  } catch (err) {
    throw new Error(`Can't connect to postgres. url: ${postgresUrl}.\n${err}`)
  }
  return new Persistence(sql, plugins)
}

/**
 * @template {t.Asset} ASSET
 * @param {t.PersistencePlugin[]} plugins
 * @param {t.AssetId} assetId
 * @param {ASSET} asset
 * @return {Promise<ASSET | t.RetrievableAsset>}
 */
const tryPersistencePluginStore = async (plugins, assetId, asset) => {
  for (const plugin of plugins) {
    if (plugin.store != null) {
      const r = await plugin.store(assetId, asset)
      if (r != null) return r
    }
  }
  return asset
}

/**
 * @template {t.Asset} ASSET
 * @param {t.PersistencePlugin[]} plugins
 * @param {t.AssetId} assetId
 * @param {ASSET} asset
 * @return {Promise<Exclude<ASSET,t.RetrievableAsset>>}
 */
const tryPersistencePluginRetrieve = async (plugins, assetId, asset) => {
  if (asset.type === 'asset:retrievable:v1') {
    for (const plugin of plugins) {
      if (plugin.retrieve != null) {
        const r = /** @type {Exclude<ASSET,t.RetrievableAsset>} */ (await plugin.retrieve(assetId, asset))
        if (r != null) return r
      }
    }
  }
  return /** @type {Exclude<ASSET,t.RetrievableAsset>} */ (asset)
}

/**
 * @param {t.PersistencePlugin[]} plugins
 * @param {t.AssetId} assetId
 * @param {t.Asset} asset
 */
const tryPersistencePluginDelete = (plugins, assetId, asset) => {
  if (asset.type === 'asset:retrievable:v1') {
    for (const plugin of plugins) {
      if (plugin.delete != null) {
        plugin.delete(assetId, asset)
      }
    }
  }
}

/**
 * A Persistence implementation that persists documents in PostgreSQL.
 */
export class Persistence {
  /**
   * @param {postgres.Sql} sql
   * @param {t.PersistencePlugin[]} plugins
   */
  constructor (sql, plugins) {
    this.sql = sql
    /**
     * @type {t.PersistencePlugin[]}
     */
    this.plugins = plugins
  }

  /**
   * @param {t.Room} room
   * @param {object} content
   * @param {string} content.lastClock
   * @param {Uint8Array<ArrayBuffer>} content.gcDoc
   * @param {Uint8Array<ArrayBuffer>} content.nongcDoc
   * @param {Uint8Array<ArrayBuffer>} content.contentmap
   * @param {Uint8Array<ArrayBuffer>} content.contentids
   * @returns {Promise<void>}
   */
  async store (room, { lastClock, gcDoc, nongcDoc, contentmap, contentids }) {
    /**
     * @type {t.AssetId}
     */
    const gcDocAssetId = object.assign({ type: /** @type {const} */ ('id:ydoc:v1'), gc: true, t: lastClock }, room)
    /**
     * @type {t.AssetId}
     */
    const nongcDocAssetId = object.assign({ type: /** @type {const} */ ('id:ydoc:v1'), gc: false, t: lastClock }, room)
    /**
     * @type {t.AssetId}
     */
    const contentmapAssetId = object.assign({ type: /** @type {const} */ ('id:contentmap:v1'), t: lastClock }, room)
    /**
     * @type {t.AssetId}
     */
    const contentidsAssetId = object.assign({ type: /** @type {const} */ ('id:contentids:v1'), t: lastClock }, room)
    const [gcDocAsset, nongcDocAsset, contentmapAsset, contentidsAsset] = await promise.all([
      tryPersistencePluginStore(this.plugins, gcDocAssetId, { type: 'asset:ydoc:v1', update: gcDoc }),
      tryPersistencePluginStore(this.plugins, nongcDocAssetId, { type: 'asset:ydoc:v1', update: nongcDoc }),
      tryPersistencePluginStore(this.plugins, contentmapAssetId, { type: 'asset:contentmap:v1', contentmap }),
      tryPersistencePluginStore(this.plugins, contentidsAssetId, { type: 'asset:contentids:v1', contentids })
    ])
    const encodedGcDocAsset = buffer.encodeAny(gcDocAsset)
    const encodedNongcDocAsset = buffer.encodeAny(nongcDocAsset)
    const encodedContentmapAsset = buffer.encodeAny(contentmapAsset)
    const encodedContentidsAsset = buffer.encodeAny(contentidsAsset)
    const created = number.parseInt(lastClock.split('-')[0])
    await this.sql`
      INSERT INTO yhub_ydoc_v1 (org,docid,branch,t,created,gcDoc,nongcDoc,contentmap,contentids)
      VALUES (${room.org},${room.docid},${room.branch},${lastClock},${created},${encodedGcDocAsset},${encodedNongcDocAsset},${encodedContentmapAsset},${encodedContentidsAsset})
    `
  }

  /**
   * @param {t.Room} room
   * @return {Promise<Y.ContentMap>}
   */
  async retrieveContentmap (room) {
    const { contentmap } = await this.retrieveDoc(room, { contentmap: true })
    return Y.mergeContentMaps(contentmap.map(Y.decodeContentMap))
  }

  /**
   * @template {{ gc?: boolean, nongc?: boolean, contentmap?: boolean, references?: boolean, contentids?: boolean }} Include
   * @param {t.Room} room
   * @param {Include} includeContent
   * @return {Promise<{ lastClock: string, gcDoc: Include['gc'] extends true ? Array<Uint8Array<ArrayBuffer>> : null, nongcDoc: Include['nongc'] extends true ? Array<Uint8Array<ArrayBuffer>> : null, contentmap: Include['contentmap'] extends true ? Array<Uint8Array<ArrayBuffer>> : null, references: Include['references'] extends true ? Array<{ assetId: t.AssetId, asset: t.Asset }> : null, contentids: Include['contentids'] extends true ? Array<Uint8Array<ArrayBuffer>> : null }>}
   */
  async retrieveDoc (room, includeContent) {
    const includeContentmap = includeContent.contentmap === true
    const includeContentids = includeContent.contentids === true
    const includeGc = includeContent.gc === true
    const includeNongc = includeContent.nongc === true
    const includeReferences = includeContent.references === true
    /**
     * @type {Array<{ t: string, gcdoc?: Buffer, nongcdoc?: Buffer, contentmap?: Buffer, contentids?: Buffer }>}
     */
    const rows = await this.sql`
      SELECT 
        t
        ${includeGc ? this.sql`, gcDoc` : this.sql``}
        ${includeNongc ? this.sql`, nongcDoc` : this.sql``}
        ${includeContentmap ? this.sql`, contentmap` : this.sql``}
        ${includeContentids ? this.sql`, contentids` : this.sql``}
      FROM yhub_ydoc_v1 
      WHERE org = ${room.org} AND docid = ${room.docid} AND branch = ${room.branch}
    `
    /**
     * @type {Include['references'] extends true ? Array<{ assetId: t.AssetId, asset: t.Asset }> : null}
     */
    const references = includeReferences ? /** @type {any} */ ([]) : null
    const contentmapAssets = await promise.all(rows.filter(row => row.contentmap != null).map(row => {
      const assetId = object.assign({ type: /** @type {const} */ ('id:contentmap:v1'), t: row.t }, room)
      const contentmapAsset = /** @type {s.Unwrap<typeof t.$contentMapAsset> | t.RetrievableAsset} */ (buffer.decodeAny(/** @type {Buffer} */ (row.contentmap)))
      references?.push({ assetId, asset: contentmapAsset })
      return tryPersistencePluginRetrieve(this.plugins, assetId, contentmapAsset)
    }))
    const contentidsAssets = await promise.all(rows.filter(row => row.contentids != null).map(row => {
      const assetId = object.assign({ type: /** @type {const} */ ('id:contentids:v1'), t: row.t }, room)
      const contentidsAsset = /** @type {s.Unwrap<typeof t.$contentidsAsset> | t.RetrievableAsset} */ (buffer.decodeAny(/** @type {Buffer} */ (row.contentids)))
      references?.push({ assetId, asset: contentidsAsset })
      return tryPersistencePluginRetrieve(this.plugins, assetId, contentidsAsset)
    }))
    const gcUpdates = await promise.all(rows.filter(row => row.gcdoc != null).map(row => {
      const assetId = object.assign({ type: /** @type {const} */ ('id:ydoc:v1'), t: row.t, gc: true }, room)
      const gcDocAsset = /** @type {s.Unwrap<typeof t.$ydocAsset> | t.RetrievableAsset} */ (buffer.decodeAny(/** @type {Buffer} */ (row.gcdoc)))
      references?.push({ assetId, asset: gcDocAsset })
      return tryPersistencePluginRetrieve(this.plugins, assetId, gcDocAsset)
    }))
    const nongcUpdates = await promise.all(rows.filter(row => row.nongcdoc != null).map(row => {
      const assetId = object.assign({ type: /** @type {const} */ ('id:ydoc:v1'), t: row.t, gc: false }, room)
      const nongcDocAsset = /** @type {s.Unwrap<typeof t.$ydocAsset> | t.RetrievableAsset} */ (buffer.decodeAny(/** @type {Buffer} */ (row.nongcdoc)))
      references?.push({ assetId, asset: nongcDocAsset })
      return tryPersistencePluginRetrieve(this.plugins, assetId, nongcDocAsset)
    }))
    return {
      lastClock: array.last(rows)?.t || '0',
      gcDoc: /** @type {Include['gc'] extends true ? Array<Uint8Array<ArrayBuffer>> : null} */ (includeGc ? gcUpdates.map(asset => asset.update) : null),
      nongcDoc: /** @type {Include['nongc'] extends true ? Array<Uint8Array<ArrayBuffer>> : null} */ (includeNongc ? nongcUpdates.map(asset => asset.update) : null),
      contentmap: /** @type {Include['contentmap'] extends true ? Array<Uint8Array<ArrayBuffer>> : null} */ (includeContentmap ? contentmapAssets.map(asset => asset.contentmap) : null),
      contentids: /** @type {Include['contentids'] extends true ? Array<Uint8Array<ArrayBuffer>> : null} */ (includeContentids ? contentidsAssets.map(asset => asset.contentids) : null),
      references
    }
  }

  /**
   * @param {Array<{ assetId: t.AssetId, asset: t.Asset }>} references
   * @return {Promise<void>}
   */
  async deleteReferences (references) {
    references.forEach(ref => tryPersistencePluginDelete(this.plugins, ref.assetId, ref.asset))
    /**
     * org, docid, branch, t[]
     * @type {Map<string,Map<string,Map<string,Set<string>>>>}
     */
    const roomsMap = new Map()
    /**
     * @type {Array<{ org: string, docid: string, branch: string, ts: string[] }>}
     */
    const deleteQuery = []
    references.forEach(ref => {
      map.setIfUndefined(map.setIfUndefined(map.setIfUndefined(roomsMap, ref.assetId.org, map.create), ref.assetId.docid, map.create), ref.assetId.branch, set.create).add(ref.assetId.t)
    })
    roomsMap.forEach((docs, org) => {
      docs.forEach((branches, docid) => {
        branches.forEach((ts, branch) => {
          deleteQuery.push({ org, docid, branch, ts: Array.from(ts) })
        })
      })
    })
    await promise.all(deleteQuery.map(dq => this.sql`
      DELETE FROM yhub_ydoc_v1 WHERE org = ${dq.org} AND docid = ${dq.docid} AND branch = ${dq.branch} AND t = ANY(${dq.ts})
    `))
  }

  async destroy () {
    await this.sql.end({ timeout: 5 }) // existing queries have five seconds to finish
  }
}
