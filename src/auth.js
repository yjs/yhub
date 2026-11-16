import * as error from 'lib0/error'
import * as f from 'lib0/function'
import * as object from 'lib0/object'
import * as promise from 'lib0/promise'
import * as s from 'lib0/schema'
import * as perm from './permissions.js'
import { apiError, isApiError } from './api.js'
import { logger } from './logger.js'

const log = logger.child({ module: 'auth' })

/**
 * The resources of `answers` whose permissions hold `required`.
 *
 * @template {'org'|'branch'|'document'} S
 * @param {Array<import('./types.js').NormalizedPermissionsAnswer<S>>} answers
 * @param {perm.Permissions} required
 * @return {Array<perm.PermissionResourceId<S>>}
 */
const holding = (answers, required) => answers.filter(({ permissions }) => perm.hasPermissions(/** @type {any} */ (permissions), /** @type {any} */ (required))).map(({ resource }) => resource)

/**
 * The auth plugin: who is asking (`authenticate`), what they may do with resources of one scope
 * (`get[Scope]Permissions`), and which of many resources hold one requirement
 * (`filterAuthorized[Scope]`). Pass a subclass as `conf.auth` - yhub instantiates it with itself
 * at startup as `yhub.auth`, which yhub's gates, custom endpoints and plugins call. Build one with
 * `createAuthPlugin` - preferred: its methods bound every call by the timeout, check every answer
 * (its length and resources, the permission objects, the `userid`) and normalize the permissions,
 * guards you usually want. You can also extend this class by hand and override the methods your
 * deployment answers, without those guards:
 *
 * ```js
 * class Auth extends AuthPlugin {
 *   async getDocumentPermissions (docRefs, authInfo) {
 *     return docRefs.map(resource => ({ resource, permissions: readOnly }))
 *   }
 * }
 * createYHub({ auth: Auth, ... })
 * ```
 *
 * The defaults: `authenticate` answers an anonymous caller (null), every `get[Scope]Permissions`
 * throws `Method unimplemented` - a deployment answers the scopes it serves; a route of a scope it
 * doesn't answer is a logged 500 - and every `filterAuthorized[Scope]` asks its
 * `get[Scope]Permissions` about all resources at once and keeps those that hold the requirement.
 *
 * A method you override is called as you write it - the timeout, the answer checks and the
 * normalization are `createAuthPlugin`'s. So it is async; a permissions getter answers
 * `{ resource, permissions }` for every resource it is given, in order - never null for the whole
 * list - with normalized permissions (`normalizeDocumentPermissions(createDocumentPermissions(..))`
 * and friends from `@y/hub/permissions`), or null permissions to deny a resource; `authenticate`
 * answers `{ userid, ... }` or null. Denial is a value, never a throw: throw a branded
 * `apiError(status, ...)` (`401` for a rejected credential, `503` for an auth-backend outage) to
 * answer with that status - any other throw is a 500, and any throw during a websocket recheck
 * closes the connection with 1013. `authenticate` receives the live uws request: read it before
 * the first `await`. yhub never asks about an empty list. `this.yhub` is the yhub instance.
 *
 * @template {import('./types.js').UserAuthInfo} [AuthInfo=import('./types.js').UserAuthInfo]
 */
export class AuthPlugin {
  /**
   * @param {import('./index.js').YHub} yhub
   */
  constructor (yhub) {
    this.yhub = yhub
  }

  /**
   * Who is asking: `{ userid, ... }`, or null for an anonymous caller. Default: anonymous.
   *
   * @param {import('uws').HttpRequest} req - the live uws request: read it before the first `await`
   * @return {Promise<AuthInfo|null>}
   */
  async authenticate (req) {
    return null
  }

  /**
   * The global permissions of `authInfo` - there is one global resource, so no list.
   *
   * @param {AuthInfo|null} authInfo
   * @return {Promise<perm.ToNormalizedPermissionType<'global'>|null>}
   */
  async getGlobalPermissions (authInfo) {
    return error.methodUnimplemented()
  }

  /**
   * The permissions of `authInfo` on each of `orgs` ({ org }), in order.
   *
   * @param {Array<perm.PermissionResourceId<'org'>>} orgs
   * @param {AuthInfo|null} authInfo
   * @return {Promise<Array<import('./types.js').NormalizedPermissionsAnswer<'org'>>>}
   */
  async getOrgPermissions (orgs, authInfo) {
    return error.methodUnimplemented()
  }

  /**
   * The permissions of `authInfo` on each of `branches` ({ org, branch }), in order.
   *
   * @param {Array<perm.PermissionResourceId<'branch'>>} branches
   * @param {AuthInfo|null} authInfo
   * @return {Promise<Array<import('./types.js').NormalizedPermissionsAnswer<'branch'>>>}
   */
  async getBranchPermissions (branches, authInfo) {
    return error.methodUnimplemented()
  }

  /**
   * The permissions of `authInfo` on each of `docRefs` ({ org, docid, branch }), in order.
   *
   * @param {Array<import('./types.js').DocRef>} docRefs
   * @param {AuthInfo|null} authInfo
   * @return {Promise<Array<import('./types.js').NormalizedPermissionsAnswer<'document'>>>}
   */
  async getDocumentPermissions (docRefs, authInfo) {
    return error.methodUnimplemented()
  }

  /**
   * The orgs of `orgs` that hold `required`, see `filterAuthorizedDocuments`.
   *
   * @param {Array<perm.PermissionResourceId<'org'>>} orgs
   * @param {perm.OrgPermissionsV1} required
   * @param {AuthInfo|null} authInfo
   * @return {Promise<Array<perm.PermissionResourceId<'org'>>>}
   */
  async filterAuthorizedOrgs (orgs, required, authInfo) {
    return holding(await this.getOrgPermissions(orgs, authInfo), required)
  }

  /**
   * The branches of `branches` that hold `required`, see `filterAuthorizedDocuments`.
   *
   * @param {Array<perm.PermissionResourceId<'branch'>>} branches
   * @param {perm.BranchPermissionsV1} required
   * @param {AuthInfo|null} authInfo
   * @return {Promise<Array<perm.PermissionResourceId<'branch'>>>}
   */
  async filterAuthorizedBranches (branches, required, authInfo) {
    return holding(await this.getBranchPermissions(branches, authInfo), required)
  }

  /**
   * The batch check: the documents of `docRefs` that `authInfo` holds `required` on (an
   * input-form requirement, `createDocumentPermissions({ ydoc: '-r--' })`). The default asks
   * `getDocumentPermissions` about all of them at once - override it only for a cheaper check
   * that agrees with it. yhub asks it from `GET /updated/v1/{org}`, once per page.
   *
   * @param {Array<import('./types.js').DocRef>} docRefs
   * @param {perm.DocumentPermissionsV1} required
   * @param {AuthInfo|null} authInfo
   * @return {Promise<Array<import('./types.js').DocRef>>}
   */
  async filterAuthorizedDocuments (docRefs, required, authInfo) {
    return holding(await this.getDocumentPermissions(docRefs, authInfo), required)
  }
}

/**
 * Settle with `p`, or reject with a branded 503 `auth timeout` once `timeout` ms have passed - a
 * hung auth plugin must not hold a rest request, a ws upgrade or a recheck forever (the call can't
 * be cancelled; it is abandoned). A branded apiError is the plugin's own answer - a 401 from
 * `authenticate` rejecting a credential, a 503 outage - and passes through, as does the timeout;
 * any other throw is an infrastructure failure: 503 `<method> unavailable`, transient like the ws
 * recheck's 1013.
 *
 * @template T
 * @param {string} method
 * @param {number} timeout
 * @param {Promise<T>} p
 * @return {Promise<T>}
 */
const withAuthTimeout = async (method, timeout, p) => {
  /**
   * @type {ReturnType<typeof setTimeout>|undefined}
   */
  let timer
  try {
    return await promise.race([p, promise.create((_resolve, reject) => {
      timer = setTimeout(() => {
        log.warn({ method, timeout }, 'auth plugin timed out')
        reject(apiError(503, 'auth timeout', { code: 'auth-timeout' }))
      }, timeout)
    })])
  } catch (err) {
    if (isApiError(err)) throw err
    log.warn({ err, method }, 'auth plugin failed')
    throw apiError(503, `${method} unavailable`, { code: 'auth-unavailable' })
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Normalize the permissions a plugin answered for `scope`. `null` stays null (no permissions), a
 * well-formed answer of an unknown future type version is denied whole (null) with a warning, a
 * known-but-wrong-scope type or an invalid object throws - a plugin bug, never a silent denial.
 *
 * @template {perm.PermissionScope} S
 * @param {string} method
 * @param {S} scope
 * @param {any} permissions
 * @return {perm.ToNormalizedPermissionType<S> | null}
 */
const normalizePermissionsAnswer = (method, scope, permissions) => {
  if (permissions == null) return null
  if (permissions.type !== `permissions:${scope}:v1`) {
    if (typeof permissions.type === 'string' && !perm.isKnownPermissionsType(permissions.type)) {
      log.warn({ type: permissions.type, method }, 'unknown permissions type, denying')
      return null
    }
    throw error.create(`auth plugin: ${method} answered ${JSON.stringify(permissions.type)}`)
  }
  return /** @type {any} */ (perm.normalizePermissions(permissions))
}

/**
 * A `get[Scope]Permissions` call of the definition: `{ resource, permissions }` for each of
 * `resourceIds`, in order, the permissions normalized. A null answer denies every resource. An
 * answer of the wrong length, or naming another resource at a position, is a plugin bug and throws
 * unbranded - a logged 500, never a silent denial.
 *
 * @template {'org'|'branch'|'document'} S
 * @param {Function} fn
 * @param {string} method
 * @param {S} scope
 * @param {number} timeout
 * @param {import('./index.js').YHub} yhub
 * @param {Array<perm.PermissionResourceId<S>>} resourceIds
 * @param {import('./types.js').UserAuthInfo|null} authInfo
 * @return {Promise<Array<import('./types.js').NormalizedPermissionsAnswer<S>>>}
 */
const getPermissions = async (fn, method, scope, timeout, yhub, resourceIds, authInfo) => {
  if (resourceIds.length === 0) return []
  const answers = await withAuthTimeout(method, timeout, fn(yhub, resourceIds, authInfo))
  if (answers == null) return resourceIds.map(resource => ({ resource, permissions: null }))
  if (!Array.isArray(answers) || answers.length !== resourceIds.length) {
    throw error.create(`auth plugin: ${method} answered ${Array.isArray(answers) ? answers.length : typeof answers} entries for ${resourceIds.length} resources`)
  }
  return answers.map(({ resource, permissions }, i) => {
    if (!f.equalityDeep(resource, resourceIds[i])) {
      throw error.create(`auth plugin: ${method} answered resource ${JSON.stringify(resource)} at position ${i}, asked about ${JSON.stringify(resourceIds[i])}`)
    }
    return { resource, permissions: normalizePermissionsAnswer(method, scope, permissions) }
  })
}

/**
 * A `filterAuthorized[Scope]` call of the definition: the resources that hold `required`, as
 * answered. A null answer holds none.
 *
 * @template R
 * @param {Function} fn
 * @param {string} method
 * @param {number} timeout
 * @param {import('./index.js').YHub} yhub
 * @param {Array<R>} resourceIds
 * @param {perm.Permissions} required
 * @param {import('./types.js').UserAuthInfo|null} authInfo
 * @return {Promise<Array<R>>}
 */
const filterAuthorized = async (fn, method, timeout, yhub, resourceIds, required, authInfo) =>
  resourceIds.length === 0 ? [] : ((await withAuthTimeout(method, timeout, fn(yhub, resourceIds, required, authInfo))) ?? [])

/**
 * The method `createAuthPlugin` defines for each member of the definition: the member called with
 * the yhub instance first, bounded by the timeout, its answer checked and normalized.
 *
 * @type {{ [K in keyof import('./types.js').AuthPluginDef<any>]-?: (fn: Function, timeout: number) => (this: AuthPlugin<any>, ...args: any[]) => Promise<any> }}
 */
const guards = {
  authenticate: (fn, timeout) => async function (req) {
    const authInfo = await withAuthTimeout('authenticate', timeout, fn(this.yhub, req))
    if (authInfo != null) s.$string.expect(authInfo.userid)
    return authInfo
  },
  getGlobalPermissions: (fn, timeout) => async function (authInfo) {
    return normalizePermissionsAnswer('getGlobalPermissions', 'global', await withAuthTimeout('getGlobalPermissions', timeout, fn(this.yhub, authInfo)))
  },
  getOrgPermissions: (fn, timeout) => function (orgs, authInfo) {
    return getPermissions(fn, 'getOrgPermissions', 'org', timeout, this.yhub, orgs, authInfo)
  },
  getBranchPermissions: (fn, timeout) => function (branches, authInfo) {
    return getPermissions(fn, 'getBranchPermissions', 'branch', timeout, this.yhub, branches, authInfo)
  },
  getDocumentPermissions: (fn, timeout) => function (docRefs, authInfo) {
    return getPermissions(fn, 'getDocumentPermissions', 'document', timeout, this.yhub, docRefs, authInfo)
  },
  filterAuthorizedOrgs: (fn, timeout) => function (orgs, required, authInfo) {
    return filterAuthorized(fn, 'filterAuthorizedOrgs', timeout, this.yhub, orgs, required, authInfo)
  },
  filterAuthorizedBranches: (fn, timeout) => function (branches, required, authInfo) {
    return filterAuthorized(fn, 'filterAuthorizedBranches', timeout, this.yhub, branches, required, authInfo)
  },
  filterAuthorizedDocuments: (fn, timeout) => function (docRefs, required, authInfo) {
    return filterAuthorized(fn, 'filterAuthorizedDocuments', timeout, this.yhub, docRefs, required, authInfo)
  }
}

/**
 * The options of `createAuthPlugin`. Typed by hand: `s.$` types an optional member as a required
 * key of type `number | undefined`.
 */
const $authPluginOpts = /** @type {s.Schema<{ timeout?: number }>} */ (s.$({ timeout: s.$uint.optional }))

/**
 * Build an auth plugin from its definition (see `AuthPluginDef`) - the recommended way over
 * extending `AuthPlugin` by hand: a subclass of `AuthPlugin` that defines a method for each member
 * of `def` - a member left out falls through to the `AuthPlugin` default. Pass it as `conf.auth`.
 * Each defined method calls its member with the yhub instance first, checks the answer (its length
 * and every resource, the permission objects, the `userid`), normalizes the permissions, and is
 * bounded by `timeout` ms (default 10000); a call that doesn't settle in time is abandoned: rest
 * requests and the websocket upgrade answer 503 `auth timeout`, a websocket recheck closes the
 * connection with 1013. `timeout` is a non-negative integer and must stay below 2^31 - node runs a
 * longer delay after 1 ms, so every call would time out. Invalid options, a member yhub doesn't
 * know (a typo) or one that isn't a function throw.
 *
 * @template {import('./types.js').UserAuthInfo} AuthInfo
 * @param {import('./types.js').AuthPluginDef<AuthInfo>} def
 * @param {s.Unwrap<typeof $authPluginOpts>} [opts]
 * @return {new (yhub: import('./index.js').YHub) => AuthPlugin<AuthInfo>}
 */
export const createAuthPlugin = (def, opts = {}) => {
  const { timeout = 10000 } = $authPluginOpts.expect(opts)
  /**
   * @extends {AuthPlugin<AuthInfo>}
   */
  class Auth extends AuthPlugin {}
  const proto = /** @type {any} */ (Auth.prototype)
  object.forEach(def, (fn, name) => {
    if (!object.hasProperty(guards, name)) throw error.create(`auth plugin: unknown member '${name}'`)
    if (fn == null) return
    if (typeof fn !== 'function') throw error.create(`auth plugin: '${name}' is not a function`)
    proto[name] = guards[/** @type {keyof typeof guards} */ (name)](fn, timeout)
  })
  return Auth
}
