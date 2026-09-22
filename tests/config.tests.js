import * as t from 'lib0/testing'
import * as types from '../src/types.js'

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
