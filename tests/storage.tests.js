import * as Y from '@y/y'
import * as t from 'lib0/testing'
import * as env from 'lib0/environment'
import { S3PersistenceV1 } from '@y/hub/plugins/s3'
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
  const docRef = { org, docid: 'index', branch: 'main' }

  t.info('persisting two docs via unsafePersistDoc')
  const ydoc1 = new Y.Doc()
  ydoc1.get().setAttr('a', 1)
  await yhub.unsafePersistDoc(docRef, Y.encodeStateAsUpdate(ydoc1), { by: 'alice' })

  const ydoc2 = new Y.Doc()
  ydoc2.get().setAttr('b', 2)
  await yhub.unsafePersistDoc(docRef, Y.encodeStateAsUpdate(ydoc2), { by: 'bob' })

  t.info('retrieving and asserting merged content')
  const { gcDoc: ydocBin } = await yhub.getDoc(docRef, { gc: true }, { gcOnMerge: false })
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
 * `branches` gates which branches `store` offloads. `retrieve` and `delete` are keyed on the
 * asset's `plugin` marker instead, so objects offloaded under an earlier configuration stay
 * readable and deletable after the allowlist changes.
 *
 * @param {t.TestCase} tc
 */
export const testS3BranchesOption = async tc => {
  const s3conf = {
    bucket: env.ensureConf('S3_YHUB_TEST_BUCKET'),
    endPoint: env.ensureConf('S3_ENDPOINT'),
    port: parseInt(env.ensureConf('S3_PORT'), 10),
    useSSL: env.ensureConf('S3_SSL') === 'true',
    accessKey: env.ensureConf('S3_ACCESS_KEY'),
    secretKey: env.ensureConf('S3_SECRET_KEY')
  }
  /** @type {import('../src/types.js').AssetId} */
  const assetId = { type: 'id:ydoc:v1', org: tc.testName, docid: 'index', branch: 'feature', t: '1-0', gc: true }
  /** @type {import('../src/types.js').Asset} */
  const asset = { type: 'asset:ydoc:v1', update: new Uint8Array([1, 2, 3]) }
  const all = new S3PersistenceV1(s3conf)
  const stored = /** @type {import('../src/types.js').RetrievableAsset} */ (await all.store(assetId, asset))
  t.assert(stored != null && stored.plugin === all.pluginid, 'the default offloads every branch')
  t.assert(await new S3PersistenceV1({ ...s3conf, branches: ['feature'] }).store(assetId, asset) != null, 'a listed branch is offloaded')
  const excluding = new S3PersistenceV1({ ...s3conf, branches: ['main'] })
  t.assert(await excluding.store(assetId, asset) === null, 'an unlisted branch stays inline')
  t.compare(await excluding.retrieve(assetId, stored), asset, 'retrieval ignores the allowlist')
  t.assert(await excluding.delete(assetId, stored), 'deletion ignores the allowlist')
}
