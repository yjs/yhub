import * as Y from '@y/y'
import * as t from 'lib0/testing'
import { yhub } from './utils.js'

let currClock = 0

/**
 * @param {string} org
 * @param {string} docid
 * @param {Y.Doc} ydoc
 */
const storeDoc = (org, docid, ydoc) => {
  const encDoc = Y.encodeStateAsUpdate(ydoc)
  const contentids = Y.createContentIdsFromDoc(ydoc, true)
  return yhub.persistence.store({ org, docid, branch: 'main' }, { lastClock: (++currClock) + '', gcDoc: encDoc, nongcDoc: encDoc, contentids: Y.encodeContentIds(contentids), contentmap: Y.encodeContentMap(Y.createContentMapFromContentIds(contentids, [], [])) })
}

/**
 * @param {string} org
 * @param {string} docid
 */
const retrieveDoc = async (org, docid) => {
  const { gcDoc: ydocBin, references } = await yhub.getDoc({ org, docid, branch: 'main' }, { gc: true, references: true }, { gcOnMerge: false })
  return { ydoc: Y.createDocFromUpdate(ydocBin), references }
}

/**
 * @param {t.TestCase} tc
 */
export const testUnsafePersistDoc = async tc => {
  const org = tc.testName
  const room = { org, docid: 'index', branch: 'main' }

  t.info('persisting two docs via unsafePersistDoc')
  const ydoc1 = new Y.Doc()
  ydoc1.get().setAttr('a', 1)
  await yhub.unsafePersistDoc(room, Y.encodeStateAsUpdate(ydoc1), { by: 'alice' })

  const ydoc2 = new Y.Doc()
  ydoc2.get().setAttr('b', 2)
  await yhub.unsafePersistDoc(room, Y.encodeStateAsUpdate(ydoc2), { by: 'bob' })

  t.info('retrieving and asserting merged content')
  const { gcDoc: ydocBin } = await yhub.getDoc(room, { gc: true }, { gcOnMerge: false })
  const merged = Y.createDocFromUpdate(ydocBin)
  t.assert(merged.get().getAttr('a') === 1)
  t.assert(merged.get().getAttr('b') === 2)
}

/**
 * @param {t.TestCase} tc
 */
export const testStorage = async tc => {
  const org = tc.testName
  {
    t.info('persisting docs')
    // index doc for baseline
    const ydoc1 = new Y.Doc()
    ydoc1.get().setAttr('a', 1)
    await storeDoc(org, 'index', ydoc1)
    // second doc with different changes under the same index key
    const ydoc2 = new Y.Doc()
    ydoc2.get().setAttr('b', 1)
    await storeDoc(org, 'index', ydoc2)
    // third doc that will be stored under a different key
    const ydoc3 = new Y.Doc()
    ydoc3.get().setAttr('a', 2)
    await storeDoc(org, 'doc3', ydoc3)
  }
  {
    t.info('retrieving docs')
    const r1 = await retrieveDoc(org, 'index')
    t.assert(r1.references.length === 2 * 2) // we stored two different versions that should be merged now - once contentids, once content
    const doc1 = r1.ydoc
    // should have merged both changes..
    t.assert(doc1.get().getAttr('a') === 1 && doc1.get().getAttr('b') === 1)
    // retrieve other doc..
    const r3 = await retrieveDoc(org, 'doc3')
    t.assert(r3)
    t.assert(r3.references.length === 1 * 2)
    const doc3 = r3.ydoc
    t.assert(doc3.get().getAttr('a') === 2)
    t.info('delete references')
  }
}

/**
 * `listRoomAssets` must report every persisted asset, including ones whose object can't
 * currently be read — those are exactly the ones a deletion must not miss.
 *
 * @param {t.TestCase} tc
 */
export const testListRoomAssets = async tc => {
  const org = tc.testName
  const room = { org, docid: 'index', branch: 'main' }

  const ydoc1 = new Y.Doc()
  ydoc1.get().setAttr('a', 1)
  await storeDoc(org, 'index', ydoc1)
  const ydoc2 = new Y.Doc()
  ydoc2.get().setAttr('b', 2)
  await storeDoc(org, 'index', ydoc2)

  t.info('listing assets without touching the persistence plugins')
  const assets = await yhub.persistence.listRoomAssets(room)
  // two stores × four columns (gc ydoc, nongc ydoc, contentmap, contentids)
  t.assert(assets.length === 2 * 4)
  t.assert(assets.every(a => a.assetId.org === org && a.assetId.docid === 'index'))
  t.assert(assets.some(a => a.assetId.type === 'id:ydoc:v1' && a.assetId.gc === true))
  t.assert(assets.some(a => a.assetId.type === 'id:ydoc:v1' && a.assetId.gc === false))
  t.assert(assets.some(a => a.assetId.type === 'id:contentmap:v1'))
  t.assert(assets.some(a => a.assetId.type === 'id:contentids:v1'))

  t.info('an unrelated room is unaffected')
  t.assert((await yhub.persistence.listRoomAssets({ org, docid: 'other', branch: 'main' })).length === 0)
}

/**
 * `deleteReferencesNow` must remove the rows only after every object is confirmed deleted, so a
 * failing object store can never leave data behind with nothing pointing at it.
 *
 * @param {t.TestCase} tc
 */
export const testDeleteReferencesNow = async tc => {
  const org = tc.testName
  const room = { org, docid: 'index', branch: 'main' }
  const ydoc = new Y.Doc()
  ydoc.get().setAttr('a', 1)
  await storeDoc(org, 'index', ydoc)

  const assets = await yhub.persistence.listRoomAssets(room)
  t.assert(assets.length > 0)
  const retrievable = assets.filter(a => a.asset.type === 'asset:retrievable:v1')

  if (retrievable.length === 0) {
    t.info('no plugin offloaded these assets — rows are deleted directly')
    await yhub.persistence.deleteReferencesNow(assets)
    t.assert((await yhub.persistence.listRoomAssets(room)).length === 0)
    return
  }

  t.info('a failing deleteNow must leave every row in place')
  const plugins = yhub.persistence.plugins
  const originals = plugins.map(p => p.deleteNow)
  plugins.forEach(p => { p.deleteNow = async () => { throw new Error('object store unavailable') } })
  let failed = false
  try {
    await yhub.persistence.deleteReferencesNow(assets)
  } catch (e) {
    failed = true
  }
  plugins.forEach((p, i) => { p.deleteNow = originals[i] })
  t.assert(failed)
  t.assert((await yhub.persistence.listRoomAssets(room)).length === assets.length)

  t.info('and a successful one removes both objects and rows')
  await yhub.persistence.deleteReferencesNow(assets)
  t.assert((await yhub.persistence.listRoomAssets(room)).length === 0)
}
