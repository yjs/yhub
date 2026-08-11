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
import { isSmallerRedisClock } from './stream.js'
import { logger } from './logger.js'

const log = logger.child({ module: 'persistence' })

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
 * INT8 columns are read back as strings.
 *
 * @param {{ org: string, docid: string, branch: string, deleted_at: string, hard: boolean, purged_at: string|null, by: string|null }} row
 * @return {t.Tombstone}
 */
const decodeTombstone = row => ({
  org: row.org,
  docid: row.docid,
  branch: row.branch,
  deletedAt: number.parseInt(row.deleted_at),
  hard: row.hard,
  purgedAt: row.purged_at == null ? null : number.parseInt(row.purged_at),
  by: row.by
})

/**
 * The four assets a version row holds: the column that stores each one, the `includeContent` flag
 * that asks for it, and how its `AssetId` is built. Having them in one table is what lets
 * `retrieveAssets` serve both the content path and the reference-only path without repeating
 * itself four times over.
 *
 * @type {Array<{ column: string, include: string, assetId: (room: t.Room, t: string) => t.AssetId }>}
 */
const assetColumns = [
  { column: 'gcdoc', include: 'gc', assetId: (room, t) => object.assign({ type: /** @type {const} */ ('id:ydoc:v1'), t, gc: true }, room) },
  { column: 'nongcdoc', include: 'nongc', assetId: (room, t) => object.assign({ type: /** @type {const} */ ('id:ydoc:v1'), t, gc: false }, room) },
  { column: 'contentmap', include: 'contentmap', assetId: (room, t) => object.assign({ type: /** @type {const} */ ('id:contentmap:v1'), t }, room) },
  { column: 'contentids', include: 'contentids', assetId: (room, t) => object.assign({ type: /** @type {const} */ ('id:contentids:v1'), t }, room) }
]

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
 * @return {Promise<Exclude<ASSET,t.RetrievableAsset>|null>} - it can't be guaranteed that we find all retrievable assets
 */
const tryPersistencePluginRetrieve = async (plugins, assetId, asset) => {
  if (asset.type === 'asset:retrievable:v1') {
    for (const plugin of plugins) {
      if (plugin.retrieve != null) {
        const r = /** @type {Exclude<ASSET,t.RetrievableAsset>} */ (await plugin.retrieve(assetId, asset))
        if (r != null) return r
      }
    }
    return null
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
        plugin.delete(assetId, asset).catch(err => log.error({ err, assetId }, 'error deleting asset'))
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
    log.debug({ room, gcDocSize: gcDoc.byteLength, nongcDocSize: nongcDoc.byteLength, contentmapSize: contentmap.byteLength, contentidsSize: contentids.byteLength }, 'storing doc')
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
    // whether each column ends up holding an `asset:retrievable:v1` pointer or the bytes
    // themselves is decided per asset by the plugin chain - record it, so a reader that only
    // needs the references can leave the inline blobs in the database
    const isReference = /** @param {t.Asset} asset */ asset => asset.type === 'asset:retrievable:v1'
    const encodedGcDocAsset = buffer.encodeAny(gcDocAsset)
    const encodedNongcDocAsset = buffer.encodeAny(nongcDocAsset)
    const encodedContentmapAsset = buffer.encodeAny(contentmapAsset)
    const encodedContentidsAsset = buffer.encodeAny(contentidsAsset)
    const created = number.parseInt(lastClock.split('-')[0])
    // The `WHERE NOT EXISTS` is the hard-deletion barrier, and it has to be part of this
    // statement rather than a check in front of it: a compact task spends seconds to minutes
    // merging between reading the room's state and arriving here, and `ON CONFLICT` cannot
    // catch it either, because `t` is a fresh clock on every compaction. Guarding here rather
    // than in the worker also covers `unsafePersistDoc`, which reaches storage directly.
    // Soft deletions are deliberately not guarded: compaction keeps running, so nothing that
    // was already on the stream is lost before it is trimmed, and a restore gets it all back.
    await this.sql`
      INSERT INTO yhub_ydoc_v1 (org,docid,branch,t,created,gcDoc,nongcDoc,contentmap,contentids,gcDoc_is_reference,nongcDoc_is_reference,contentmap_is_reference,contentids_is_reference)
      SELECT ${room.org},${room.docid},${room.branch},${lastClock},${created},${encodedGcDocAsset},${encodedNongcDocAsset},${encodedContentmapAsset},${encodedContentidsAsset},${isReference(gcDocAsset)},${isReference(nongcDocAsset)},${isReference(contentmapAsset)},${isReference(contentidsAsset)}
      WHERE NOT EXISTS (
        SELECT 1 FROM yhub_ydoc_tombstones_v1 d
        WHERE d.org = ${room.org} AND d.docid = ${room.docid} AND d.branch = ${room.branch} AND d.hard
      )
      ON CONFLICT (org,docid,branch,t) DO NOTHING
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
   * The room's tombstone is returned unconditionally - reading a document and learning whether it
   * was deleted is one round trip, never two.
   *
   * @return {Promise<{ lastClock: string, tombstone: t.Tombstone|null, gcDoc: Include['gc'] extends true ? Array<Uint8Array<ArrayBuffer>> : null, nongcDoc: Include['nongc'] extends true ? Array<Uint8Array<ArrayBuffer>> : null, contentmap: Include['contentmap'] extends true ? Array<Uint8Array<ArrayBuffer>> : null, references: Include['references'] extends true ? Array<{ assetId: t.AssetId, asset: t.Asset|null }> : null, contentids: Include['contentids'] extends true ? Array<Uint8Array<ArrayBuffer>> : null }>}
   */
  async retrieveDoc (room, includeContent) {
    const { lastClock, tombstone, assets } = await this.retrieveAssets(room, includeContent)
    // every stored asset is reported, resolved or not, so a version whose object has gone missing
    // still yields its reference and its row can finally be cleaned up
    const refs = includeContent.references === true ? assets : null
    /** @type {Array<Uint8Array<ArrayBuffer>>} */ const gcUpdates = []
    /** @type {Array<Uint8Array<ArrayBuffer>>} */ const nongcUpdates = []
    /** @type {Array<Uint8Array<ArrayBuffer>>} */ const contentmaps = []
    /** @type {Array<Uint8Array<ArrayBuffer>>} */ const contentidss = []
    await promise.all(assets.map(async ({ assetId, asset }) => {
      const retrieved = asset == null ? null : await tryPersistencePluginRetrieve(this.plugins, assetId, asset)
      if (retrieved == null) return
      switch (retrieved.type) {
        case 'asset:ydoc:v1':
          (assetId.type === 'id:ydoc:v1' && assetId.gc ? gcUpdates : nongcUpdates).push(retrieved.update)
          break
        case 'asset:contentmap:v1': contentmaps.push(retrieved.contentmap); break
        case 'asset:contentids:v1': contentidss.push(retrieved.contentids); break
      }
    }))
    log.debug({ room, assetCount: assets.length, lastClock, deleted: tombstone != null }, 'retrieved doc')
    return {
      lastClock,
      tombstone,
      gcDoc: /** @type {Include['gc'] extends true ? Array<Uint8Array<ArrayBuffer>> : null} */ (includeContent.gc === true ? gcUpdates : null),
      nongcDoc: /** @type {Include['nongc'] extends true ? Array<Uint8Array<ArrayBuffer>> : null} */ (includeContent.nongc === true ? nongcUpdates : null),
      contentmap: /** @type {Include['contentmap'] extends true ? Array<Uint8Array<ArrayBuffer>> : null} */ (includeContent.contentmap === true ? contentmaps : null),
      contentids: /** @type {Include['contentids'] extends true ? Array<Uint8Array<ArrayBuffer>> : null} */ (includeContent.contentids === true ? contentidss : null),
      references: /** @type {any} */ (refs)
    }
  }

  /**
   * Every asset stored for `room` - one entry per version and column - together with the room's
   * tombstone and last clock.
   *
   * *Assets*, not references: a column holds either an `asset:retrievable:v1` pointer or the bytes
   * themselves, and this returns whichever it is, unresolved. Resolving pointers through the
   * plugins is `retrieveDoc`'s job, and it is the only resolved-content path there is.
   *
   * `onlyReferences` leaves behind the columns a row marks as inline data - nothing to retrieve,
   * nothing external to delete - reporting them as `asset: null` so their bytes never leave
   * postgres. The entry is still emitted: `deleteReferences` derives the rows to delete from these
   * `assetId`s, so dropping them would strand every row whose assets are all inline.
   *
   * @template {{ gc?: boolean, nongc?: boolean, contentmap?: boolean, contentids?: boolean }} Include
   * @param {t.Room} room
   * @param {Include} includeContent
   * @param {object} [opts]
   * @param {boolean} [opts.onlyReferences]
   * @return {Promise<{ lastClock: string, tombstone: t.Tombstone|null, assets: Array<{ assetId: t.AssetId, asset: t.Asset|null }> }>}
   */
  async retrieveAssets (room, includeContent, { onlyReferences = false } = {}) {
    const wanted = assetColumns.filter(c => /** @type {any} */ (includeContent)[c.include] === true)
    // `<col>_is_reference` is false only on rows written since the markers were added; the column
    // defaults to true, so anything older is fetched and checked exactly as it always was
    const selection = wanted.reduce((frag, c) => onlyReferences
      ? this.sql`${frag}, CASE WHEN ${this.sql(c.column + '_is_reference')} THEN ${this.sql(c.column)} END AS ${this.sql(c.column)}`
      : this.sql`${frag}, ${this.sql(c.column)}`, this.sql``)
    /**
     * `t` is null on the tombstone-only row described below; every other row has one.
     *
     * @type {Array<{ [key: string]: any, t: string, deleted_at: string|null }>}
     */
    const rows = await this.sql`
      SELECT t ${selection}, deleted_at, hard, purged_at, by
      FROM yhub_ydoc_v1 FULL OUTER JOIN yhub_ydoc_tombstones_v1 USING (org,docid,branch)
      WHERE org = ${room.org} AND docid = ${room.docid} AND branch = ${room.branch}
    `
    // FULL OUTER JOIN, not LEFT: a room that was hard-deleted has no versions left but must still
    // report its tombstone, and USING merges the key columns so one WHERE filters both sides. Every
    // row repeats the same tombstone columns; a tombstoned room with no versions yields a single
    // row whose `t` is null - a real tombstone, not a version - which `docRows` drops.
    const tombstone = rows[0]?.deleted_at != null ? decodeTombstone(/** @type {any} */ (object.assign({}, room, rows[0]))) : null
    const docRows = rows.filter(row => row.t != null)
    /**
     * @type {Array<{ assetId: t.AssetId, asset: t.Asset|null }>}
     */
    const assets = []
    docRows.forEach(row => wanted.forEach(c => {
      const column = row[c.column]
      assets.push({ assetId: c.assetId(room, row.t), asset: column == null ? null : /** @type {t.Asset} */ (buffer.decodeAny(column)) })
    }))
    const lastClock = array.last(docRows.map(row => row.t).sort((a, b) => isSmallerRedisClock(a, b) ? -1 : 1)) || '0'
    return { lastClock, tombstone, assets }
  }

  /**
   * @param {Array<{ assetId: t.AssetId, asset: t.Asset|null }>} references
   * @return {Promise<void>}
   */
  async deleteReferences (references) {
    log.debug({ referenceCount: references.length }, 'deleting references')
    // a null asset is one the caller never fetched because the row marks it as inline data:
    // there is no external object to delete, but its assetId still names a row to drop
    references.forEach(ref => ref.asset != null && tryPersistencePluginDelete(this.plugins, ref.assetId, ref.asset))
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

  /**
   * The deletion record of `room`, or null when it was never deleted.
   *
   * @param {t.Room} room
   * @return {Promise<t.Tombstone|null>}
   */
  async retrieveTombstone (room) {
    const [row] = await this.sql`
      SELECT org, docid, branch, deleted_at, hard, purged_at, by FROM yhub_ydoc_tombstones_v1
      WHERE org = ${room.org} AND docid = ${room.docid} AND branch = ${room.branch}
    `
    return row == null ? null : decodeTombstone(/** @type {any} */ (row))
  }

  /**
   * The deletion records of `org`. `purged: false` selects the documents whose content has not
   * been erased yet - what a retention task iterates - and `before` bounds `deleted_at`.
   *
   * @param {string} org
   * @param {object} [filters]
   * @param {boolean} [filters.purged]
   * @param {number} [filters.before]
   * @return {Promise<Array<t.Tombstone>>}
   */
  async retrieveTombstones (org, { purged, before } = {}) {
    const rows = await this.sql`
      SELECT org, docid, branch, deleted_at, hard, purged_at, by FROM yhub_ydoc_tombstones_v1
      WHERE org = ${org}
      ${purged === undefined ? this.sql`` : purged ? this.sql`AND purged_at IS NOT NULL` : this.sql`AND purged_at IS NULL`}
      ${before === undefined ? this.sql`` : this.sql`AND deleted_at < ${before}`}
    `
    return rows.map(row => decodeTombstone(/** @type {any} */ (row)))
  }

  /**
   * Record that `room` was deleted. `deletedAt` is never moved by a repeated deletion - a client
   * retry must not extend the retention window - but a soft deletion can be upgraded to a hard
   * one, never the reverse.
   *
   * @param {t.Room} room
   * @param {object} deletion
   * @param {number} deletion.deletedAt
   * @param {boolean} deletion.hard
   * @param {string|null} deletion.by
   * @return {Promise<t.Tombstone>} the resulting record, which for a repeated deletion is the
   * one that was already there
   */
  async storeTombstone (room, { deletedAt, hard, by }) {
    log.info({ room, deletedAt, hard, by }, 'storing tombstone')
    const [row] = await this.sql`
      INSERT INTO yhub_ydoc_tombstones_v1 (org,docid,branch,deleted_at,hard,by)
      VALUES (${room.org},${room.docid},${room.branch},${deletedAt},${hard},${by})
      ON CONFLICT (org,docid,branch) DO UPDATE SET hard = yhub_ydoc_tombstones_v1.hard OR ${hard}
      RETURNING org, docid, branch, deleted_at, hard, purged_at, by
    `
    return decodeTombstone(/** @type {any} */ (row))
  }

  /**
   * @param {t.Room} room
   * @param {number} purgedAt
   * @return {Promise<t.Tombstone>}
   */
  async storeTombstonePurged (room, purgedAt) {
    const [row] = await this.sql`
      UPDATE yhub_ydoc_tombstones_v1 SET purged_at = ${purgedAt}
      WHERE org = ${room.org} AND docid = ${room.docid} AND branch = ${room.branch}
      RETURNING org, docid, branch, deleted_at, hard, purged_at, by
    `
    return decodeTombstone(/** @type {any} */ (row))
  }

  /**
   * Drop the deletion record of `room`, undeleting it (see `YHub.restoreDoc`).
   *
   * @param {t.Room} room
   * @return {Promise<void>}
   */
  async deleteTombstone (room) {
    log.info({ room }, 'dropping tombstone')
    await this.sql`
      DELETE FROM yhub_ydoc_tombstones_v1
      WHERE org = ${room.org} AND docid = ${room.docid} AND branch = ${room.branch}
    `
  }

  /**
   * Erase every stored version of `room`, through the same `deleteReferences` path compaction
   * uses to drop superseded versions - so there is one way to delete stored content, and it
   * always removes the row before the asset it points at. The reverse order would leave rows
   * referencing objects that no longer exist, which read back as silently missing content.
   *
   * Idempotent: the reference listing covers rows whose objects are already gone, so re-running
   * this is how a compaction that was still in flight when the document was deleted gets
   * cleaned up.
   *
   * @param {t.Room} room
   * @return {Promise<number>} the number of erased references
   */
  async purgeDoc (room) {
    const { assets } = await this.retrieveAssets(room, { gc: true, nongc: true, contentmap: true, contentids: true }, { onlyReferences: true })
    await this.deleteReferences(assets)
    log.info({ room, assetCount: assets.length }, 'purged doc')
    return assets.length
  }

  async destroy () {
    await this.sql.end({ timeout: 5 }) // existing queries have five seconds to finish
  }
}
