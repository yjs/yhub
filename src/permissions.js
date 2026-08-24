import * as math from 'lib0/math'
import * as object from 'lib0/object'
import * as s from 'lib0/schema'

/**
 * The permissions framework (see proposals/permissions.md). A permission object describes what a
 * subject may do with one resource, per scope:
 *
 *   'permissions:document:v1' - the sync unit: a document on a branch, addressed
 *                               {org, docid, branch}: full facet vocabulary
 *   'permissions:branch:v1'   - {org, branch}: a branch spans documents; endpoint-only in v1
 *   'permissions:org:v1'      - {org}: endpoint-only in v1
 *   'permissions:global:v1'   - {}: endpoint-only in v1
 *
 * Access is encoded as positional CRUD masks ('cr--', '-r--', ..): a fixed position per verb, so
 * checks are single char compares and every mask has exactly one spelling. `'----'` is the
 * canonical denial for crud-valued keys; `false` is accepted as input sugar for it and
 * normalized away. Absent means unspecified - it grants nothing, but merges treat it as "no
 * statement" (identity in a union) while `false`/`'----'` is an explicit denial (absorbing in an
 * intersection).
 *
 * On `ydoc` and `awareness` the `c` and `d` positions are inert for now - they grant nothing.
 * `c` is reserved: "may populate the initial content" (future create-document helpers that seed
 * an initial structure/schema). Deletion is granted solely through the `delete` facet.
 *
 * The input form is what plugins/config write (schema `$permissions`). Input read from
 * *external* sources (json bodies, tokens, http responses) must pass through
 * `sanitizePermissions` first - the merges and `normalizeDocPermissions` explicitly do not
 * repeat that work. `normalizeDocPermissions` validates (invalid answers throw) and returns the
 * normalized view - a prototype-less plain object, fully materialized, one spelling per denial -
 * which enforcement and recheck comparison read.
 */

/**
 * @typedef {{ org: string, docid: string, branch: string }
 *         | { org: string, branch: string }
 *         | { org: string }
 *         | {}} PermissionSelector
 */

/**
 * Permission levels: create | read | update | delete - efficiently encoded into a single string.
 *
 * The crud permission-check doesn't need a helper function:
 *
 * @example js
 *     if (perm[1] === 'r') {
 *       // user has read-access
 *     }
 *
 * @typedef {'crud'
 *   | '-rud' | 'c-ud' | 'cr-d' | 'cru-'
 *   | '--ud' | '-r-d' | '-ru-'
 *   | 'c--d' | 'c-u-'
 *   | 'cr--'
 *   | 'c---' | '-r--' | '--u-' | '---d'
 *   | '----'
 * } CRUD
 */

export const $crud = /** @type {s.Schema<CRUD>} */ (s.$custom((o, err) => {
  if (s.$string.check(o, err) && o.length === 4 && 'crud'.split('').every((p, i) => o[i] === p || o[i] === '-')) {
    return true
  }
  err?.extend(null, 'must be a "crud" subset', o)
  return false
}))

/**
 * @param {CRUD[]} cruds
 * @return {CRUD}
 */
export const crudUnion = (...cruds) => /** @type {CRUD} */ ('crud'.split('').map((p, i) => cruds.some(crud => crud[i] === p) ? p : '-').join(''))

/**
 * @param {CRUD[]} cruds
 * @return {CRUD}
 */
export const crudIntersect = (...cruds) =>
  // the empty intersection is vacuously 'crud' (`every` over nothing) - permissions fail closed
  cruds.length === 0 ? '----' : /** @type {CRUD} */ ('crud'.split('').map((p, i) => cruds.every(crud => crud[i] === p) ? p : '-').join(''))

// `false` denies: input sugar for '----' on crud keys, the explicit denial on object-valued keys
/**
 * @template {s.Schema<any>} T
 * @param {T} $v
 */
const $deniable = ($v) => s.$union($v, s.$false)

/**
 * The endpoint map. The `'*'` key takes a special role: it is the fallback for all unspecified
 * endpoint names (see `endpointPermission`).
 */
const $endpointFacet = s.$record(s.$string, $deniable($crud))

/**
 * Defines document-editing permissions.
 *
 * Note: optional fields may stay unspecified (by either not defining them or setting them to
 * undefined). They don't grant access, but merges treat unspecified as "no statement" while
 * `false` is an explicit denial.
 */
export const $docPermissionsV1 = s.$object({
  type: s.$literal('permissions:document:v1'),
  ydoc: $deniable($crud).optional,
  awareness: $deniable($crud).optional,
  history: $deniable(s.$object({
    from: s.$uint,
    rollback: s.$boolean.optional,
    prune: s.$boolean.optional
  })).optional,
  delete: $deniable(s.$array(s.$union(s.$literal('soft'), s.$literal('hard')))).optional,
  endpoint: $deniable($endpointFacet).optional
})

export const $branchPermissionsV1 = s.$object({ type: s.$literal('permissions:branch:v1'), endpoint: $deniable($endpointFacet).optional })
export const $orgPermissionsV1 = s.$object({ type: s.$literal('permissions:org:v1'), endpoint: $deniable($endpointFacet).optional })
export const $globalPermissionsV1 = s.$object({ type: s.$literal('permissions:global:v1'), endpoint: $deniable($endpointFacet).optional })
export const $permissions = s.$union($globalPermissionsV1, $orgPermissionsV1, $branchPermissionsV1, $docPermissionsV1)

/**
 * @typedef {s.Unwrap<typeof $docPermissionsV1>} DocPermissionsV1
 */
/**
 * @typedef {s.Unwrap<typeof $permissions>} Permissions
 */

/**
 * Sanitize permissions read from an external source (json bodies, tokens, http responses):
 * rebuild the object and its open-keyed endpoint map without a prototype, then validate (throws
 * on an invalid object). Endpoint names share a namespace with `Object.prototype` members
 * (`constructor` and `toString` are valid endpoint names per the api segment regex) and
 * json-derived maps may carry an own `__proto__` key - after this boundary both are inert own
 * keys, so the merges and `normalizeDocPermissions` use plain property access and explicitly do
 * not repeat this work.
 *
 * @param {any} permissions
 * @return {Permissions}
 */
export const sanitizePermissions = permissions => {
  const result = object.assign(Object.create(null), permissions)
  if (result.endpoint != null && typeof result.endpoint === 'object') {
    result.endpoint = object.assign(Object.create(null), result.endpoint)
  }
  return $permissions.expect(result)
}

/**
 * The normalized view on permissions allows us to avoid typechecks: every facet is present, and
 * every denial has one spelling (crud keys `'----'`, object-valued keys `false` - an empty
 * `delete` array is also `false`; the `delete` array is sorted + deduped). The endpoint map is
 * canonical: the `'*'` fallback is kept only when it grants something and a named entry only
 * when it differs from the fallback - merges may produce redundant entries (e.g. `y: '----'`
 * next to `'*': '----'`), and dropping them gives every map one spelling, so normalized views
 * compare with plain deep equality (`endpointPermission` semantics are unchanged).
 *
 * Implication normalization: `history.rollback`/`prune` are dead grants without update access on
 * the doc (their gates demand a write), so they normalize to `false` unless `ydoc` has `u`.
 *
 * @typedef {object} DocPermissionsV1Normalized
 * @property {'permissions:document:v1'} DocPermissionsV1Normalized.type
 * @property {CRUD} DocPermissionsV1Normalized.ydoc
 * @property {CRUD} DocPermissionsV1Normalized.awareness
 * @property {false | { from: number, rollback: boolean, prune: boolean }} DocPermissionsV1Normalized.history
 * @property {false | Array<'soft'|'hard'>} DocPermissionsV1Normalized.delete
 * @property {{ [name: string]: CRUD }} DocPermissionsV1Normalized.endpoint
 */

/**
 * Validate (throws on an invalid object) and normalize. The result is a plain object without a
 * prototype - nothing to subclass or monkey-patch, and json-derived endpoint names stay inert
 * own keys.
 *
 * @param {DocPermissionsV1} docPermissions
 * @return {DocPermissionsV1Normalized}
 */
export const normalizeDocPermissions = docPermissions => {
  const p = $docPermissionsV1.expect(docPermissions)
  /**
   * @type {DocPermissionsV1Normalized}
   */
  const n = Object.create(null)
  n.type = 'permissions:document:v1'
  n.ydoc = p.ydoc || '----'
  n.awareness = p.awareness || '----'
  const canUpdate = n.ydoc[2] === 'u'
  const history = p.history
  n.history = history
    ? { from: history.from, rollback: (canUpdate && history.rollback) || false, prune: (canUpdate && history.prune) || false }
    : false
  n.delete = (p.delete && p.delete.length > 0) ? Array.from(new Set(p.delete)).sort() : false
  n.endpoint = Object.create(null)
  const endpoint = p.endpoint || {}
  // '*' cannot collide with an inherited member, so a plain lookup suffices here
  const star = endpoint['*'] || '----'
  if (star !== '----') n.endpoint['*'] = star
  object.forEach(endpoint, (crud, name) => {
    if (name === '*' || crud === undefined) return
    const v = crud || '----'
    if (v !== star) n.endpoint[name] = v
  })
  return n
}

/**
 * The effective permission for an endpoint: the named entry, or the `'*'` fallback, or denied.
 * An explicit `'----'` entry blocks the fallback.
 *
 * @param {{ endpoint: { [name: string]: CRUD } }} permissions - a normalized view
 * @param {string} name
 * @return {CRUD}
 */
export const endpointPermission = (permissions, name) => permissions.endpoint[name] ?? permissions.endpoint['*'] ?? '----'

/**
 * Helper for creating a union over deniable permissions (false|undefined|T)
 *
 * @template T
 * @param {false|undefined|T} a
 * @param {false|undefined|T} b
 * @param {((a:T,b:T)=>T)} merge
 * @return {false|undefined|T}
 */
const deniableUnion = (a, b, merge) => a == null ? b : (b == null ? a : ((a === false || b === false) ? (a || b) : merge(a, b)))

/**
 * Helper for creating an intersection over deniable permissions (false|undefined|T). Only the least
 * permission "survives".
 *
 * @template T
 * @param {false|undefined|T} a
 * @param {false|undefined|T} b
 * @param {((a:T,b:T)=>T)} merge
 * @return {false|undefined|T}
 */
const deniableIntersect = (a, b, merge) => (a === false || b === false) ? false : ((a == null || b == null) ? undefined : merge(a, b))

/**
 * Merge two endpoint maps. `'*'` is the fallback for unspecified names, so each name is resolved
 * through it before merging - a narrow named entry must never shadow the other map's broader
 * fallback. Assumes sanitized input (see `sanitizePermissions`): endpoint names share a
 * namespace with `Object.prototype` members, and plain lookups on an unsanitized map would
 * resolve names like `constructor` to inherited values.
 *
 * @param {s.Unwrap<typeof $endpointFacet>} e1
 * @param {s.Unwrap<typeof $endpointFacet>} e2
 * @param {(a: false|undefined|CRUD, b: false|undefined|CRUD) => false|undefined|CRUD} combine
 */
const mergeEndpointFacets = (e1, e2, combine) => {
  /**
   * @type {s.Unwrap<typeof $endpointFacet>}
   */
  const result = Object.create(null)
  const mergeName = (/** @type {string} */ name) => {
    const merged = combine(e1[name] ?? e1['*'], e2[name] ?? e2['*'])
    if (merged !== undefined) result[name] = merged
  }
  object.forEach(e1, (_v, name) => mergeName(name))
  object.forEach(e2, (_v, name) => { result[name] === undefined && mergeName(name) })
  return result
}

/**
 * @param {DocPermissionsV1} docperm1
 * @param {DocPermissionsV1} docperm2
 * @return {DocPermissionsV1}
 */
export const docPermissionsUnion = (docperm1, docperm2) => ({
  type: docperm1.type,
  ydoc: deniableUnion(docperm1.ydoc, docperm2.ydoc, crudUnion),
  awareness: deniableUnion(docperm1.awareness, docperm2.awareness, crudUnion),
  history: deniableUnion(docperm1.history, docperm2.history, (h1, h2) => ({
    from: math.min(h1.from, h2.from),
    prune: deniableUnion(h1.prune, h2.prune, (p1, p2) => p1 || p2),
    rollback: deniableUnion(h1.rollback, h2.rollback, (r1, r2) => r1 || r2)
  })),
  delete: deniableUnion(docperm1.delete, docperm2.delete, (d1, d2) => Array.from(new Set([...d1, ...d2]))),
  endpoint: deniableUnion(docperm1.endpoint, docperm2.endpoint, (e1, e2) => mergeEndpointFacets(e1, e2, (a, b) => deniableUnion(a, b, crudUnion)))
})

/**
 * @param {DocPermissionsV1} docperm1
 * @param {DocPermissionsV1} docperm2
 * @return {DocPermissionsV1}
 */
export const docPermissionsIntersect = (docperm1, docperm2) => ({
  type: docperm1.type,
  ydoc: deniableIntersect(docperm1.ydoc, docperm2.ydoc, crudIntersect),
  awareness: deniableIntersect(docperm1.awareness, docperm2.awareness, crudIntersect),
  history: deniableIntersect(docperm1.history, docperm2.history, (h1, h2) => ({
    // the more restrictive ray survives an intersection
    from: math.max(h1.from, h2.from),
    prune: deniableIntersect(h1.prune, h2.prune, (p1, p2) => p1 && p2),
    rollback: deniableIntersect(h1.rollback, h2.rollback, (r1, r2) => r1 && r2)
  })),
  delete: deniableIntersect(docperm1.delete, docperm2.delete, (d1, d2) => d1.filter(p => d2.includes(p))),
  endpoint: deniableIntersect(docperm1.endpoint, docperm2.endpoint, (e1, e2) => mergeEndpointFacets(e1, e2, (a, b) => deniableIntersect(a, b, crudIntersect)))
})
