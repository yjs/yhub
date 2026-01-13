import * as Y from '@y/y'
import * as t from 'lib0/testing'
import { storage } from './utils.js'

/**
 * @param {t.TestCase} _tc
 */
export const testStorage = async _tc => {
  {
    t.info('persisting docs')
    // index doc for baseline
    const ydoc1 = new Y.Doc()
    ydoc1.get().setAttr('a', 1)
    await storage.persistDoc('room', 'index', ydoc1, null)
    const sv1 = await storage.retrieveStateVector('room', 'index')
    t.assert(sv1)
    t.compare(new Uint8Array(sv1), Y.encodeStateVector(ydoc1), 'state vectors match')
    // second doc with different changes under the same index key
    const ydoc2 = new Y.Doc()
    ydoc2.get().setAttr('b', 1)
    await storage.persistDoc('room', 'index', ydoc2, null)
    // third doc that will be stored under a different key
    const ydoc3 = new Y.Doc()
    ydoc3.get().setAttr('a', 2)
    await storage.persistDoc('room', 'doc3', ydoc3, null)
    const sv2 = await storage.retrieveStateVector('room', 'doc3')
    t.assert(sv2)
    t.compare(new Uint8Array(sv2), Y.encodeStateVector(ydoc3), 'state vectors match')
  }
  {
    t.info('retrieving docs')
    const r1 = await storage.retrieveDoc('room', 'index')
    t.assert(r1)
    t.assert(r1.references.length === 2) // we stored two different versions that should be merged now
    const doc1 = new Y.Doc()
    Y.applyUpdateV2(doc1, r1.doc)
    // should have merged both changes..
    t.assert(doc1.get().getAttr('a') === 1 && doc1.get().getAttr('b') === 1)
    // retrieve other doc..
    const doc3 = new Y.Doc()
    const r3 = await storage.retrieveDoc('room', 'doc3')
    t.assert(r3)
    t.assert(r3.references.length === 1)
    Y.applyUpdateV2(doc3, r3.doc)
    t.assert(doc3.get().getAttr('a') === 2)
    t.info('delete references')
    await storage.deleteReferences('room', 'index', [r1.references[0]])
    const r1v2 = await storage.retrieveDoc('room', 'index')
    t.assert(r1v2 && r1v2.references.length === 1)
    await storage.deleteReferences('room', 'index', [r1.references[1]])
    const r1v3 = await storage.retrieveDoc('room', 'index')
    t.assert(r1v3 == null)
  }
  {
    const sv = await storage.retrieveStateVector('nonexistend', 'nonexistend')
    t.assert(sv === null)
  }
}
