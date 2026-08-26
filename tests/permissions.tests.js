import * as t from 'lib0/testing'
import * as prng from 'lib0/prng'
import * as f from 'lib0/function'
import * as p from '../src/permissions.js'

const doc = /** @type {'permissions:document:v1'} */ ('permissions:document:v1')

/**
 * All 16 crud masks.
 *
 * @type {Array<import('../src/permissions.js').CRUD>}
 */
const allCruds = /** @type {any} */ (Array.from({ length: 16 }, (_v, bits) => 'crud'.split('').map((l, i) => (bits >> i) & 1 ? l : '-').join('')))

/**
 * Normalize for comparison: two permission objects are semantically equal iff their normalized
 * views deep-equal (spread the null-prototype view and its endpoint map into plain objects so
 * `t.compare` accepts them).
 *
 * @param {any} perms
 * @return {any}
 */
const norm = perms => {
  const n = p.normalizeDocumentPermissions(perms)
  return { ...n, endpoint: { ...n.endpoint } }
}

/**
 * @param {t.TestCase} _tc
 */
export const testCrudSchema = _tc => {
  allCruds.forEach(crud => t.assert(p.$crud.check(crud)))
  for (const bad of ['r', 'rw', 'wr', 'cru', 'crud-', 'xrud', 'rcud', 'CRUD', '', 4, null, undefined, true]) {
    t.assert(!p.$crud.check(bad))
  }
}

/**
 * @param {t.TestCase} _tc
 */
export const testCrudOps = _tc => {
  t.assert(p.crudUnion('-r--', 'c-u-') === 'cru-')
  t.assert(p.crudUnion('----', '---d') === '---d')
  t.assert(p.crudIntersect('cru-', '-rud') === '-ru-')
  t.assert(p.crudIntersect('c---', '-r--') === '----')
  // single-argument forms are identity; the empty forms fail closed
  t.assert(p.crudUnion('-ru-') === '-ru-' && p.crudIntersect('-ru-') === '-ru-')
  t.assert(p.crudUnion() === '----' && p.crudIntersect() === '----')
  for (let i = 0; i < 100; i++) {
    const a = allCruds[i % 16]
    const b = allCruds[(i * 7 + 3) % 16]
    const c = allCruds[(i * 11 + 5) % 16]
    // commutative, associative, idempotent
    t.assert(p.crudUnion(a, b) === p.crudUnion(b, a))
    t.assert(p.crudIntersect(a, b) === p.crudIntersect(b, a))
    t.assert(p.crudUnion(a, p.crudUnion(b, c)) === p.crudUnion(a, b, c))
    t.assert(p.crudIntersect(a, p.crudIntersect(b, c)) === p.crudIntersect(a, b, c))
    t.assert(p.crudUnion(a, a) === a && p.crudIntersect(a, a) === a)
    // identity / absorption duals
    t.assert(p.crudUnion(a, '----') === a && p.crudIntersect(a, 'crud') === a)
    t.assert(p.crudUnion(a, 'crud') === 'crud' && p.crudIntersect(a, '----') === '----')
    // union ⊇ args, intersect ⊆ args
    t.assert(p.crudUnion(p.crudUnion(a, b), a) === p.crudUnion(a, b))
    t.assert(p.crudIntersect(p.crudIntersect(a, b), a) === p.crudIntersect(a, b))
  }
}

/**
 * @param {t.TestCase} _tc
 */
export const testNormalize = _tc => {
  const n = p.normalizeDocumentPermissions({ type: doc, ydoc: 'cru-', history: { from: 7, rollback: true }, delete: ['soft'], endpoint: { '*': 'cr--', muted: false } })
  t.assert(n.ydoc === 'cru-' && n.awareness === '----')
  t.compare(n.history, { from: 7, rollback: true, prune: false })
  t.compare(n.delete, ['soft'])
  t.assert(n.endpoint['*'] === 'cr--')
  // false normalizes to the one denial spelling '----'
  t.assert(n.endpoint.muted === '----')
  t.assert(p.normalizeDocumentPermissions({ type: doc, ydoc: false }).ydoc === '----')
  // empty delete array and false are the same denial
  t.assert(p.normalizeDocumentPermissions({ type: doc, delete: [] }).delete === false)
  t.assert(p.normalizeDocumentPermissions({ type: doc, delete: false }).delete === false)
  t.assert(p.normalizeDocumentPermissions({ type: doc, history: false }).history === false)
  t.assert(p.normalizeDocumentPermissions({ type: doc, endpoint: false }).endpoint.anything === undefined)
  // the normalized view is a prototype-less plain object with eager plain values
  t.assert(Object.getPrototypeOf(n) === null && Object.getPrototypeOf(n.endpoint) === null)
  const h = n.history
  t.assert(h === n.history)
  // validation lives at this boundary: invalid input throws
  t.fails(() => p.normalizeDocumentPermissions(/** @type {any} */ ({ type: doc, ydoc: 'rw' })))
  t.fails(() => p.normalizeDocumentPermissions(/** @type {any} */ ({ type: doc, ydoc: null })))
  t.fails(() => p.normalizeDocumentPermissions(/** @type {any} */ ({ type: doc, history: { from: -1 } })))
  t.fails(() => p.normalizeDocumentPermissions(/** @type {any} */ ({ type: 'permissions:org:v1' })))
}

/**
 * @param {t.TestCase} _tc
 */
export const testImplicationNormalization = _tc => {
  // rollback/prune are dead grants without update access on the doc
  const readOnly = p.normalizeDocumentPermissions({ type: doc, ydoc: '-r--', history: { from: 0, rollback: true, prune: true } })
  t.compare(readOnly.history, { from: 0, rollback: false, prune: false })
  const writer = p.normalizeDocumentPermissions({ type: doc, ydoc: '-ru-', history: { from: 0, rollback: true } })
  t.compare(writer.history, { from: 0, rollback: true, prune: false })
}

/**
 * @param {t.TestCase} _tc
 */
export const testEndpointPermission = _tc => {
  const n = p.normalizeDocumentPermissions({ type: doc, endpoint: { '*': '-r--', comments: 'cru-', muted: false } })
  t.assert(p.endpointPermission(n, 'comments') === 'cru-')
  t.assert(p.endpointPermission(n, 'other') === '-r--') // '*' fallback
  t.assert(p.endpointPermission(n, 'muted') === '----') // explicit denial blocks the fallback
  const noStar = p.normalizeDocumentPermissions({ type: doc, endpoint: { comments: '-r--' } })
  t.assert(p.endpointPermission(noStar, 'other') === '----')
  // append-only: create without update
  t.assert(p.endpointPermission(n, 'comments')[0] === 'c' && p.endpointPermission(n, 'other')[2] !== 'u')
}

/**
 * External input goes through `sanitizePermissions` - after that boundary, prototype-member
 * names and json `__proto__` keys are inert own keys everywhere downstream.
 *
 * @param {t.TestCase} _tc
 */
export const testSanitize = _tc => {
  const hostile = p.sanitizePermissions(JSON.parse('{"type":"permissions:document:v1","endpoint":{"constructor":"-r--","votes":"c---"}}'))
  // the OTHER side must be sanitized too: once a map names `constructor`, a plain-literal
  // counterpart would resolve that name to Object.prototype instead of its '*' fallback
  const star = p.sanitizePermissions({ type: doc, endpoint: { '*': 'cr--' } })
  const u = p.documentPermissionsUnion(/** @type {any} */ (hostile), /** @type {any} */ (star))
  const n = p.normalizeDocumentPermissions(/** @type {any} */ (u))
  t.assert(p.endpointPermission(n, 'votes') === 'cr--')
  t.assert(p.endpointPermission(n, 'constructor') === 'cr--')
  t.assert(p.endpointPermission(n, 'toString') === 'cr--') // falls to '*', never to Object.prototype
  const i = p.documentPermissionsIntersect(/** @type {any} */ (hostile), /** @type {any} */ (p.sanitizePermissions({ type: doc, endpoint: { '*': 'crud' } })))
  t.assert(p.endpointPermission(p.normalizeDocumentPermissions(/** @type {any} */ (i)), 'constructor') === '-r--')
  t.assert(p.endpointPermission(p.normalizeDocumentPermissions(/** @type {any} */ (i)), 'toString') === '----')
  // an own __proto__ key (JSON.parse creates one): with an object payload the entry is
  // schema-invalid - sanitize throws loudly; with a valid crud value it is just a strangely
  // named endpoint, kept as an inert own key on the prototype-less map
  t.fails(() => p.sanitizePermissions(JSON.parse('{"type":"permissions:document:v1","endpoint":{"__proto__":{"x":"crud"},"votes":"c---"}}')))
  t.assert(/** @type {any} */ ({}).x === undefined) // no global pollution
  const protoCrud = p.sanitizePermissions(JSON.parse('{"type":"permissions:document:v1","endpoint":{"__proto__":"c---"}}'))
  t.assert(Object.getPrototypeOf(protoCrud) === null && Object.getPrototypeOf(protoCrud.endpoint) === null)
  const un = p.normalizeDocumentPermissions(/** @type {any} */ (p.documentPermissionsUnion(/** @type {any} */ (protoCrud), { type: doc, endpoint: {} })))
  t.assert(p.endpointPermission(un, '__proto__') === 'c---')
  t.assert(p.endpointPermission(un, 'other') === '----')
  // invalid shapes throw at the sanitize boundary
  t.fails(() => p.sanitizePermissions({ type: doc, ydoc: 'rw' }))
  t.fails(() => p.sanitizePermissions(null))
}

/**
 * @param {t.TestCase} _tc
 */
export const testNormalizeEndpointOnly = _tc => {
  const n = p.normalizeOrgPermissions({ type: 'permissions:org:v1', endpoint: { '*': '-r--', stats: '-r--', admin: 'crud' } })
  t.assert(n.type === 'permissions:org:v1')
  t.assert(p.endpointPermission(n, 'admin') === 'crud')
  t.assert(n.endpoint.stats === undefined) // equal to the fallback - dropped by canonicalization
  t.assert(p.endpointPermission(n, 'other') === '-r--')
  t.assert(Object.getPrototypeOf(n) === null && Object.getPrototypeOf(n.endpoint) === null)
  t.assert(p.normalizeGlobalPermissions({ type: 'permissions:global:v1' }).endpoint.x === undefined)
  t.assert(p.endpointPermission(p.normalizeBranchPermissions({ type: 'permissions:branch:v1', endpoint: false }), 'x') === '----')
  // the type literal must match the normalizer's scope
  t.fails(() => p.normalizeOrgPermissions(/** @type {any} */ ({ type: doc })))
  t.fails(() => p.normalizeBranchPermissions(/** @type {any} */ ({ type: 'permissions:global:v1' })))
}

/**
 * @param {t.TestCase} _tc
 */
export const testKnownPermissionsType = _tc => {
  for (const scope of ['document', 'branch', 'org', 'global']) {
    t.assert(p.isKnownPermissionsType(`permissions:${scope}:v1`))
  }
  t.assert(!p.isKnownPermissionsType('permissions:document:v2'))
  t.assert(!p.isKnownPermissionsType(''))
}

/**
 * @param {t.TestCase} _tc
 */
export const testMergeRefusesMixedTypes = _tc => {
  const org = /** @type {any} */ ({ type: 'permissions:org:v1', endpoint: { '*': 'crud' } })
  t.fails(() => p.documentPermissionsUnion({ type: doc }, org))
  t.fails(() => p.documentPermissionsIntersect({ type: doc }, org))
  // same-type merges still work
  t.assert(p.documentPermissionsUnion({ type: doc, ydoc: '-r--' }, { type: doc }).ydoc === '-r--')
}

/**
 * @param {t.TestCase} _tc
 */
export const testUnion = _tc => {
  const u = p.documentPermissionsUnion(
    { type: doc, ydoc: '-r--', history: { from: 10 }, delete: ['soft'], endpoint: { comments: '-r--' } },
    { type: doc, ydoc: '-ru-', awareness: '-ru-', history: { from: 20, rollback: true }, delete: ['hard'], endpoint: { comments: 'c-u-', votes: 'crud' } }
  )
  const n = p.normalizeDocumentPermissions(u)
  t.assert(n.ydoc === '-ru-' && n.awareness === '-ru-')
  t.compare(n.history, { from: 10, rollback: true, prune: false }) // rays join by min
  t.compare(/** @type {any} */ (n.delete).slice().sort(), ['hard', 'soft'])
  t.assert(n.endpoint.comments === 'cru-' && n.endpoint.votes === 'crud')
  // false is bottom for the union - a grant survives it
  t.assert(p.normalizeDocumentPermissions(p.documentPermissionsUnion({ type: doc, ydoc: false }, { type: doc, ydoc: '-r--' })).ydoc === '-r--')
  // '*' fallback: a narrow named entry must not shadow the other side's broader fallback
  const star = p.documentPermissionsUnion(
    { type: doc, endpoint: { votes: '-r--', muted: false } },
    { type: doc, endpoint: { '*': 'crud' } }
  )
  const ns = p.normalizeDocumentPermissions(star)
  t.assert(p.endpointPermission(ns, 'votes') === 'crud')
  t.assert(p.endpointPermission(ns, 'muted') === 'crud') // union: the fallback grant wins over the denial
  t.assert(p.endpointPermission(ns, 'other') === 'crud')
}

/**
 * @param {t.TestCase} _tc
 */
export const testIntersect = _tc => {
  const i = p.documentPermissionsIntersect(
    { type: doc, ydoc: 'cru-', history: { from: 10, rollback: true }, delete: ['soft', 'hard'], endpoint: { comments: 'cru-' } },
    { type: doc, ydoc: '-rud', history: { from: 20, rollback: true }, delete: ['hard'], endpoint: { '*': '-ru-' } }
  )
  const n = p.normalizeDocumentPermissions(/** @type {any} */ (i))
  t.assert(n.ydoc === '-ru-')
  t.assert(n.awareness === '----') // unspecified ∩ unspecified
  t.compare(n.history, { from: 20, rollback: true, prune: false }) // the more restrictive ray survives
  t.compare(n.delete, ['hard'])
  t.assert(n.endpoint.comments === '-ru-') // resolved through the other side's '*'
  // false absorbs in an intersection
  t.assert(p.normalizeDocumentPermissions(/** @type {any} */ (p.documentPermissionsIntersect({ type: doc, ydoc: false }, { type: doc, ydoc: 'crud' }))).ydoc === '----')
  // unspecified ∩ grant = nothing
  t.assert(p.normalizeDocumentPermissions(/** @type {any} */ (p.documentPermissionsIntersect({ type: doc }, { type: doc, ydoc: 'crud' }))).ydoc === '----')
  // empty delete intersection normalizes to the false denial
  t.assert(p.normalizeDocumentPermissions(/** @type {any} */ (p.documentPermissionsIntersect({ type: doc, delete: ['soft'] }, { type: doc, delete: ['hard'] }))).delete === false)
}

/**
 * @param {prng.PRNG} gen
 * @return {import('../src/permissions.js').DocumentPermissionsV1}
 */
const randomDocPermissions = gen => {
  /**
   * @type {any}
   */
  const result = { type: doc }
  const crud = () => prng.oneOf(gen, allCruds)
  const maybe = (/** @type {() => any} */ value) => prng.oneOf(gen, [() => undefined, () => false, value, value])()
  const ydoc = maybe(crud)
  if (ydoc !== undefined) result.ydoc = ydoc
  const awareness = maybe(crud)
  if (awareness !== undefined) result.awareness = awareness
  const history = maybe(() => ({
    from: prng.int32(gen, 0, 100),
    ...(prng.bool(gen) ? { rollback: prng.bool(gen) } : {}),
    ...(prng.bool(gen) ? { prune: prng.bool(gen) } : {})
  }))
  if (history !== undefined) result.history = history
  const del = maybe(() => prng.oneOf(gen, [[], ['soft'], ['hard'], ['soft', 'hard']]))
  if (del !== undefined) result.delete = del
  const endpoint = maybe(() => {
    /**
     * @type {any}
     */
    const e = {}
    prng.bool(gen) && (e['*'] = prng.oneOf(gen, [false, crud()]))
    for (const name of ['comments', 'votes']) {
      prng.bool(gen) && (e[name] = prng.oneOf(gen, [false, crud()]))
    }
    return e
  })
  if (endpoint !== undefined) result.endpoint = endpoint
  return result
}

/**
 * @param {t.TestCase} tc
 */
export const testMergeAlgebraProperties = tc => {
  for (let i = 0; i < 300; i++) {
    const a = randomDocPermissions(tc.prng)
    const b = randomDocPermissions(tc.prng)
    const c = randomDocPermissions(tc.prng)
    // both ops: commutative, associative, idempotent (modulo normalization)
    t.compare(norm(p.documentPermissionsUnion(a, b)), norm(p.documentPermissionsUnion(b, a)))
    t.compare(norm(p.documentPermissionsIntersect(a, b)), norm(p.documentPermissionsIntersect(b, a)))
    t.compare(
      norm(p.documentPermissionsUnion(a, p.documentPermissionsUnion(b, c))),
      norm(p.documentPermissionsUnion(p.documentPermissionsUnion(a, b), c))
    )
    t.compare(
      norm(p.documentPermissionsIntersect(a, /** @type {any} */ (p.documentPermissionsIntersect(b, c)))),
      norm(p.documentPermissionsIntersect(/** @type {any} */ (p.documentPermissionsIntersect(a, b)), c))
    )
    t.compare(norm(p.documentPermissionsUnion(a, a)), norm(a))
    t.compare(norm(p.documentPermissionsIntersect(a, a)), norm(a))
    // every merge result is schema-valid input (merges stay in the input domain)
    t.assert(p.$documentPermissionsV1.check(p.documentPermissionsUnion(a, b)))
    t.assert(p.$documentPermissionsV1.check(p.documentPermissionsIntersect(a, b)))
    // implication invariant survives every merge
    const n = p.normalizeDocumentPermissions(p.documentPermissionsUnion(a, b))
    if (n.history !== false && (n.history.rollback || n.history.prune)) {
      t.assert(n.ydoc[2] === 'u')
    }
  }
}

/**
 * The union grants at least what each side grants; the intersection grants at most.
 *
 * @param {t.TestCase} tc
 */
export const testMergeMonotonicity = tc => {
  for (let i = 0; i < 300; i++) {
    const a = randomDocPermissions(tc.prng)
    const b = randomDocPermissions(tc.prng)
    const u = p.normalizeDocumentPermissions(p.documentPermissionsUnion(a, b))
    const x = p.normalizeDocumentPermissions(/** @type {any} */ (p.documentPermissionsIntersect(a, b)))
    for (const side of [p.normalizeDocumentPermissions(a), p.normalizeDocumentPermissions(b)]) {
      t.assert(p.crudUnion(side.ydoc, u.ydoc) === u.ydoc)
      t.assert(p.crudIntersect(side.ydoc, x.ydoc) === x.ydoc)
      t.assert(p.crudUnion(side.awareness, u.awareness) === u.awareness)
      if (side.history !== false) {
        t.assert(u.history !== false && u.history.from <= side.history.from)
      }
      if (x.history !== false) {
        t.assert(side.history !== false && x.history.from >= side.history.from)
      }
      if (side.delete !== false) {
        side.delete.forEach(kind => t.assert(/** @type {any} */ (u.delete).includes(kind)))
      }
      if (x.delete !== false) {
        x.delete.forEach(kind => t.assert(side.delete !== false && side.delete.includes(kind)))
      }
      for (const name of ['comments', 'votes', 'other']) {
        const su = p.endpointPermission(side, name)
        t.assert(p.crudUnion(su, p.endpointPermission(u, name)) === p.endpointPermission(u, name))
        t.assert(p.crudIntersect(su, p.endpointPermission(x, name)) === p.endpointPermission(x, name))
      }
    }
  }
}

/**
 * Normalized views compare exactly: one spelling per denial, so `f.equalityDeep` over them is a
 * sound recheck comparison.
 *
 * @param {t.TestCase} _tc
 */
export const testNormalizedComparison = _tc => {
  t.assert(f.equalityDeep(norm({ type: doc, ydoc: false, delete: [] }), norm({ type: doc })))
  t.assert(f.equalityDeep(norm({ type: doc, endpoint: { muted: false } }), norm({ type: doc, ydoc: false, endpoint: { muted: '----' } })))
  t.assert(!f.equalityDeep(norm({ type: doc, ydoc: '-r--' }), norm({ type: doc })))
}

/**
 * `hasPermissions` decides the containment `required ⊆ granted` in the merge algebra: the
 * intersection of the two normalizes to exactly the (normalized) requirement. It takes the
 * normalized view (what `req.permissions` and a connection hold) or `null`, and a requirement
 * created for the same scope (`createDocumentPermissions`, ..).
 *
 * @param {t.TestCase} _tc
 */
export const testHasPermissions = _tc => {
  /**
   * @param {import('../src/permissions.js').DocumentPermissionsV1} grant - input form, normalized here
   * @param {any} required - document facets
   */
  const has = (grant, required) => p.hasPermissions(p.normalizeDocumentPermissions(grant), p.createDocumentPermissions(required))
  /**
   * @type {import('../src/permissions.js').DocumentPermissionsV1}
   */
  const grant = { type: doc, ydoc: 'cru-', awareness: '-r--', history: { from: 500 }, delete: ['soft'], endpoint: { '*': '-r--', comments: 'crud' } }
  t.assert(!p.hasPermissions(null, p.createDocumentPermissions({})) && !p.hasPermissions(null, p.createDocumentPermissions({ ydoc: '-r--' })), 'null permissions contain nothing - not even the empty requirement')
  t.assert(has(grant, {}), 'an empty requirement is vacuously true')
  t.assert(has(grant, { ydoc: 'cr--' }), 'crud masks are positional subsets')
  t.assert(!has(grant, { ydoc: '---d' }))
  // the created requirement has no prototype - endpoint names stay inert own keys
  t.assert(Object.getPrototypeOf(p.createDocumentPermissions({ ydoc: '-r--' })) === null)
  // the history ray: a granted `from` satisfies every requirement it reaches back to
  t.assert(has(grant, { history: { from: 700 } }))
  t.assert(!has(grant, { history: { from: 300 } }))
  t.assert(has({ type: doc, history: { from: 0 } }, { history: { from: 300 } }), 'the epoch grant satisfies everything')
  t.assert(has(grant, { history: { from: Number.MAX_SAFE_INTEGER } }), "`from: MAX_SAFE_INTEGER` asks for 'any history at all'")
  t.assert(!has({ type: doc, ydoc: 'crud' }, { history: { from: Number.MAX_SAFE_INTEGER } }))
  // a granted ray with rollback false is still a superset of a bare `from` requirement
  t.assert(has({ type: doc, ydoc: 'cru-', history: { from: 0, rollback: false } }, { history: { from: 0 } }))
  // requiring rollback/prune also requires the ydoc write it rides on (the requirement-side
  // implication closure) - a rollback grant without ydoc `u` is dead and never satisfies
  t.assert(has({ type: doc, ydoc: '--u-', history: { from: 0, rollback: true } }, { history: { from: 0, rollback: true } }))
  t.assert(!has({ type: doc, ydoc: 'cru-', history: { from: 0 } }, { history: { from: 0, rollback: true } }))
  t.assert(!has({ type: doc, ydoc: '-r--', history: { from: 0, rollback: true } }, { history: { from: 0, rollback: true } }))
  t.assert(!has({ type: doc, ydoc: '--u-', history: { from: 0, rollback: true } }, { history: { from: 0, prune: true } }))
  // delete kinds are a subset check, order-insensitive
  t.assert(has(grant, { delete: ['soft'] }))
  t.assert(!has(grant, { delete: ['hard'] }))
  t.assert(!has(grant, { delete: ['soft', 'hard'] }))
  t.assert(has({ type: doc, delete: ['soft', 'hard'] }, { delete: ['hard', 'soft'] }))
  // endpoint names resolve through the '*' fallback on both sides
  t.assert(has(grant, { endpoint: { comments: 'cru-' } }))
  t.assert(has(grant, { endpoint: { anything: '-r--' } }))
  t.assert(!has(grant, { endpoint: { anything: '--u-' } }))
  t.assert(!has(grant, { endpoint: { '*': 'crud' } }), "a '*' requirement asks for the fallback itself")
  t.assert(!has({ type: doc, endpoint: { '*': 'crud', blocked: false } }, { endpoint: { blocked: '-r--' } }), 'an explicit false blocks the fallback')
  // an endpoint literally named `constructor` must resolve like any other name (regression: an own
  // `constructor` key in the compared maps - fixed in lib0 equalityDeep 1.0.0-rc.27)
  /**
   * @type {import('../src/permissions.js').DocumentPermissionsV1}
   */
  const ctorGrant = { type: doc, endpoint: { '*': 'crud' } }
  t.assert(has(ctorGrant, { endpoint: { constructor: '-r--' } }), 'a `constructor` endpoint reads through the fallback')
  t.assert(!has({ type: doc, endpoint: { '*': '-r--' } }, { endpoint: { constructor: '--u-' } }))
  t.assert(has(ctorGrant, { endpoint: { toString: 'crud', valueOf: '-r--' } }), 'other prototype-named endpoints too')
  // the endpoint-only scopes check the same way
  const org = p.normalizeOrgPermissions({ type: 'permissions:org:v1', endpoint: { '*': '-r--' } })
  t.assert(p.hasPermissions(org, p.createOrgPermissions({ endpoint: { stats: '-r--' } })))
  t.assert(!p.hasPermissions(org, p.createOrgPermissions({ endpoint: { stats: 'c---' } })))
  // a malformed requirement throws - a caller bug, never a silently weaker check:
  t.fails(() => has(grant, { ydoc: 'rw' })) // invalid mask, no history
  t.fails(() => has(grant, { ydoc: 'rw', history: { from: 0, rollback: true } })) // invalid mask not laundered by the rollback closure
  t.fails(() => has(grant, { history: { from: 0, rollbck: true } })) // a typo in a nested history key
  t.fails(() => p.hasPermissions(org, p.createOrgPermissions(/** @type {any} */ ({ ydoc: '-r--' })))) // a wrong-scope facet
  t.fails(() => has(grant, { recent: true })) // an unknown facet
  // a pure-denial requirement facet is a caller bug (it would be satisfied by everyone)
  t.fails(() => has(grant, { history: false }))
  t.fails(() => has(grant, { ydoc: '----' }))
  t.fails(() => has(grant, { delete: [] }))
  // the requirement's scope follows the view - a document requirement against an org view is a
  // compile error, and a runtime one
  // @ts-expect-error - a document permission object is not an org requirement
  t.fails(() => p.hasPermissions(org, p.createDocumentPermissions({ ydoc: '-r--' })))
  // @ts-expect-error - an org permission object is not a document requirement
  t.fails(() => p.hasPermissions(p.normalizeDocumentPermissions(grant), p.createOrgPermissions({ endpoint: { stats: '-r--' } })))
}
