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
  const n = p.normalizeDocPermissions(perms)
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
  const n = p.normalizeDocPermissions({ type: doc, ydoc: 'cru-', history: { from: 7, rollback: true }, delete: ['soft'], endpoint: { '*': 'cr--', muted: false } })
  t.assert(n.ydoc === 'cru-' && n.awareness === '----')
  t.compare(n.history, { from: 7, rollback: true, prune: false })
  t.compare(n.delete, ['soft'])
  t.assert(n.endpoint['*'] === 'cr--')
  // false normalizes to the one denial spelling '----'
  t.assert(n.endpoint.muted === '----')
  t.assert(p.normalizeDocPermissions({ type: doc, ydoc: false }).ydoc === '----')
  // empty delete array and false are the same denial
  t.assert(p.normalizeDocPermissions({ type: doc, delete: [] }).delete === false)
  t.assert(p.normalizeDocPermissions({ type: doc, delete: false }).delete === false)
  t.assert(p.normalizeDocPermissions({ type: doc, history: false }).history === false)
  t.assert(p.normalizeDocPermissions({ type: doc, endpoint: false }).endpoint.anything === undefined)
  // the normalized view is a prototype-less plain object with eager plain values
  t.assert(Object.getPrototypeOf(n) === null && Object.getPrototypeOf(n.endpoint) === null)
  const h = n.history
  t.assert(h === n.history)
  // validation lives at this boundary: invalid input throws
  t.fails(() => p.normalizeDocPermissions(/** @type {any} */ ({ type: doc, ydoc: 'rw' })))
  t.fails(() => p.normalizeDocPermissions(/** @type {any} */ ({ type: doc, ydoc: null })))
  t.fails(() => p.normalizeDocPermissions(/** @type {any} */ ({ type: doc, history: { from: -1 } })))
  t.fails(() => p.normalizeDocPermissions(/** @type {any} */ ({ type: 'permissions:org:v1' })))
}

/**
 * @param {t.TestCase} _tc
 */
export const testImplicationNormalization = _tc => {
  // rollback/prune are dead grants without update access on the doc
  const readOnly = p.normalizeDocPermissions({ type: doc, ydoc: '-r--', history: { from: 0, rollback: true, prune: true } })
  t.compare(readOnly.history, { from: 0, rollback: false, prune: false })
  const writer = p.normalizeDocPermissions({ type: doc, ydoc: '-ru-', history: { from: 0, rollback: true } })
  t.compare(writer.history, { from: 0, rollback: true, prune: false })
}

/**
 * @param {t.TestCase} _tc
 */
export const testEndpointPermission = _tc => {
  const n = p.normalizeDocPermissions({ type: doc, endpoint: { '*': '-r--', comments: 'cru-', muted: false } })
  t.assert(p.endpointPermission(n, 'comments') === 'cru-')
  t.assert(p.endpointPermission(n, 'other') === '-r--') // '*' fallback
  t.assert(p.endpointPermission(n, 'muted') === '----') // explicit denial blocks the fallback
  const noStar = p.normalizeDocPermissions({ type: doc, endpoint: { comments: '-r--' } })
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
  const u = p.docPermissionsUnion(/** @type {any} */ (hostile), /** @type {any} */ (star))
  const n = p.normalizeDocPermissions(/** @type {any} */ (u))
  t.assert(p.endpointPermission(n, 'votes') === 'cr--')
  t.assert(p.endpointPermission(n, 'constructor') === 'cr--')
  t.assert(p.endpointPermission(n, 'toString') === 'cr--') // falls to '*', never to Object.prototype
  const i = p.docPermissionsIntersect(/** @type {any} */ (hostile), /** @type {any} */ (p.sanitizePermissions({ type: doc, endpoint: { '*': 'crud' } })))
  t.assert(p.endpointPermission(p.normalizeDocPermissions(/** @type {any} */ (i)), 'constructor') === '-r--')
  t.assert(p.endpointPermission(p.normalizeDocPermissions(/** @type {any} */ (i)), 'toString') === '----')
  // an own __proto__ key (JSON.parse creates one): with an object payload the entry is
  // schema-invalid - sanitize throws loudly; with a valid crud value it is just a strangely
  // named endpoint, kept as an inert own key on the prototype-less map
  t.fails(() => p.sanitizePermissions(JSON.parse('{"type":"permissions:document:v1","endpoint":{"__proto__":{"x":"crud"},"votes":"c---"}}')))
  t.assert(/** @type {any} */ ({}).x === undefined) // no global pollution
  const protoCrud = p.sanitizePermissions(JSON.parse('{"type":"permissions:document:v1","endpoint":{"__proto__":"c---"}}'))
  t.assert(Object.getPrototypeOf(protoCrud) === null && Object.getPrototypeOf(protoCrud.endpoint) === null)
  const un = p.normalizeDocPermissions(/** @type {any} */ (p.docPermissionsUnion(/** @type {any} */ (protoCrud), { type: doc, endpoint: {} })))
  t.assert(p.endpointPermission(un, '__proto__') === 'c---')
  t.assert(p.endpointPermission(un, 'other') === '----')
  // invalid shapes throw at the sanitize boundary
  t.fails(() => p.sanitizePermissions({ type: doc, ydoc: 'rw' }))
  t.fails(() => p.sanitizePermissions(null))
}

/**
 * @param {t.TestCase} _tc
 */
export const testUnion = _tc => {
  const u = p.docPermissionsUnion(
    { type: doc, ydoc: '-r--', history: { from: 10 }, delete: ['soft'], endpoint: { comments: '-r--' } },
    { type: doc, ydoc: '-ru-', awareness: '-ru-', history: { from: 20, rollback: true }, delete: ['hard'], endpoint: { comments: 'c-u-', votes: 'crud' } }
  )
  const n = p.normalizeDocPermissions(u)
  t.assert(n.ydoc === '-ru-' && n.awareness === '-ru-')
  t.compare(n.history, { from: 10, rollback: true, prune: false }) // rays join by min
  t.compare(/** @type {any} */ (n.delete).slice().sort(), ['hard', 'soft'])
  t.assert(n.endpoint.comments === 'cru-' && n.endpoint.votes === 'crud')
  // false is bottom for the union - a grant survives it
  t.assert(p.normalizeDocPermissions(p.docPermissionsUnion({ type: doc, ydoc: false }, { type: doc, ydoc: '-r--' })).ydoc === '-r--')
  // '*' fallback: a narrow named entry must not shadow the other side's broader fallback
  const star = p.docPermissionsUnion(
    { type: doc, endpoint: { votes: '-r--', muted: false } },
    { type: doc, endpoint: { '*': 'crud' } }
  )
  const ns = p.normalizeDocPermissions(star)
  t.assert(p.endpointPermission(ns, 'votes') === 'crud')
  t.assert(p.endpointPermission(ns, 'muted') === 'crud') // union: the fallback grant wins over the denial
  t.assert(p.endpointPermission(ns, 'other') === 'crud')
}

/**
 * @param {t.TestCase} _tc
 */
export const testIntersect = _tc => {
  const i = p.docPermissionsIntersect(
    { type: doc, ydoc: 'cru-', history: { from: 10, rollback: true }, delete: ['soft', 'hard'], endpoint: { comments: 'cru-' } },
    { type: doc, ydoc: '-rud', history: { from: 20, rollback: true }, delete: ['hard'], endpoint: { '*': '-ru-' } }
  )
  const n = p.normalizeDocPermissions(/** @type {any} */ (i))
  t.assert(n.ydoc === '-ru-')
  t.assert(n.awareness === '----') // unspecified ∩ unspecified
  t.compare(n.history, { from: 20, rollback: true, prune: false }) // the more restrictive ray survives
  t.compare(n.delete, ['hard'])
  t.assert(n.endpoint.comments === '-ru-') // resolved through the other side's '*'
  // false absorbs in an intersection
  t.assert(p.normalizeDocPermissions(/** @type {any} */ (p.docPermissionsIntersect({ type: doc, ydoc: false }, { type: doc, ydoc: 'crud' }))).ydoc === '----')
  // unspecified ∩ grant = nothing
  t.assert(p.normalizeDocPermissions(/** @type {any} */ (p.docPermissionsIntersect({ type: doc }, { type: doc, ydoc: 'crud' }))).ydoc === '----')
  // empty delete intersection normalizes to the false denial
  t.assert(p.normalizeDocPermissions(/** @type {any} */ (p.docPermissionsIntersect({ type: doc, delete: ['soft'] }, { type: doc, delete: ['hard'] }))).delete === false)
}

/**
 * @param {prng.PRNG} gen
 * @return {import('../src/permissions.js').DocPermissionsV1}
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
    t.compare(norm(p.docPermissionsUnion(a, b)), norm(p.docPermissionsUnion(b, a)))
    t.compare(norm(p.docPermissionsIntersect(a, b)), norm(p.docPermissionsIntersect(b, a)))
    t.compare(
      norm(p.docPermissionsUnion(a, p.docPermissionsUnion(b, c))),
      norm(p.docPermissionsUnion(p.docPermissionsUnion(a, b), c))
    )
    t.compare(
      norm(p.docPermissionsIntersect(a, /** @type {any} */ (p.docPermissionsIntersect(b, c)))),
      norm(p.docPermissionsIntersect(/** @type {any} */ (p.docPermissionsIntersect(a, b)), c))
    )
    t.compare(norm(p.docPermissionsUnion(a, a)), norm(a))
    t.compare(norm(p.docPermissionsIntersect(a, a)), norm(a))
    // every merge result is schema-valid input (merges stay in the input domain)
    t.assert(p.$docPermissionsV1.check(p.docPermissionsUnion(a, b)))
    t.assert(p.$docPermissionsV1.check(p.docPermissionsIntersect(a, b)))
    // implication invariant survives every merge
    const n = p.normalizeDocPermissions(p.docPermissionsUnion(a, b))
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
    const u = p.normalizeDocPermissions(p.docPermissionsUnion(a, b))
    const x = p.normalizeDocPermissions(/** @type {any} */ (p.docPermissionsIntersect(a, b)))
    for (const side of [p.normalizeDocPermissions(a), p.normalizeDocPermissions(b)]) {
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
