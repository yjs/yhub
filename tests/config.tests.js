import * as t from 'lib0/testing'
import * as types from '../src/types.js'
import { AuthPlugin, createAuthPlugin } from '../src/auth.js'
import { createYHub } from '../src/index.js'
import { createDocumentPermissions, normalizeDocumentPermissions } from '../src/permissions.js'

/**
 * Nothing here is ever connected to - `$config` only validates the shape.
 */
const baseConf = {
  redis: { url: 'redis://localhost:6379', prefix: 'yhub-test' },
  postgres: 'postgres://localhost:5432/yhub'
}

/**
 * `createYHub` calls every plugin's `init` as `p.init?.(yhub)`, so a plugin that only retrieves
 * is a legitimate plugin. The schema used to require `init` and rejected it at startup.
 *
 * @param {t.TestCase} _tc
 */
export const testPersistencePluginOnlyRetrieve = _tc => {
  types.$config.expect({ ...baseConf, persistence: [{ retrieve: async () => null }] })
  // loosened, not moved: a plugin implementing everything is still accepted
  types.$config.expect({
    ...baseConf,
    persistence: [{ init: async () => {}, store: async () => null, retrieve: async () => null, delete: async () => true }]
  })
  t.fails(() => types.$config.expect(/** @type {any} */ ({ ...baseConf, persistence: [{ init: 'nope' }] })))
}

/**
 * `Persistence.deleteReferences` calls `plugin.delete`, but the schema had no entry for it.
 *
 * @param {t.TestCase} _tc
 */
export const testPersistencePluginDelete = _tc => {
  types.$config.expect({ ...baseConf, persistence: [{ delete: async () => true }] })
  // `$Object.check` only walks the declared shape, so a key missing from it is never looked at -
  // the positive case above passes either way. Rejecting a bad `delete` on an otherwise valid
  // plugin is what proves the key is really part of `$persistencePlugin` now.
  t.fails(() => types.$config.expect(/** @type {any} */ ({ ...baseConf, persistence: [{ init: async () => {}, delete: 'nope' }] })))
}

/**
 * The timeout options: `postgresOptions` is handed to the postgres client as is,
 * `createAuthPlugin`'s `timeout` bounds the auth plugin - a non-negative integer of milliseconds.
 *
 * @param {t.TestCase} _tc
 */
export const testTimeoutOptions = _tc => {
  types.$config.expect({ ...baseConf, persistence: [], postgresOptions: { max: 5, idle_timeout: 30, connection: { statement_timeout: 30000 } } })
  createAuthPlugin({}, { timeout: 5000 })
  t.fails(() => createAuthPlugin({}, /** @type {any} */ ({ timeout: '5s' })))
  t.fails(() => createAuthPlugin({}, { timeout: Infinity }))
  t.fails(() => createAuthPlugin({}, { timeout: -1 }))
}

const docRef = { org: 'o', docid: 'd', branch: 'main' }

/**
 * The message `p` rejects with, or null when it resolves.
 *
 * @param {Promise<any>} p
 */
const rejection = p => p.then(() => null, err => err.message)

/**
 * `createAuthPlugin` builds a subclass of `AuthPlugin`, passed as `conf.auth`. Every member of the
 * definition is optional - a missing one falls through to the `AuthPlugin` default - while a
 * member yhub doesn't know (a typo) or one that isn't a function throws.
 *
 * @param {t.TestCase} _tc
 */
export const testAuthPluginDefinition = async _tc => {
  types.$config.expect({ ...baseConf, persistence: [], auth: createAuthPlugin({}, { timeout: 5000 }) })
  const auth = new (createAuthPlugin({}))(/** @type {any} */ (null))
  t.assert(auth instanceof AuthPlugin)
  t.assert(await auth.authenticate(/** @type {any} */ ({})) === null, 'an anonymous caller')
  t.assert(await rejection(auth.getGlobalPermissions(null)) === 'Method unimplemented', 'a getter must be implemented')
  t.assert(await rejection(auth.getDocumentPermissions([docRef], null)) === 'Method unimplemented', 'a getter must be implemented')
  t.assert(await rejection(auth.filterAuthorizedDocuments([docRef], createDocumentPermissions({ ydoc: '-r--' }), null)) === 'Method unimplemented', 'the default filter asks the getter')
  t.fails(() => createAuthPlugin(/** @type {any} */ ({ getDocumentPermission: async () => null })))
  t.fails(() => createAuthPlugin(/** @type {any} */ ({ getDocumentPermissions: 'nope' })))
  // a server requires an auth plugin - checked before createYHub connects to anything
  const err = await createYHub({ ...baseConf, persistence: [], server: { port: 1 } }).then(() => null, err => err)
  t.assert(err?.message === 'conf.server requires conf.auth - build it with createAuthPlugin', 'a server without auth throws')
}

/**
 * The documented alternative to `createAuthPlugin` (our own code only uses `createAuthPlugin`): a
 * plugin written by extending `AuthPlugin` overrides only what it answers - the default filter
 * asks its getter. `createAuthPlugin` builds the same kind of subclass: a member it isn't given
 * falls through to the default, which then asks the checked and normalized getter.
 *
 * @param {t.TestCase} _tc
 */
export const testAuthPluginSubclass = async _tc => {
  const readGrant = normalizeDocumentPermissions(createDocumentPermissions({ ydoc: '-r--' }))
  const secret = { ...docRef, docid: 'secret' }
  class Auth extends AuthPlugin {
    /**
     * @param {Array<import('../src/types.js').DocRef>} docRefs
     */
    async getDocumentPermissions (docRefs) {
      return docRefs.map(resource => ({ resource, permissions: resource.docid === 'secret' ? null : readGrant }))
    }
  }
  const yhub = /** @type {any} */ ({})
  const auth = new Auth(yhub)
  t.assert(auth.yhub === yhub, 'this.yhub is the constructor argument')
  t.assert(await auth.authenticate(/** @type {any} */ ({})) === null, 'an anonymous caller')
  t.compare(await auth.filterAuthorizedDocuments([docRef, secret], createDocumentPermissions({ ydoc: '-r--' }), null), [docRef], 'the default filter asks the getter')
  t.compare(await auth.filterAuthorizedDocuments([docRef], createDocumentPermissions({ ydoc: '-ru-' }), null), [], 'a stricter requirement holds on none')
  const Built = createAuthPlugin({
    getDocumentPermissions: async (_yhub, docRefs) => docRefs.map(resource => ({ resource, permissions: resource.docid === 'secret' ? null : createDocumentPermissions({ ydoc: '-r--' }) }))
  })
  t.assert(!Object.hasOwn(Built.prototype, 'filterAuthorizedDocuments'), 'only the given members are defined')
  t.compare(await new Built(yhub).filterAuthorizedDocuments([docRef, secret], createDocumentPermissions({ ydoc: '-r--' }), null), [docRef], 'the default filter asks the normalized getter')
}

/**
 * A permissions getter answers `{ resource, permissions }` for every resource, in order: yhub
 * checks the length and every resource, and normalizes the permissions.
 *
 * @param {t.TestCase} _tc
 */
export const testAuthPluginPermissionsAnswer = async _tc => {
  const docRefs = [docRef, { ...docRef, docid: 'e' }]
  /**
   * @type {any}
   */
  let answer = docRefs.map(resource => ({ resource, permissions: createDocumentPermissions({ ydoc: '-r--' }) }))
  const auth = new (createAuthPlugin({ getDocumentPermissions: async () => answer }))(/** @type {any} */ (null))
  const permissions = await auth.getDocumentPermissions(docRefs, null)
  t.compare(permissions.map(p => p.resource), docRefs)
  t.compare(permissions[0].permissions, normalizeDocumentPermissions(createDocumentPermissions({ ydoc: '-r--' })), 'normalized')
  answer = answer.slice(1)
  await t.failsAsync(() => auth.getDocumentPermissions(docRefs, null))
  answer = docRefs.slice().reverse().map(resource => ({ resource, permissions: null }))
  await t.failsAsync(() => auth.getDocumentPermissions(docRefs, null))
}
