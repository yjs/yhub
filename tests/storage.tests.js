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
  const contentids = Y.createContentIdsFromDoc(ydoc)
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
