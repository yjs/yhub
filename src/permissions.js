import * as error from 'lib0/error'
import * as f from 'lib0/function'
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
 * `sanitizePermissions` first - the merges and `normalizeDocumentPermissions` explicitly do not
 * repeat that work. `normalizeDocumentPermissions` validates (invalid answers throw) and returns the
 * normalized view - a prototype-less plain object, fully materialized, one spelling per denial -
 * which enforcement and recheck comparison read.
 */

/**
 * The scope of an `authorize` question - the first argument of the plugin hook. The ladder orders
 * global → org → branch → document (see naming.md): a branch spans many documents, and the leaf a
 * permission check cares about is a document on a branch.
 *
 * @typedef {'global'|'org'|'branch'|'document'} PermissionScope
 */
/**
 * The resource an `authorize` call addresses - the shape follows the scope.
 *
 * @template {PermissionScope} [S=PermissionScope]
 * @typedef {S extends 'document' ? import('./types.js').DocRef
 *   : S extends 'branch' ? { org: string, branch: string }
 *   : S extends 'org' ? { org: string }
 *   : {}} PermissionResourceId
 */
/**
 * The input-form permission type answering an `authorize` question of scope `S`. The returned
 * object's `type` literal must match the scope (`'document'` → `'permissions:document:v1'`, ..) -
 * a mismatch throws at the normalize boundary, a loud validation error rather than a silent
 * denial.
 *
 * @template {PermissionScope} [S=PermissionScope]
 * @typedef {S extends 'document' ? DocumentPermissionsV1
 *   : S extends 'branch' ? BranchPermissionsV1
 *   : S extends 'org' ? OrgPermissionsV1
 *   : GlobalPermissionsV1} ToPermissionType
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
export const $documentPermissionsV1 = s.$object({
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
export const $permissions = s.$union($globalPermissionsV1, $orgPermissionsV1, $branchPermissionsV1, $documentPermissionsV1)

/**
 * @typedef {s.Unwrap<typeof $documentPermissionsV1>} DocumentPermissionsV1
 */
/**
 * @typedef {s.Unwrap<typeof $branchPermissionsV1>} BranchPermissionsV1
 */
/**
 * @typedef {s.Unwrap<typeof $orgPermissionsV1>} OrgPermissionsV1
 */
/**
 * @typedef {s.Unwrap<typeof $globalPermissionsV1>} GlobalPermissionsV1
 */
/**
 * @typedef {s.Unwrap<typeof $permissions>} Permissions
 */

/**
 * Whether `type` is a permission-type literal this build knows. An answer whose type is a
 * well-formed but unknown literal (a future version, e.g. 'permissions:document:v2') must be
 * denied whole with a warning - never thrown on: a throw is treated as an infrastructure failure
 * and would keep a websocket recheck looping on 1013 instead of revoking cleanly.
 *
 * @param {string} type
 */
export const isKnownPermissionsType = type =>
  type === 'permissions:document:v1' || type === 'permissions:branch:v1' || type === 'permissions:org:v1' || type === 'permissions:global:v1'

/**
 * Rebuild a permission object and its object-valued facets (`endpoint`, `history`) without a
 * prototype. Endpoint names share a namespace with `Object.prototype` members (`constructor`
 * and `toString` are valid endpoint names per the api segment regex) and json-derived maps may
 * carry an own `__proto__` key - after this both are inert own keys. Arrays (`delete`) keep
 * theirs: they are only ever indexed and iterated.
 *
 * @param {any} permissions
 */
const withoutPrototype = permissions => {
  const result = object.assign(Object.create(null), permissions)
  ;['endpoint', 'history'].forEach(facet => {
    if (result[facet] != null && typeof result[facet] === 'object') result[facet] = object.assign(Object.create(null), result[facet])
  })
  return result
}

/**
 * Sanitize permissions read from an external source (json bodies, tokens, http responses):
 * rebuild without prototypes (`withoutPrototype`), then validate (throws on an invalid object).
 * Past this boundary the merges and `normalizeDocumentPermissions` use plain property access and
 * explicitly do not repeat this work.
 *
 * @param {any} permissions
 * @return {Permissions}
 */
export const sanitizePermissions = permissions => $permissions.expect(withoutPrototype(permissions))

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
 * @typedef {object} DocumentPermissionsV1Normalized
 * @property {'permissions:document:v1'} DocumentPermissionsV1Normalized.type
 * @property {CRUD} DocumentPermissionsV1Normalized.ydoc
 * @property {CRUD} DocumentPermissionsV1Normalized.awareness
 * @property {false | { from: number, rollback: boolean, prune: boolean }} DocumentPermissionsV1Normalized.history
 * @property {false | Array<'soft'|'hard'>} DocumentPermissionsV1Normalized.delete
 * @property {{ [name: string]: CRUD }} DocumentPermissionsV1Normalized.endpoint
 */

/**
 * The unchecked builder behind `normalizeDocumentPermissions`: validation happens at the two
 * boundaries (a plugin answer, a code-authored requirement); internal transforms - the
 * requirement and the intersection in `hasPermissions` - are closed over valid input and skip it.
 *
 * @param {DocumentPermissionsV1} p - schema-valid
 * @return {DocumentPermissionsV1Normalized}
 */
const createNormalizedDocumentPermissions = p => {
  /**
   * @type {DocumentPermissionsV1Normalized}
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
  n.endpoint = canonicalEndpointMap(p.endpoint || {})
  return n
}

/**
 * Create an input-form permission object of `scope` from its facets - the one spelling of a
 * hand-written permission object, whether a plugin answer, a composed grant, or the requirement
 * handed to `hasPermissions`/`checkPermissions`: the `type` literal follows the scope, and
 * neither the result nor its `endpoint`/`history` facets have a prototype, so endpoint names
 * never resolve to `Object.prototype` members (see `withoutPrototype`).
 *
 * @template {PermissionScope} S
 * @param {S} scope
 * @param {Omit<ToPermissionType<S>, 'type'>} p
 * @return {ToPermissionType<S>}
 */
export const createPermissions = (scope, p) => withoutPrototype({ ...p, type: `permissions:${scope}:v1` })

/**
 * @param {Omit<DocumentPermissionsV1, 'type'>} p
 */
export const createDocumentPermissions = p => createPermissions('document', p)

/**
 * @param {Omit<BranchPermissionsV1, 'type'>} p
 */
export const createBranchPermissions = p => createPermissions('branch', p)

/**
 * @param {Omit<OrgPermissionsV1, 'type'>} p
 */
export const createOrgPermissions = p => createPermissions('org', p)

/**
 * @param {Omit<GlobalPermissionsV1, 'type'>} p
 */
export const createGlobalPermissions = p => createPermissions('global', p)

/**
 * Validate (throws on an invalid object) and normalize. The result is a plain object without a
 * prototype - nothing to subclass or monkey-patch, and json-derived endpoint names stay inert
 * own keys.
 *
 * @param {DocumentPermissionsV1} documentPermissions
 * @return {DocumentPermissionsV1Normalized}
 */
export const normalizeDocumentPermissions = documentPermissions => createNormalizedDocumentPermissions($documentPermissionsV1.expect(documentPermissions))

/**
 * Canonicalize an endpoint facet against its `'*'` fallback: the fallback is kept only when it
 * grants something and a named entry only when it differs from the fallback, so semantically
 * equal maps are structurally equal (see `normalizeDocumentPermissions`). The result is
 * prototype-free.
 *
 * @param {s.Unwrap<typeof $endpointFacet>} endpoint
 * @return {{ [name: string]: CRUD }}
 */
const canonicalEndpointMap = endpoint => {
  /**
   * @type {{ [name: string]: CRUD }}
   */
  const result = Object.create(null)
  // '*' cannot collide with an inherited member, so a plain lookup suffices here
  const star = endpoint['*'] || '----'
  if (star !== '----') result['*'] = star
  object.forEach(endpoint, (crud, name) => {
    if (name === '*' || crud === undefined) return
    const v = crud || '----'
    if (v !== star) result[name] = v
  })
  return result
}

/**
 * The normalized view of the endpoint-only scopes (branch/org/global): the type plus a canonical
 * endpoint map (see `canonicalEndpointMap`).
 *
 * @template {'permissions:branch:v1'|'permissions:org:v1'|'permissions:global:v1'} T
 * @typedef {{ type: T, endpoint: { [name: string]: CRUD } }} EndpointPermissionsNormalized
 */
/**
 * @typedef {EndpointPermissionsNormalized<'permissions:branch:v1'>} BranchPermissionsV1Normalized
 */
/**
 * @typedef {EndpointPermissionsNormalized<'permissions:org:v1'>} OrgPermissionsV1Normalized
 */
/**
 * @typedef {EndpointPermissionsNormalized<'permissions:global:v1'>} GlobalPermissionsV1Normalized
 */

/**
 * The unchecked builder of the endpoint-only scopes (see `createNormalizedDocumentPermissions`).
 *
 * @param {BranchPermissionsV1|OrgPermissionsV1|GlobalPermissionsV1} p - schema-valid
 */
const createNormalizedEndpointPermissions = p => {
  const n = Object.create(null)
  n.type = p.type
  n.endpoint = canonicalEndpointMap(p.endpoint || {})
  return n
}

/**
 * @param {s.Schema<any>} $schema
 * @param {any} permissions
 */
const normalizeEndpointPermissions = ($schema, permissions) => createNormalizedEndpointPermissions($schema.expect(permissions))

/**
 * Validate (throws on an invalid object) and normalize a branch permission object - the
 * endpoint-only counterpart of `normalizeDocumentPermissions`.
 *
 * @param {BranchPermissionsV1} permissions
 * @return {BranchPermissionsV1Normalized}
 */
export const normalizeBranchPermissions = permissions => normalizeEndpointPermissions($branchPermissionsV1, permissions)

/**
 * @param {OrgPermissionsV1} permissions
 * @return {OrgPermissionsV1Normalized}
 */
export const normalizeOrgPermissions = permissions => normalizeEndpointPermissions($orgPermissionsV1, permissions)

/**
 * @param {GlobalPermissionsV1} permissions
 * @return {GlobalPermissionsV1Normalized}
 */
export const normalizeGlobalPermissions = permissions => normalizeEndpointPermissions($globalPermissionsV1, permissions)

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
 * The merges refuse mixed types: a doc∪org merge has no meaningful result, and silently keeping
 * one side's type would drop the other side's facets.
 *
 * @template {Permissions} P
 * @param {P} perm1
 * @param {Permissions} perm2
 * @return {P['type']}
 */
const assertSameType = (perm1, perm2) => {
  if (perm1.type !== perm2.type) {
    throw error.create(`cannot merge permissions of different types: ${perm1.type} / ${perm2.type}`)
  }
  return perm1.type
}

/**
 * @param {DocumentPermissionsV1} docperm1
 * @param {DocumentPermissionsV1} docperm2
 * @return {DocumentPermissionsV1}
 */
export const documentPermissionsUnion = (docperm1, docperm2) => ({
  type: assertSameType(docperm1, docperm2),
  ydoc: deniableUnion(docperm1.ydoc, docperm2.ydoc, crudUnion),
  awareness: deniableUnion(docperm1.awareness, docperm2.awareness, crudUnion),
  // single-ray model: `rollback`/`prune` are doc-wide booleans over one `from` ray, so a union
  // widens them to the wider (min) ray - composing {full-history reader, no rollback} with
  // {rollback from X} yields rollback from the epoch. Acceptable for v1; revisit with per-boolean
  // rays (`rollbackFrom`/`pruneFrom`) if roles must compose without widening.
  history: deniableUnion(docperm1.history, docperm2.history, (h1, h2) => ({
    from: math.min(h1.from, h2.from),
    prune: deniableUnion(h1.prune, h2.prune, (p1, p2) => p1 || p2),
    rollback: deniableUnion(h1.rollback, h2.rollback, (r1, r2) => r1 || r2)
  })),
  delete: deniableUnion(docperm1.delete, docperm2.delete, (d1, d2) => Array.from(new Set([...d1, ...d2]))),
  endpoint: deniableUnion(docperm1.endpoint, docperm2.endpoint, (e1, e2) => mergeEndpointFacets(e1, e2, (a, b) => deniableUnion(a, b, crudUnion)))
})

/**
 * @param {DocumentPermissionsV1} docperm1
 * @param {DocumentPermissionsV1} docperm2
 * @return {DocumentPermissionsV1}
 */
export const documentPermissionsIntersect = (docperm1, docperm2) => ({
  type: assertSameType(docperm1, docperm2),
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

/**
 * @param {Permissions['type']} type
 */
const $permissionsSchemaFor = type =>
  type === 'permissions:document:v1' ? $documentPermissionsV1 : type === 'permissions:branch:v1' ? $branchPermissionsV1 : type === 'permissions:org:v1' ? $orgPermissionsV1 : $globalPermissionsV1

/**
 * The normalized view of any scope (the views share the `type` discriminant).
 *
 * @typedef {DocumentPermissionsV1Normalized | BranchPermissionsV1Normalized | OrgPermissionsV1Normalized | GlobalPermissionsV1Normalized} NormalizedPermissions
 */
/**
 * The normalized view answering an `authorize` question of scope `S` - the counterpart of
 * `ToPermissionType`.
 *
 * @template {PermissionScope} [S=PermissionScope]
 * @typedef {S extends 'document' ? DocumentPermissionsV1Normalized
 *   : S extends 'branch' ? BranchPermissionsV1Normalized
 *   : S extends 'org' ? OrgPermissionsV1Normalized
 *   : GlobalPermissionsV1Normalized} ToNormalizedPermissionType
 */
/**
 * The requirement accepted for a permission view of `P`'s scope: an input-form permission object
 * of the same scope (`createDocumentPermissions({ ydoc: '-r--' })`, `createOrgPermissions(..)`,
 * ..). Distributes over a nullable view, so `req.permissions` (possibly null) accepts its
 * scope's requirement.
 *
 * @template {NormalizedPermissions | null} P
 * @typedef {P extends null ? Permissions : Extract<Permissions, { type: NonNullable<P>['type'] }>} RequiredPermissions
 */

/**
 * @param {Permissions} p - schema-valid
 * @return {NormalizedPermissions}
 */
const createNormalizedPermissions = p => p.type === 'permissions:document:v1' ? createNormalizedDocumentPermissions(p) : createNormalizedEndpointPermissions(p)

/**
 * The scope-generic normalizer, dispatching on `type`: validates (an invalid object or an unknown
 * type throws) and returns the prototype-less normalized view of that scope.
 *
 * @param {Permissions} permissions
 * @return {NormalizedPermissions}
 */
export const normalizePermissions = permissions => createNormalizedPermissions($permissions.expect(permissions))

/**
 * @param {Permissions} p1
 * @param {Permissions} p2
 * @return {Permissions}
 */
const permissionsIntersect = (p1, p2) => p1.type === 'permissions:document:v1'
  ? documentPermissionsIntersect(p1, /** @type {DocumentPermissionsV1} */ (p2))
  : /** @type {Permissions} */ ({
      type: assertSameType(p1, p2),
      endpoint: deniableIntersect(p1.endpoint, p2.endpoint, (e1, e2) => mergeEndpointFacets(e1, e2, (a, b) => deniableIntersect(a, b, crudIntersect)))
    })

// the facets a requirement may name per scope (document carries them all; the rest are endpoint-only)
const documentRequirableFacets = ['ydoc', 'awareness', 'history', 'delete', 'endpoint']

/**
 * Validate a code-authored requirement loudly - a caller bug throws, never silently checks less
 * than intended. Runs before the rollback/prune implication closure, which would otherwise melt
 * an invalid `ydoc` mask into a valid one.
 *
 * @param {any} required
 * @param {Permissions['type']} type - the scope's type, which the requirement must carry
 */
const assertValidRequirement = (required, type) => {
  if (required.type !== type) {
    throw error.create(`requirement of type ${JSON.stringify(required.type)} checked against ${type} permissions`)
  }
  const allowed = type === 'permissions:document:v1' ? documentRequirableFacets : ['endpoint']
  object.forEach(required, (value, key) => {
    if (key === 'type') return
    if (!allowed.includes(key)) {
      throw error.create(`invalid requirement facet '${key}' for ${type}`)
    }
    // a pure denial is vacuously satisfied by everyone - a requirement must be a positive grant
    if (value === false || value === '----' || (Array.isArray(value) && value.length === 0)) {
      throw error.create(`requirement facet '${key}' is a pure denial - a requirement must be a positive grant`)
    }
  })
  // validate every value (crud masks, uint `from`, ...) - catches e.g. an invalid `ydoc` mask before
  // the closure can launder it
  $permissionsSchemaFor(type).expect(required)
  // `history` is the only nested fixed-shape facet; the schema ignores unknown keys, so a typo'd
  // sub-key (`rollbck`) would silently drop the intended rollback/prune requirement
  if (required.history != null && typeof required.history === 'object') {
    object.forEach(required.history, (_v, k) => {
      if (k !== 'from' && k !== 'rollback' && k !== 'prune') throw error.create(`invalid history requirement key '${k}'`)
    })
  }
}

/**
 * Whether `permissions` contains everything `required` asks for - the containment
 * `required ⊆ granted`, decided in the merge algebra: the intersection of the two normalizes to
 * exactly `required`. Facet semantics follow from that: crud masks are positional subsets, a
 * `history.from` requirement is satisfied by any granted ray reaching at least as far back (so
 * `from: Number.MAX_SAFE_INTEGER` asks for "any history at all"), `delete` kinds are a subset
 * check, and endpoint names resolve through the `'*'` fallback on both sides. An empty `required`
 * is vacuously true.
 *
 * Requiring `history.rollback`/`prune` also requires the ydoc write it rides on - the
 * requirement-side mirror of the implication in `normalizeDocumentPermissions`; without it,
 * normalizing the requirement would silently drop the rollback/prune bit.
 *
 * `granted` is a normalized view - `req.permissions`, a connection's view, or
 * `normalizeDocumentPermissions(..)` of a composed grant - or `null`, which contains nothing (answered
 * before the requirement is validated: the safe direction). `required` is a code-authored
 * input-form permission object of the same scope - `createDocumentPermissions({ ydoc: '-r--' })`
 * and friends; a malformed requirement - a wrong scope, an unknown facet, an invalid value, or a
 * pure denial - throws: a caller bug, never a denial. Permission objects read from an external
 * source must pass `sanitizePermissions` first.
 *
 * @template {NormalizedPermissions | null} P
 * @param {P} granted
 * @param {RequiredPermissions<P>} required
 * @return {boolean}
 */
export const hasPermissions = (granted, required) => {
  if (granted === null) return false
  assertValidRequirement(required, granted.type)
  const history = /** @type {DocumentPermissionsV1} */ (required).history
  // the requirement-side mirror of implication normalization (see above): validated, and the
  // closure joins two valid masks, so the normalized views are created unchecked - as is the
  // intersection, the merges being closed over valid input
  const req = createNormalizedPermissions(history && (history.rollback || history.prune)
    ? /** @type {Permissions} */ ({ ...required, ydoc: crudUnion(/** @type {DocumentPermissionsV1} */ (required).ydoc || '----', '--u-') })
    : required)
  return f.equalityDeep(createNormalizedPermissions(permissionsIntersect(/** @type {Permissions} */ (granted), /** @type {Permissions} */ (req))), req)
}
