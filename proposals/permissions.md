# Permissions

Status: accepted; schemas and merges are implemented (`src/permissions.js`, importable as
`@y/hub/permissions`), enforcement is wired through the server. Replaces `AccessType`
(`'r'|'rw'|null`), `readAuthInfo` / `getAccessType` / `getOrgAccessType` / `getGlobalAccessType`
(the plugin is now `createAuthPlugin({ authenticate, get[Scope]Permissions,
filterAuthorized[Scope] })`), and the advisory `accessPurpose` mechanism.
Breaking; no compatibility layer — the migration mapping is documented in §12.

Companions: [permissions-prior-art.md](./permissions-prior-art.md) — the research this proposal
draws on (Zanzibar/Leopard, SpiceDB/OpenFGA, Discord, AWS ABAC/IAM, Cedar, XACML, Ably, Liveblocks,
Firestore, POSIX/NFSv4, Postgres RLS, Elasticsearch DLS) — and [naming.md](./naming.md) — the
resource-naming proposal accompanying this document. The content tier is named **document**
(decided; see naming.md), and the permission ladder orders branches *above* documents: the
database addresses `/{org}/{docid}/{branch}`, but conceptually a branch spans multiple documents
(like a git branch spans the whole tree), and the leaf a permission check cares about is *a
document on a branch*. `docid` stays the identifier throughout.

## V1 scope: the minimal safe subset

V1 implements a sound, self-contained framework for **what a subject can do on a document**,
extensible without breaking changes. In: the four typed permission objects (doc permissions
with the full facet vocabulary; branch/org/global as *endpoint-only* objects), positional CRUD
masks, the normalized view + implication normalization, the merge algebra (union + intersect),
the per-scope `get[Scope]Permissions` plugin functions with their batch form
`filterAuthorized[Scope]` (§7), and the enforcement invariants (§9).

Deliberately **deferred** (each reserved as a purely additive extension): scope floors and any
permission inheritance between scopes — an org- or branch-level answer never implies anything
about a document (relations come later); creation gating (`createMain`/`createBranch` — v1 keeps
today's semantics: a write with `ydoc: 'rw'` to a nonexistent document creates it); cross-branch
delete; floors, enumeration, and the v2 multi-doc sync (§10); the tag store (§11);
subdocuments (naming.md §5); `explainPermissions`; reading a named version's content without
ydoc `r` or a history ray (a separate grant, never a widened `history.version` `r`).

## 1. Concept

A **permission object** describes everything a subject may do with one resource. Permissions are
tied to the resource's facets (ydoc, awareness, history, …), never to transport routes — REST and
websocket gates both *consume* the same permission object. The auth plugin answers each
`get[Scope]Permissions(yhub, resourceIds, authInfo)` question with one per resource; yhub
normalizes it into a canonical form, caches it per connection, and enforces every gate from it.

yhub has **five permission levels**:

```
global  →  org  →  branch  →  doc  →  facet
```

The first four are scopes, each with its own typed permission object (§4); the fifth is the facet
level *inside* an object, where the actual attributes live (CRUD masks, bounds, …).
Note the deliberate inversion relative to the storage addressing `/{org}/{docid}/{branch}`:
permissions think of a branch as something spanning many documents, and of the leaf as a
document *on* a branch — which is also why the leaf type is called `DocumentPermissions`, the
name everyone reaches for when checking access to facet content.

Permission objects exist in two representations:

- **Input form** — what plugins, config, and tag assignments write: partial, with `false` as
  explicit denial. This is the *delta* form; merging operates on it, and merge results are
  themselves valid input.
- **Normalized view** — fully materialized, every facet present, one spelling per denial —
  produced by `normalizeDocumentPermissions` (which also validates: invalid answers throw) after the
  last merge. Enforcement and recheck comparison read only this view; its endpoint map is
  canonical (redundant entries equal to the `'*'` fallback are dropped), so plain deep equality
  over normalized views is a sound semantic comparison.

**Every permission object is typed and versioned** — the codebase's discriminated-union pattern
(`'id:ydoc:v1'`, `'ydoc:update:v1'`):

```js
export const $permissions = s.$union($globalPermissions, $orgPermissions, $branchPermissions, $docPermissions)
// types: 'permissions:global:v1' | 'permissions:org:v1' | 'permissions:branch:v1' | 'permissions:document:v1'
```

The type is present in input *and* canonical form, must match the selector's scope (a plugin
answering a document selector with `'permissions:org:v1'` is a loud validation error, not a
silent denial), and the merge helpers refuse mixed types. A future structural change ships as a new
literal (`'permissions:document:v2'`) that can coexist with v1 during migration; an object whose
type yhub does not know is denied whole, with a warning — the per-key warn+drop rule cannot
partially salvage an unknown shape.

## 2. Access values

Access is a **positional CRUD mask**: a 4-char string with a fixed position per verb —
`'crud'`, `'cru-'`, `'-r--'`, `'----'` — where `-` denies that verb (create/read/update/delete,
the universally known vocabulary; the mask *mechanism* follows POSIX `rwx` and Postgres `aclitem`
letter strings; rejected: `{read: true}` objects and bitsets, see prior-art §"encodings").
Positional masks make every value canonical by construction and checks single char compares —
no helper needed:

```js
if (perm.ydoc[1] === 'r') { /* read access */ }
```

All facets share the mask (`$crud` validates exactly the 16 subsets):

- `ydoc`: `r` = read/sync, `u` = submit updates. `c` and `d` are **inert for now** — `c` is
  reserved ("may populate the initial content", for future create-document helpers that seed an
  initial structure/schema); deletion is granted solely through the `delete` facet.
- `awareness`: `r` = receive presence, `u` = broadcast own presence; `c`/`d` inert. `u`-only:
  announce without receiving.
- `endpoint` entries: full crud by HTTP verb class (`get`→`r`, `post`→`c`, `put`/`patch`→`u`,
  `delete`→`d`). Create split from update because append-only grants ("may post new comments,
  not edit existing ones") are a real pattern — the Firestore/Kubernetes lesson, adopted day one.

`'----'` is the canonical denial spelling for mask-valued keys; `false` is accepted as input
sugar and normalized to it. No wildcards inside values; a mask with more positions is a new type
version, never a silent extension.

## 3. DocumentPermissions

The document on a branch — addressed `{org, docid, branch}` — is the sync unit: it is what a
websocket connection attaches to and what the doc-scoped REST endpoints address (`?branch=`,
default `'main'`). This type replaces the earlier working names "RoomPermissions" and
"BranchPermissions"; see naming.md for the room retirement and the branch-above-doc ordering.

### Input form and normalized view

```js
// input form ($documentPermissionsV1) - what plugins/config write; absent = unspecified,
// false = explicit denial (on mask keys it is sugar for '----')
{
  type:      'permissions:document:v1',
  ydoc:      CRUD | false,        // positional mask, e.g. 'cru-'
  awareness: CRUD | false,
  history:   { from: uint, rollback?: boolean, prune?: boolean, version?: CRUD | false, publish?: boolean } | false,
  delete:    Array<'soft'|'hard'> | false,
  endpoint:  { [name]: CRUD | false } | false    // may contain '*', the fallback entry
}
```

`normalizeDocumentPermissions` validates (invalid answers **throw** — validation lives at this single
boundary) and returns the `DocumentPermissionsV1Normalized` view: every facet present with eager plain
properties, one spelling per denial (mask keys `'----'`; `history`/`delete`/empty-`delete` →
`false`), the `delete` array sorted + deduped, and the endpoint map prototype-free and
**canonical** — the `'*'` fallback is kept only when it grants something and a named entry only
when it differs from the fallback, so semantically equal maps are structurally equal and
normalized views compare with plain deep equality (the recheck comparison).

Facet semantics and the exact gate each one owns:

| leaf | permits | enforcement point |
|---|---|---|
| `ydoc[1] === 'r'` | read doc state: ws upgrade + initial sync, `GET /ydoc`, receiving `ydoc:update:v1` fan-out | `server.js` upgrade/open; the `GET /ydoc` handler |
| `ydoc[2] === 'u'` | submit doc updates | ws `message` case 0 (replaces the blanket `hasWriteAccess` early-return); `PATCH /ydoc` |
| `awareness[2] === 'u'` | broadcast presence | ws `message` case 1; awareness field of `PATCH /ydoc` |
| `awareness[1] === 'r'` | receive presence | awareness relay in `onStreamMessage`; initial awareness send in `open`; `GET /ydoc?awareness=true` |
| `history.from` | read attributed history from `from` onward (0 = full) | `changeset`/`activity`: bounds clamped **before** the cache key (§9); `?ydoc=`/`?delta=` additionally require ydoc `r` (§9.7); `gc=false` requires `from: 0` (§9) |
| `history.rollback` | revert doc content | `POST /rollback`; requested range must be ⊆ the granted ray (§9) |
| `history.prune` | destroy history permanently | `POST /prune`; same containment rule |
| `history.version` | crud over the named versions within the ray (annotated points of the history) — metadata only; content at a version stays behind ydoc `r` + the ray (§9.7) | `GET /version` and the activity's `?versions=` clamp to the ray; `POST`/`PUT`/`DELETE /version` refuse a `t` before it. No implication - a version doesn't write the document |
| `history.publish` | set a named version's `published` flag, and write published versions | the version writes: an explicit `published` is ignored without it; a published version is frozen - `PUT`/`PATCH`/`DELETE` refuse without it. No implication - it only acts together with a version write, whose bits the handler requires anyway |
| `delete` contains `'soft'` / `'hard'` | `DELETE /ydoc` (`?hard=true` requires `'hard'`) — this document on this branch | replaces `accessPurpose: 'delete'` — enforced, not advisory. `hard` was previously programmatic-only; granting it over REST is now an explicit permission |
| `endpointPermission(perms, name)` | call rest endpoints - builtin and custom (§8) | `createApiHandler` |
| `endpointPermission(perms, 'ws')` | `r`: open the websocket (with ydoc `r`); `u`: submit doc updates over it (with ydoc `u`) | `server.js` upgrade; ws `message` case 0 |

Creation is **not** a document facet — the document does not exist yet on that branch, so the
object describing it cannot carry its own creation right. V1 therefore keeps today's creation
semantics: the first accepted update creates the document on that branch, gated by ydoc `u`
alone. Dedicated creation rights (`createMain`/`createBranch`, on the tier that owns the
namespace) are a deferred additive extension. Awareness writes to a nonexistent document are
exempt from any creation gating — presence is ephemeral, and its stream keys age out via
compaction.

`history` groups everything the history ray must contain — `rollback`, `prune` and `version` live
inside the granted object, so they can never outlive history access. `delete` stays top-level because
it destroys the whole document on this branch, not one facet.

The history restriction is a **from-ray**, not a window: `false`/absent (no history) or
`{ from: T }` (history from T onward). `from` is a plain unix-ms int and `0` — the epoch — *is*
"full history", so no unbounded sentinel exists anywhere. A `to` permission bound was considered
and dropped — "can see old history but not recent edits" has no coherent product meaning next to
live read access to the current doc, and rays are **closed under union** (`min(from)`, `0` wins
naturally), so no merge can over-grant — the window-hull gap problem cannot arise. `to` remains
an ordinary *query* parameter on changeset/activity; a `to` permission bound, should a real
use-case appear, is a purely additive extension.

Denial: any facet may be `false` in input form. Absent means *unspecified* — it grants nothing,
but the merges treat it as "no statement" (identity in a union) where `false` is an explicit
denial (absorbing in an intersection). `null` is rejected by the schema — too similar to
undefined/absent.

An invalid or unknown-shaped answer **throws** at the `normalizeDocumentPermissions` boundary — the
earlier per-key warn+drop machinery was deliberately dropped with the simplified rewrite: a
malformed plugin answer is a loud error, not a silent partial denial. Permissions read from
*external* input (json bodies, tokens, http responses) must pass through `sanitizePermissions`
first: it rebuilds the object and its open-keyed endpoint map without a prototype and validates —
endpoint names share a namespace with `Object.prototype` members (`constructor` is a valid
endpoint name), and json-derived maps may carry an own `__proto__` key. The merges and
`normalizeDocumentPermissions` assume sanitized input and explicitly do not repeat this work.

## 4. BranchPermissions, OrgPermissions, GlobalPermissions

In v1 the coarser scopes are **endpoint-only**: they gate custom endpoints registered at their
scope, nothing more. There is no floor and no inheritance — holding a branch- or org-level
permission implies nothing about any document, and vice versa; every scope is answered by its own
`get[Scope]Permissions` function. Cross-scope relations are a deferred extension:
adding a floor key (e.g. `branch.docs`) later is purely additive and changes no v1 shape.

```js
// $branchPermissionsV1 - the branch {org, branch} as a whole (a branch spans many documents)
{ type: 'permissions:branch:v1', endpoint: { [name]: CRUD | false } | false }
// $orgPermissionsV1
{ type: 'permissions:org:v1', endpoint: { [name]: CRUD | false } | false }
// $globalPermissionsV1 - `orgs`: the orgs the subject has access to
{ type: 'permissions:global:v1', orgs: '*' | string[] | false, endpoint: { [name]: CRUD | false } | false }
```

`global.orgs` is the first floor key (§10) to ship: `'*'` or a list, normalized to `'*'`, a sorted
deduplicated list, or `false`; intersection keeps the common orgs (`'*'` is the identity). So far
it only restricts the global updated-orgs listing (`GET /updated/v1`) - it grants nothing at org
or document scope yet.

## 5. Merge algebra

Exactly two operations, both closed over the input form (their results are schema-valid input):

- **`documentPermissionsUnion(a, b)`** — independent grants held simultaneously ('-r--' via one
  assignment, '-ru-' via another → '-ru-'). Per-facet join: masks take the positional union,
  booleans OR, delete arrays the set union, history rays `min(from)` (`0` = full history wins
  naturally — rays are closed under union, the join is exact). `false` and absent are both
  bottom for a union: a grant survives them.
- **`documentPermissionsIntersect(a, b)`** — the least permission survives (attenuation: e.g. a token
  capability ∩ the subject's actual permissions). Per-facet meet: masks positional intersection,
  booleans AND, delete arrays set intersection, history rays `max(from)` — the more restrictive
  ray survives. `false` absorbs (an explicit denial can never be intersected away); absent means
  "no statement", and intersecting with no statement yields nothing.

Endpoint maps resolve each name through the `'*'` fallback *before* merging — a narrow named
entry must never shadow the other map's broader fallback — and merged maps are prototype-free
with own-property checks (endpoint names are plugin-chosen strings; `__proto__`/`constructor`
must stay inert). Both operations are commutative and associative, union is monotone (⊇ each
argument) and intersect anti-monotone (⊆ each argument) — property-tested over random inputs.

There is deliberately **no overlay/refine operation**: layered override semantics
(defaults ⊕ grant ⊕ restrict ⊕ override, re-grant above a denial) were designed in earlier
drafts and dropped for v1 — union and intersect cover composing multiple grants and attenuating
them, and an overlay can be reintroduced as a separate operation if a real need appears.

### Implication normalization (dead-grant elimination)

`normalizeDocumentPermissions` makes the view self-consistent: `history.rollback`/`prune` are dead
grants without update access on the doc (their gates demand a write), so they normalize to
`false` unless `ydoc` has `u`. A stale `rollback: true` next to a read-only mask is thereby
visible as denied in logs and in the recheck comparison, not just guarded in some handler.

## 6. Defaults

There is no core default-merging machinery: composing a subject's permissions out of defaults,
role grants, and per-doc grants is the plugin's business, done with `documentPermissionsUnion` /
`documentPermissionsIntersect` before answering. Deny-by-default falls out of absence — an empty
answer grants nothing — and destructive permissions (`rollback`, `prune`, `delete`) are granted
by name, never implied by a write mask (this deliberately breaks today's implicit "rw ⇒
rollback/delete"). "All endpoints open" is one entry: `endpoint: { '*': 'crud' }`. A plugin
answering `null` denies the subject outright.

## 7. Plugin API

```js
/**
 * @typedef {'global'|'org'|'branch'|'document'} PermissionScope
 */
/**
 * The resource a permissions getter is asked about - the shape follows the scope:
 * 'document' → { org, docid, branch }, 'branch' → { org, branch }, 'org' → { org },
 * 'global' → {} (a single resource, so the global getter takes no list).
 *
 * @template {PermissionScope} S
 * @typedef {...} PermissionResourceId
 */
/**
 * What `createAuthPlugin(def, { timeout })` takes. Every member is optional and async, and
 * receives the yhub instance first; a missing one falls through to the `AuthPlugin` default
 * (anonymous; a getter throws `Method unimplemented` ⇒ 500; a filter asks its getter), an unknown
 * one (a typo) throws. Never called with an empty list.
 *
 * @template {UserAuthInfo} AuthInfo
 * @typedef {object} AuthPluginDef
 * @property {(yhub, req) => Promise<AuthInfo|null>} [authenticate]
 *   was readAuthInfo. null ⇒ an anonymous caller (not a rejection: the permissions are asked
 *   with authInfo null). A branded apiError(401) rejects a presented credential; any other throw
 *   is an infrastructure failure ⇒ 503.
 * @property {(yhub, authInfo) => Promise<GlobalPermissionsV1|null>} [getGlobalPermissions]
 * @property {(yhub, resourceIds: Array<PermissionResourceId<S>>, authInfo) => Promise<Array<{ resource, permissions: ToPermissionType<S>|null }>|null>} [getOrgPermissions]
 *   likewise getBranchPermissions, getDocumentPermissions: `{ resource, permissions }` for each
 *   resource, in the order given, none skipped - entry i names resourceIds[i] (yhub checks it),
 *   and its permissions are the input form of the scope, whose own `type` literal must match it.
 *   null ⇒ deny (a resource's permissions, or the whole list). Deny is a value, never a throw. A
 *   throw is an infrastructure failure: REST and the ws upgrade answer 503 (a branded apiError
 *   passes its status through), a ws recheck disconnects 1013 (transient), never 4401. A plugin
 *   composed of layers (inferred baseline + refinement queries) MUST throw when any layer fails -
 *   never return a partial composition.
 * @property {(yhub, resourceIds: Array<PermissionResourceId<S>>, required: ToPermissionType<S>, authInfo) => Promise<Array<PermissionResourceId<S>>|null>} [filterAuthorizedDocuments]
 *   likewise filterAuthorizedOrgs, filterAuthorizedBranches - the batch check: the resources of
 *   `resourceIds` that hold `required`, compared by value, in any order (null: none). Must agree
 *   with the getter - a resource is listed iff
 *   hasPermissions(normalize(getDocumentPermissions([resource])[0].permissions), required) -
 *   which is the `AuthPlugin` default, asking the getter about the whole list at once.
 */
// deferred (§10): the enumeration hook `listDocuments`
```

The plugin is a subclass of the exported class **`AuthPlugin`**, configured as `conf.auth` and
instantiated at startup with the yhub instance as **`yhub.auth`**: the same functions without the
`yhub` argument (`this.yhub` instead). yhub's gates call it directly, and so do custom endpoints
and plugins. `AuthPlugin` carries the defaults — `authenticate` answers anonymous, every getter
throws `Method unimplemented` (a deployment answers the scopes it serves; a route of another
scope is a 500), every filter asks its getter. `createAuthPlugin` builds the subclass from a
definition, defining a method only for each member given (the rest fall through to the
defaults), each bounded by the timeout, checking every answer and resolving to **normalized**
permissions. It is the recommended way, and the only one yhub's own code uses. Extending
`AuthPlugin` by hand (`class Auth extends AuthPlugin { async getDocumentPermissions (docRefs,
authInfo) { … } }`) is the documented alternative, and it skips those guards: the override is
called as written, so it answers normalized permissions itself.

**Batch checks.** The filters answer a question about many resources at once — "which of these
documents may the caller read?" — with the subset that holds one requirement, never the
per-resource permission objects (the bulk refinement of §10, narrowed to one requirement: a
backend can then answer it with one query, translating the requirement into it). The answer is
compared by value, so a plugin may build it from its query's rows; an entry yhub did not ask
about is ignored. The definition doubles as the default (`AuthPlugin`'s) — the plugin's own
getter over the whole list plus `hasPermissions` — which costs what that getter costs: one call,
so a getter answering its list from one query makes it fast. A plugin defines a filter only for a
cheaper check than the permission objects. The consumer so far is `GET /updated/v1/{org}`,
which asks `filterAuthorizedDocuments` once per page for ydoc `r` of every candidate.

One function per question and scope: each is fully typed by its scope (resource parameter,
*forced* answer type `ToPermissionType<S>`) — a single `(scope, resourceId, user)` function
couldn't be, since TypeScript cannot correlate a runtime check of `scope` with the return type
inside one body. We believe a concrete function per scope avoids mistakes: a document grant can't
answer an org question, and a scope is answered only where it is defined. A getter takes a list
of resources and answers `{ resource, permissions }` per resource, in order, none skipped — each
permission object visibly tied to its resource — so a plugin answers a batched question from one
backend query; yhub asks for one resource per REST request / ws upgrade / recheck today:

```js
getDocumentPermissions: async (yhub, docRefs, authInfo) => {
  const grants = await lookupDocPermissions(authInfo, docRefs) // aligned with docRefs
  return docRefs.map((docRef, i) => ({ resource: docRef, permissions: grants[i] }))
}
```

Every answer passes the class `createAuthPlugin` builds (`src/auth.js`): a list answer whose
length differs from the list's, or whose entry names another resource than the one at its
position, throws (REST 500); a permissions object whose `type` is a well-formed but unknown
literal (a future version) is denied whole with a warning (`isKnownPermissionsType`); every
other non-null answer is validated against its scope's permission schema — an invalid or
wrong-scope object throws a loud, descriptive error (REST 500, logged), never a silent denial —
and `null` **stays `null`**: nothing fabricates a permission object. `req.permissions` and a
connection's view are therefore nullable, and `hasPermissions(null, ..)` is false, so every gate
answers the same `missing-permission` 403.

**Anonymous callers.** `authenticate` → `null` is an identity ("nobody"), not a rejection; yhub
never answers 401 for a missing credential — a plugin rejects a *presented* credential with a
branded `apiError(401)`, and a custom handler that needs an identity checks `req.authInfo`
itself. One built-in rule: **writing the document needs an identity**, because attributions
carry the userid. Where an anonymous caller *holds* ydoc `u` and tries to use it, the answer is
401 (`code: 'unauthenticated'`) — after the permission check, so a caller without `u` gets the
ordinary 403: `PATCH /ydoc` with an `update`, `POST /rollback`, and the ws upgrade (an anonymous
socket never holds `u`, so the per-message write gate needs no identity check; the recheck keeps
the invariant since a newly granted `u` differs from the stored mask). Reads, presence, history,
prune, and delete (`by: null`) work anonymously when granted. Named versions are attributed too:
writing one (`POST`/`PUT`/`PATCH /version`) answers 401 to an anonymous caller, deleting one doesn't.

Determinism contract: the getters must be deterministic per `(scope, resource, authInfo)` between
upgrade and recheck — a plugin computing wall-clock-relative bounds (`from: now - 30d`) at call
time makes every recheck compare unequal and flap connections. Compute such bounds when the
assignment is *stored*, not when it is read. Note the flip side: permissions derived purely from
the frozen `authInfo` object (e.g. token claims) re-derive identically forever, so plain rechecks
cannot revoke them — revoke via `recheckAuth({ forceDisconnect: true })` plus short token
lifetimes, or consult a revocation list inside `getDocumentPermissions`.

The module (`src/permissions.js`, importable as `@y/hub/permissions`) exports: the creators
`createPermissions(scope, facets)` / `createDocumentPermissions` / `createBranchPermissions` /
`createOrgPermissions` / `createGlobalPermissions` (prototype-free input-form objects — the one
spelling of hand-written answers and of requirements; also exported from `@y/hub`); the `CRUD` mask
vocabulary (`$crud` — exactly the 16 masks — with `crudUnion`/`crudIntersect`); the input-form
schemas `$documentPermissionsV1` / `$branchPermissionsV1` / `$orgPermissionsV1` /
`$globalPermissionsV1` / `$permissions` (the `DocumentPermissionsV1` typedef is derived from the
schema — one source of truth); the merges `documentPermissionsUnion` / `documentPermissionsIntersect`;
`sanitizePermissions` (the boundary for externally-read input); `normalizeDocumentPermissions` /
`normalizeBranchPermissions` / `normalizeOrgPermissions` / `normalizeGlobalPermissions` returning
the prototype-less normalized views; `isKnownPermissionsType`; and
`endpointPermission(normalized, name)` — the one lookup that isn't a single char compare (the
`'*'` fallback, with an explicit `'----'` entry blocking it). Facet checks need no helpers:
`perms.ydoc[1] === 'r'`.

## 8. REST endpoints

The `endpoint` facet is the successor of `accessPurpose` (which is deleted), renamed from `rest` —
it gates **every** rest endpoint, builtin and custom alike, before the handler runs. The two-gate
model is a plain AND: the endpoint entry answers "may this subject call this route", and the
semantic facets answer "may it touch this data" — checked *inside* the handlers (builtins check
the facets they use; a custom handler that reads or writes the document checks `req.permissions`
itself). Registration **refuses custom endpoints reusing a builtin name** in any version — one
name in the facet must mean one route family; the previously blessed custom
`name: 'ydoc', version: 'v2'` pattern is withdrawn (breaking; amend API.md). The websocket route
is the endpoint named `ws`: its `r` opens the socket (next to ydoc `r`), its `u` admits doc
updates over it (next to ydoc `u`) — resolved through `'*'` like any name, so a grant without any
`endpoint` entry opens no socket. Presence broadcasts stay on awareness `u` alone (unlike the
awareness field of `PATCH /ydoc`, which sits behind that route's `u`).

An entry is a plain CRUD mask:

- Which of the endpoint's methods may be called follows the verb class of each method, derived
  from its HTTP verb (`get` → `r`, `post` → `c`, `put`/`patch` → `u`, `delete` → `d`). The
  mapping is fixed — crud maps onto the REST verbs exactly, so there is no per-method override
  (a class-override knob was considered and dropped). A method is callable iff its class
  position is set in the effective mask.
- `'*'` is the fallback entry for names not listed (`endpointPermission`: named entry, else
  `'*'`, else `'----'`). An explicit `'----'` (or `false`) entry blocks the fallback. The merges
  resolve every name through the fallback before combining, and normalization drops entries
  equal to the effective fallback — one spelling per map.
- The **`context` payload** of earlier drafts (an opaque per-entry value forwarded to the
  handler) was **dropped** with the simplified rewrite. Endpoints needing per-subject data
  beyond a mask must obtain it themselves (e.g. from `authInfo`); if a real need for a forwarded
  payload appears, it returns as a separate proposal.

Endpoint scopes follow the tiers: `scope: 'document'` (the default; routes carry `?branch=` and
address a document on a branch, gated by the doc permissions' `endpoint` facet — one spelling
with `getDocumentPermissions`, see naming.md); `'org'` and `'global'` exist as today; a
`'branch'` scope (docless routes spanning the branch's documents) is deferred until its route
shape is decided — branch is a query parameter, so a branch route would collide with the org
route.

**There is no framework-side baseline beyond the endpoint entry.** An earlier draft added a
per-method `requires: 'r' | 'u' | null` check against the ydoc mask; it was dropped — the
framework checks exactly one thing (the endpoint entry), and a handler that touches the document
validates the relevant facets on `req.permissions` itself. The cost is deliberate:
`endpoint: { '*': 'crud' }` plus a handler that checks nothing admits any authenticated subject
to that handler — grant `'*'` narrowly and write the facet check where the document is read.

Request object: `accessType` is replaced by `req.permissions` (the normalized view of the
route's scope, or `null`). Handlers state their requirement with one call —
`checkPermissions(req.permissions, createDocumentPermissions({ ydoc: '-r--' }))`; the
requirement is a permission object of the route's scope, written with the creators — and the
framework's endpoint gate is the same call with `createPermissions(scope, { endpoint: { name:
mask } })`. 403 bodies name the whole requirement:
`{ error: 'requires permission {...}', code: 'missing-permission', required }`.

Builtins, rewritten: `GET /ydoc` — ydoc `r` (+awareness `r` for `?awareness=true`, +`history.from
=== 0` for `?gc=false`); `PATCH /ydoc` — ydoc `u` for updates (which also creates the document on
that branch when absent — v1 creation semantics, §3), **checked before the first
`stream.addMessage`** (§9), awareness `u` for the awareness field (dropped without it, as on the
socket); `DELETE /ydoc` — `delete`
contains `'soft'`/`'hard'`; `POST /rollback` — `history.rollback` + range containment;
`POST /prune` — `history.prune` + range containment; `changeset`/`activity` — history granted,
clamped (named versions ride along on `activity` when `history.version` `r` is granted, and
`?versions=true` without it is refused); `version` — `history.version` `r` clamped, `c` (POST),
`u` (PATCH, a conditional update), `c`+`u` (PUT, create or replace) and `d` with the version's `t`
contained in the ray; `history.publish` to set `published` (ignored without it) and to write a
published version (refused without it).

## 9. Enforcement invariants

Rest enforcement has one primitive: **containment**. `hasPermissions(granted, required)` decides
`required ⊆ granted` in the merge algebra — the intersection of the two normalizes to exactly
the (normalized) requirement — and `checkPermissions` is its throwing form (the uniform
`missing-permission` 403). `granted` is the normalized view the request or connection already
holds (or `null`, which contains nothing); validation happens at the two boundaries only — the
plugin answer in the funnel and the code-authored fragment — while the requirement and the
intersection are built unchecked, the merges being closed over valid input. A handler states its whole requirement as one permission object at
its head; the algebra supplies the semantics per facet: crud subsets, ray containment on
`history.from` (changeset/activity limit the query's `from` to the granted ray first and require
exactly that `history: { from }`), `delete` subsets, `'*'`-resolved endpoint entries. Two guardrails keep the primitive honest as a security check: requiring
`history.rollback`/`prune` implicitly also requires ydoc `u` (the requirement-side mirror of
implication normalization — otherwise normalizing the requirement would silently *drop* the
boolean), and a fragment naming a facet the scope's schema doesn't know throws instead of
checking less than the caller wrote. Hand-rolled char compares remain only on the ws hot path
(per-message gates, upgrade, recheck).

These are the rules that keep the granular model sound; each has a concrete exploit without it:

1. **Clamp before the cache key.** The clamp (`from = max(query.from ?? 0, history.from)`;
   absent `to` becomes `MAX_SAFE_INTEGER` — activity's existing encoding) returns plain numbers
   whose output feeds *both* the compute-pool args *and* `cacheArgs` in `changeset`/`activity`, with one
   numeric cache-key encoding across both endpoints (changeset currently stringifies absent
   bounds as `'null'` — its compute contract keeps `null`, mapped back at the compute-pool call
   only, never in the key). Clamping after key construction lets a bounded user hit the
   unbounded user's cached full history. `history: false` ⇒ 403 before `stream.cachedGet` is
   touched.
2. **`gc=false` requires full history** (`history !== false && history.from === 0`) at the ws
   upgrade and `GET /ydoc` — explicit 403, not a silent gc=true downgrade. The nongc doc *is*
   the full history; a bounded ray is unenforceable on it.
3. **Reads clamp, mutations refuse.** Rollback and prune require their boolean AND requested range
   ⊆ granted ray — 403, never a silent clamp (silently clamping a mutation turns "rollback to
   yesterday" into "rollback to 9am"). The requested range starts at `body.from ?? -∞`,
   **independent of the other filters**: `by`, `contentIds`, and `withCustomAttributions` select
   content from any time, so a filter-only rollback/prune has an unbounded requested range and is
   refused for any bounded-ray subject (403 naming the missing unbounded history). There is no
   separate rollback bound (add one beside the boolean later if a real need appears).
4. **Multiplex atomicity.** `PATCH /ydoc` checks ydoc `u` before the first `addMessage` (today it
   publishes the update before the awareness write — in-handler sequential checking would
   half-apply). A refused update ⇒ whole request 403, the awareness leg included. The awareness
   leg itself is never a refusal: without awareness `u` it is dropped and the update still lands,
   matching the ws case-1 gate (5.). Same invariant documented for custom handlers: all checks
   before the first side effect.
5. **Per-type ws gates.** The blanket `if (!user.hasWriteAccess) return` in `message` splits:
   case 0 needs ydoc `u` and endpoint `ws` `u`, case 1 needs awareness `u` — read-only
   connections can finally broadcast cursors when granted. Fan-out: awareness relayed only when awareness has `r` (one
   char compare per batch in `onStreamMessage`, plus the initial awareness send in `open`).
6. **Recheck compares the ws-relevant leaves only.** The connection stores its normalized view
   (on the `WSUser`, next to `userid`); recheck recomputes and compares exactly the leaves the
   socket consumes: the `ydoc` mask, the `awareness` mask, the effective `ws` endpoint mask, and
   — for `gc=false` connections — whether `history.from === 0` still holds. Any difference ⇒
   close 4401 (downgrades *and* upgrades: the frozen view must not silently widen), plugin throw
   ⇒ 1013. REST-only facets (`delete`, `rollback`, `prune`, `version`, `publish`, the other `endpoint` entries) never
   bounce live connections; bounded-ray tweaks
   never bounce `gc=true` connections. (An interned ws projection was designed and dropped — the
   per-connection view is small and a plain three-leaf compare is simpler than any sharing
   scheme.)
7. **History grants attributions, not content reconstruction.** `changeset`/`activity` with
   `?ydoc=true` or `?delta=true` render the document as it stood at `to` from a time-0 baseline —
   content from before any granted ray. Those two flags therefore additionally require ydoc `r`;
   the history ray bounds the *attributions*, never the rendered content snapshot. Without this
   gate, an "audit-log reader" (`history` granted, `ydoc: '----'`) reconstructs the entire
   document.

## 10. Deferred: bulk checking and v2 multi-doc sync

**Not part of v1** — recorded so v1 shapes stay extension-compatible. The problem: "sync all docs
I have access to" must not cost one `getPermissions` per document — millions of documents,
millions of calls. Three mechanisms, in order of preference (note how naturally the
branch-above-doc ordering serves this: a v2 connection syncs *the documents of an org on one
branch*, which is exactly a branch-floor question):

1. **Floors.** `getPermissions(authInfo, {org, branch})` returns `BranchPermissions` extended
   with a `docs` floor authorizing every document it covers on that branch — one call for a
   thousand docs (the full deferred floor chain is `global.orgs → org.branches → branch.docs →
   doc facets`). A v2 connection (`/ws/v2/{org}?branch=`) fetches it once at upgrade; documents
   whose required facets the floor grants attach with zero further calls. (Floors are the
   additive extension deliberately absent from v1, §4.)
2. **Bulk refinement** — shipped as `filterAuthorizedDocuments` (§7). Documents not covered by
   the floor go through one `filterAuthorizedDocuments(docRefs, required, authInfo)` call for the
   whole subscribe list, `required` being the facets a synced document needs (backed by one SQL
   query in the tag store, or one `CheckBulkPermissions` in a SpiceDB-backed plugin). It answers
   the subset, not per-document permissions: should the attach need the documents' views (the
   recheck compares them), that is one more hook.
3. **Enumeration.** `listDocuments(authInfo, org, cursor)` answers "which documents at all" —
   paginated, because 100k-doc orgs are real. The tag store implements it with a single indexed
   query (§11); a future `OrgPermissions.enumerate` facet gates whether a subject may use this
   mode at all.

Per-document revocation in v2 detaches *that document* (an `unsub` frame carrying the 4401
semantics) instead of closing the connection.

## 11. Deferred: the tag store — `auth*` on our own primitives

**Not part of v1** (the plugin interface it implements is, so it can ship later without breaking
anything). An optional built-in module — the batteries-included answer for apps that don't run an external
authorization system. Precedent: this architecture is the composition of Zanzibar's **Leopard
index** (flattened set-intersection membership), **AWS ABAC** (principal tags × resource tags), and
**Discord** (tags carrying permission sets, merged in fixed layers). See prior-art §"tags".

Model:

- **Subjects carry tags**: `authInfo.tags: Array<string>` — flat strings, e.g. `u:kevin`,
  `g:design`, `org:acme`, `*` (every authenticated subject). Computed at login/token time or via a
  cached server-side lookup. Tags are **flat**: no nesting inside yhub — group hierarchies are
  flattened *before* the tag set reaches us (Leopard's lesson: flattening is the hard part, and it
  belongs to the system that owns the group graph; Entra's 200-group token overage is the wall to
  respect — keep tag sets small, AWS-style "few tag keys" discipline).
- **Documents carry assignments**: rows in a new table

  ```sql
  CREATE TABLE yhub_permission_assignments_v1 (
    org      text NOT NULL,
    docid    text,        -- NULL = branch- or org-level assignment
    branch   text,        -- NULL = org-level assignment (with docid NULL)
    tag      text NOT NULL,
    layer    text NOT NULL DEFAULT 'grant',   -- 'grant' | 'restrict' | 'override'
    perms    jsonb NOT NULL,                  -- input-form permissions (validated on write)
    UNIQUE NULLS NOT DISTINCT (org, docid, branch, tag, layer)  -- PG 15+; PK columns cannot be NULL
  );
  CREATE INDEX ON yhub_permission_assignments_v1 (org, tag, docid);
  ```

  Row shapes are unambiguous by scope, following the ladder: org-level rows (`docid IS NULL AND
  branch IS NULL`) store an `OrgPermissionsInput`; branch-level rows (`docid IS NULL, branch
  set`) a `BranchPermissionsInput`; doc-level rows (both set) a `DocumentPermissionsInput` — each
  validated as such on write. (A row with `docid` set and `branch NULL` — "this document on every
  branch" — is not a scope object; it is reserved as a wildcard that merges below doc rows, and
  is rejected until specified.) Global-scope rows use the sentinel org `''` (an org id yhub
  rejects otherwise) and store a `GlobalPermissionsInput` — without them the `{}` selector could
  never match a row and the zero-match rule would deny every global-scoped endpoint outright. A
  doc check merges, per layer, the org row's `branches.docs` floor below the branch row's `docs`
  floor below doc rows.
- **Check** (`get[Scope]Permissions(yhub, resourceIds, authInfo)`): fetch the resource's own and
  its ancestors' assignments whose `tag ∈ authInfo.tags` — one indexed query, redis-cached per
  `(org, docid)` with `cacheTtl` + explicit invalidation — then merge: union within each layer
  (tombstone wins ties), refine `grant → restrict → override`, coarser scope below finer scope
  within a layer. O(few) cached lookups per check, no external calls. **Zero matching
  assignments ⇒ `null`** (deny outright, defaults never applied — the §6 null-guard); `{}` is what
  an assignment with an empty perms object produces, and *that* receives defaults.
- **Enumeration** (`listDocuments`): `SELECT DISTINCT docid FROM ... WHERE org = $1 AND
  tag = ANY($2) AND docid IS NOT NULL` (keyset-paginated over the `(org, tag, docid)`
  index), short-circuited by an org-level row granting `ydoc ⊇ 'r'` in its floor — then
  enumeration comes from `yhub_ydoc_v1` directly (`Persistence.listDocids(org)`, a new
  keyset-paginated primitive). One or two indexed queries for "everything I can access", zero
  per-doc calls. This is the Postgres-RLS/Elasticsearch-DLS pattern, and the strongest argument
  for tags over graph-walk designs: Zanzibar itself cannot enumerate cheaply and had to bolt
  denormalized search indexes beside it. Enumeration is an **overapproximation**: restrict-layer
  tombstone rows and endpoint-only rows also match the tag query, so a listed document may still
  deny on attach — the per-document permission evaluation remains the authority (deny ⇒ unsub),
  the listing is only the candidate set.
- **Writes** go through yhub (`yhub.assignPermissions(selector, tag, layer, perms)` /
  `yhub.unassignPermissions(...)`, plus admin REST endpoints later): validate the input-form perms
  against the selector's scope, write the row, bust the redis cache for the affected keys, and
  call `recheckAuth(docRef)` — revocation reaches live connections through the existing
  `auth:check:v1` flow. Subject-tag changes are the identity provider's business: token refresh
  plus `recheckAuth(docRef, { users })` with the existing matcher.
- **Staleness contract**: cached assignments are stale up to `cacheTtl` unless explicitly
  invalidated by a write-through; document the bound (Leopard ships bounded staleness too). All
  writes through yhub are invalidated immediately.

Open issue: an org- or branch-level assignment change should recheck *every active document* it
covers; that needs enumeration of active documents (e.g. a redis SCAN over the org's stream-key
prefix). Cheap enough for an administrative operation, but it needs a decided mechanism before
implementation.

What tags deliberately cannot do: relationships. There is no ownership chain, no folder
inheritance, no `viewer = editor ∪ parent#viewer` — with one planned exception: **subdocument
inheritance** (naming.md) follows the parent-document chain, which is a single bounded walk, not a
general graph. Apps that need real relation graphs use a Zanzibar-backed plugin instead (§13); the
plugin interface is the same.

## 12. Migration

- The old `AccessType` world maps directly onto masks. The mapping is documentation — no compat
  helper ships; migrating plugins write the objects literally where the getters replace
  `getAccessType`. Doc scope: `'rw'` → `{ type: 'permissions:document:v1', ydoc: 'cru-',
  awareness: '-ru-', history: { from: 0 }, endpoint: { '*': 'crud' } }`, `'r'` → the same with
  `ydoc: '-r--'` **and `endpoint: { '*': '-r--' }`**, `null` → `null`. Branch/org/global scopes
  (endpoint-only in v1): `'rw'` → `{ type: 'permissions:<scope>:v1', endpoint: { '*': 'crud' } }`,
  `'r'` → the same with `endpoint: { '*': '-r--' }`, `null` → `null`. The `'r'` rows grant only
  the GET verb class — the old rule required `'rw'` for every non-GET method at every scope, and
  a `'crud'` fallback for `'r'` would silently widen every non-GET route to read-only
  subjects. Deliberately excluded everywhere:
  `rollback`, `prune`, `delete` — destructive permissions are opted into by name (compose with
  `documentPermissionsUnion`).
- Deleted: `$accessType`, `hasReadAccess`/`hasWriteAccess`, `getAccessType`,
  `getOrgAccessType`, `getGlobalAccessType`, `accessPurpose`, `req.accessType`. Renamed:
  `readAuthInfo` → `authenticate` (unchanged semantics) — the plugin reads `authenticate`,
  `get[Scope]Permissions` and `filterAuthorized[Scope]` (the batch checks were added later, §7).
- Renamed throughout code and docs per naming.md: the `Room` triple → `DocRef` addressing
  (`docid` and `branch` stay), `reqToRoom` → `reqToDocRef`, `req.room` → `req.docRef`, log
  fields. **Deferred**: the stream-key spelling `{prefix}:room:` → `{prefix}:doc:` (and with it
  the `encodeRoomName`/`decodeRoomName`/`encodeQuarantineName` helper names) — respelling live
  redis keys orphans in-flight stream entries on a rolling deploy; it needs a drain/dual-read
  migration of its own. `deleteDoc` keeps its name — it deletes the document on that branch. (A
  cross-branch delete cascade arrives with the deferred extensions.)
- Read-preset apps gain cursor broadcasting for viewers (awareness `-ru-` in the `'r'` mapping) —
  today's swallowed-awareness behavior is gone deliberately.

## 13. Zanzibar interop

The plugin route is unchanged by the tag store: a SpiceDB/OpenFGA-backed plugin implements
`getDocumentPermissions` as one `CheckBulkPermissions`/`BatchCheck` over the facet-permission
vocabulary on `doc` objects (`ydoc_read`, `ydoc_write`, `awareness_read`, `awareness_write`,
`history_read` (+ caveat for the window), `rollback_doc`, `prune_doc`, `delete_soft`,
`delete_hard`, `endpoint_call` with `{name}` condition context) and, once the deferred extensions
land, creation/branch-wide permissions on `branch` objects with `doc#branch@branch` /
`branch#org@org` parent relations carrying the floors; it assembles the permission object and
keeps ZedToken/`at_least_as_fresh` handling internal; `Watch`/`ReadChanges` drives `recheckAuth`.
`filterAuthorizedDocuments` is the same bulk RPC over the docs for the facets `required` names;
`listDocuments` is `LookupResources`/`Streamed ListObjects` per facet — with the documented caveat
that reverse lookup is the expensive direction there, which is exactly why the tag store exists
for deployments without a Zanzibar.

## 14. Open questions

1. ~~Window direction~~ — resolved: the history restriction is a **from-ray** (`false | {from}`);
   a `to` permission bound has no product use-case and stays a query parameter (§3).
2. ~~Unbounded sentinel~~ — resolved: none exists. `from` is a plain unix-ms int; `0` (the
   epoch) is full history. (`history: true` sugar for `{ from: 0 }` was considered and rejected —
   the schema stays strict: `false | { from, rollback?, prune?, version?, publish? }`, one spelling per grant.)
3. ~~Context merge semantics~~ — moot: the endpoint `context` payload was dropped with the
   simplified rewrite (§8).
4. **Org-/branch-wide recheck** enumeration of active documents (§11).
5. **`enumerate` vs `endpoint`** (deferred with §10): should enumeration be an org *facet* or a
   builtin org-scoped endpoint gated by the endpoint axis? Facet proposed because v2 ws sync
   consumes it outside any REST route.
6. ~~The middle tier's name~~ — resolved: **document** (naming.md).
7. **Subdocument inheritance mechanics** (naming.md): walk-at-check vs flatten-on-link, and how
   enumeration includes inherited access.
