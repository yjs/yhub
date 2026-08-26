# Naming

Status: decided for the tier names (org / **document** / branch; "room" retired; permission
ordering **global → org → branch → doc**); the subdocuments concept (§5) remains a sketch. Names
the content hierarchy that [permissions.md](./permissions.md) builds on.

## 1. The hierarchy, and what was wrong

The database addresses content as `/{org}/{docid}/{branch}` (branch default `main`): a yhub
instance holds **orgs**, an org holds **documents**, a document's content exists per **branch**.
Two terms were broken, and one ordering:

- **"room"** conflated tiers: sometimes it meant the document, sometimes the
  `{org, docid, branch}` triple a websocket attaches to. The sync unit is precisely *a document
  on a branch*, so "room" disappears: the triple is a **`DocRef`** (`{org, docid, branch}` —
  `docid` and `branch` stay the field names, the ref is the full address), and everything
  room-named follows (`$room` → `$docRef`, `reqToRoom` → `reqToDocRef`, log fields). The stream
  keys `{prefix}:room:…` → `{prefix}:doc:…` are the one **deferred** piece: respelling live redis
  keys orphans in-flight entries on a rolling deploy, so the data-plane rename ships separately
  with a migration story (see §6).
- **"resource"** (the provisional tier name during design) is generic to the point of
  meaninglessness — worse, it was doing double duty: in authorization prose, *everything* is a
  resource (an org is a resource, a doc is a resource). "Resource" keeps exactly that abstract
  role in specs; the tier is concretely named **document**.
- **The permission ordering inverts the storage nesting.** Although the database nests branches
  under documents, *conceptually* a branch is something that spans many documents — like a git
  branch spans the whole tree — and a future v2 connection syncs "the documents of an org on one
  branch". The permission ladder is therefore **global → org → branch → doc → facet**: the leaf
  a permission check cares about is a document (on a branch), and the leaf type is
  `DocumentPermissions` — far easier to comprehend when checking access to facet content than a
  "BranchPermissions" would be.

## 2. Vocabulary for the five permission levels

To keep permissions.md unambiguous, one word per concept:

| word | means | examples |
|---|---|---|
| **scope** (or tier) | a level of the permission ladder | `global`, `org`, `branch`, `doc` |
| **facet** | a key inside one permission object | `ydoc`, `awareness`, `history`, `delete`, `endpoint` |
| **attribute** | a leaf inside a facet | `access`, `from`, `rollback`, `context` |
| **layer** | a rung of the merge ladder | `defaults`, `grant`, `restrict`, `override` |
| **floor** | a coarser scope's object nested in a finer question (deferred) | `org.branches`, `branch.docs` |

"Layer" is reserved for the merge ladder only — the scope chain is never called layers, avoiding
the collision that already crept into earlier drafts.

## 3. The content tier: document (decided)

Candidates that were weighed for the `org/docid` tier:

| name | for | against |
|---|---|---|
| **document** ✓ | matches the existing `docid`, `yhub_ydoc_v1`, `getDoc`; matches Yjs's own **subdocuments** concept (§5 becomes literally natural); smallest migration — `docid` stays in routes, params, and columns | the container/content distinction leans on convention: **document** = the addressable unit, **ydoc** = the CRDT content facet inside it — accepted deliberately |
| repo | git-native | a full rename (`docid` → repo everywhere); heavy for "one shared doc" — and the ordering decision (§1) reassigned the repo role to the *org* anyway |
| resource | maximally general | generic; collides with the abstract authorization sense |
| project / space / workspace | fit composites or orgs | wrong tier or too heavy for the common case |

**Decision: `document`.** The identifier `docid` and the existing API surface stay.

Concretely:

- Addressing: routes keep `/{apiPrefix}/ydoc/v1/{org}/{docid}?branch=`;
  `DocRef = { org, docid, branch }`.
- Permission types: leaf `DocumentPermissions` / `'permissions:document:v1'` (full facet
  vocabulary); above it `BranchPermissions` / `'permissions:branch:v1'` (`{org, branch}`,
  endpoint-only in v1), `OrgPermissions`, `GlobalPermissions`. Deferred floors:
  `global.orgs → org.branches → branch.docs → doc facets`.
- The word "doc" survives informally and in `ydoc`, which unambiguously names the CRDT content
  facet of a document.

## 4. The git analogy — where it holds, where it deliberately breaks

With the branch-above-doc ordering the analogy is: **org ≈ repository** (the branch namespace
lives here), **branch ≈ branch** (it spans the org's documents like a git branch spans the whole
tree; `main` is the default), **document ≈ file** — except that yhub's "files" are individually
addressable, individually synced, and individually *permissioned*: the permission unit is the
document, which is strictly finer than git's repo-granularity access. Inside one document the
git rule holds: you have access to all of a document's content or none of it (no per-paragraph
ACLs — partial-doc sync doesn't exist in `@y/y`, established in permissions.md).
History/changeset/rollback ≈ log/diff/revert.

Deliberately breaks: **subdocuments** (§5) inherit permissions and cascade deletion — git has no
equivalent (submodules do neither). The analogy guides the branching vocabulary, not the linking
model; subdocuments behave like Notion subpages, not submodules.

## 5. Subdocuments (sketch — not yet committed)

The idea: a document may contain **subdocuments** — links to other documents that make them part
of one project (Yjs precedent: `Y.Doc` subdocuments, lazily loaded child docs). Wanted semantics:
subdocuments *inherit permissions* from the parent, and deleting the parent deletes them. This is
how finer-grained structure (separate "files" of a project) is achieved without breaking the
document-granularity permission rule: promote the part to its own document — its own permission
unit — and link it.

Proposed shape, to make the semantics precise enough to critique:

- **Containment, not reference.** A subdocument link is a *containment* edge: each document has at
  most one `parent` (nullable) — documents form a forest, cycles are refused at link time (walk to
  root). A document may also *reference* another document (a plain link in doc content) with no
  permission or lifecycle effect; only containment inherits and cascades. Conflating the two is
  the classic trap (git submodules, symlink cycles) — keep them distinct from day one.
- **Inheritance = ancestor floors.** The parent chain slots into the (deferred) scope-floor
  scheme: effective `DocumentPermissions(child)` refines root → … → parent → child *within each
  layer*. A subdocument with no direct assignments behaves as its parent; direct assignments
  refine (including `restrict`-layer tombstones — "this subdocument is admin-only within the
  project").
- **Resolution cost.** The tag store walks the parent chain at check time (bounded depth, chain
  cached per document) rather than flattening tags onto children — prior art (permissions.md §11)
  says flattening's invalidation burden (re-tag the subtree on every move) outweighs a short
  cached walk. A Zanzibar-backed plugin gets this for free (`doc#parent` arrow relations —
  inheritance is where graph-walk systems shine).
- **Enumeration.** "Everything I can access" must include inherited access: materialize a `root`
  (or path) column per document, so the candidate query extends to `WHERE root IN (documents my
  tags reach)` — one more indexed disjunct, still no per-document calls. Maintained on link/move
  (subtree update), which is also the moment to `recheckAuth` the subtree and bust caches.
- **Lifecycle.** Deleting the parent tombstones the containment subtree (subdocuments included);
  moving a subdocument between parents changes its inherited permissions and triggers the same
  recheck path. Branch semantics of a subdocument are its own (it is a full document).

Open questions before this graduates into permissions.md: single- vs multi-parent (the forest
restriction is what keeps resolution and cascade tractable — is it acceptable product-wise?);
whether v2 sync auto-subscribes a document's subdocuments or the client subscribes each; whether
creating a subdocument is a parent-side right or just creation plus a link write; and how deep
chains are allowed to grow (a hard depth cap keeps the walk honest).

## 6. Rename inventory

The full rename set (breaking, one release):

| old | new |
|---|---|
| room (concept) | a document on a branch (the sync unit) / `DocRef` (the `{org, docid, branch}` triple) |
| `$room`, `Room` typedef | `$docRef`, `DocRef` |
| `reqToRoom` | `reqToDocRef` |
| stream keys `{prefix}:room:{org}:{docid}:{branch}` | `{prefix}:doc:{org}:{docid}:{branch}` — **deferred** (data-plane; needs a drain/dual-read migration). The key-builder names `encodeRoomName`/`decodeRoomName`/`encodeQuarantineName` keep their spelling until the keys flip |
| `docid`, `branch` (params, columns, routes) | **unchanged** |
| `deleteDoc(room)` | **name unchanged** — `deleteDoc(docRef)` already says what it does (deletes the document on that branch); a document-wide (all branches) cascade arrives with the deferred extensions |
| `Persistence.listDocids(org)` | unchanged; plugin enumeration hook is `listDocuments` |
| capabilities / grant (earlier drafts) | permissions (objects), assignment (stored record), grant/revoke (verbs), check (decision) |
| `RoomCapabilities`, `BranchPermissions` (drafts, leaf) | `DocumentPermissions` (`'permissions:document:v1'`) |
| `ResourcePermissions`, middle-tier `DocumentPermissions` (drafts) | `BranchPermissions` (`'permissions:branch:v1'`, `{org, branch}`, endpoint-only in v1) |
| endpoint `scope: 'doc'` | `scope: 'document'` — the one spelling of the tier across `createApiEndpoint({ scope })`, `authorize(scope, ..)`, and `createAuthorize({ document })` (the type literal stays `'permissions:document:v1'`; `docid`/`docRef` stay); a docless `scope: 'branch'` is deferred (its route shape is undecided: branch is a query parameter) |
| `accessPurpose` | the `endpoint` facet (checked for every rest endpoint) + in-handler facet checks |
| `readAuthInfo` / `getAccessType`, `getOrgAccessType`, `getGlobalAccessType` | `authenticate` / `authorize` — the auth plugin is `{ authenticate, authorize }` |
| `rest` / `restCustom` (draft) | `endpoint` facet (the draft's `context` attribute was dropped — permissions.md §8) |
