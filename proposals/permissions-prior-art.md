# Permissions: prior art

Research notes backing [permissions.md](./permissions.md). Six surveys: Zanzibar-family systems,
realtime-collaboration platforms, capability-token models, tag/label-intersection architectures,
policy-combination semantics, and access-level encodings / bulk enumeration.

## 1. Zanzibar, SpiceDB, OpenFGA

**Model.** Relation tuples `object#relation@subject` (subject may be a userset like
`group:eng#member`); a schema computes **permissions** from stored **relations** — SpiceDB:
`permission view = reader + editor + org->view_all_docs` (arrow = tuple-to-userset); OpenFGA:
`define viewer: [user, team#member] or editor or viewer from parent`. Convention that matters:
app code checks verb-named *permissions* (`view`, `edit`), never noun-named *roles* — roles can
then be reorganized in the schema without touching callers. One named permission per app-level
action.

**Parametrized grants.** Both attach named CEL expressions to tuples — SpiceDB *caveats*, OpenFGA
*conditions* — with context split between write time (bound onto the relationship) and check time
(supplied per request); missing context yields `CONDITIONAL` naming the missing fields. Types:
int/uint/double/bool/string/bytes/timestamp/duration/ipaddress/list/map. This is where a
"history from T" bound lives in a Zanzibar backing — but checks answer booleans, so *reading the
bound's value* requires `ReadRelationships` on the caveated tuple (or a side column): checks never
return values.

**APIs.** `Check`, `CheckBulkPermissions` / `BatchCheck`, reverse lookup `LookupResources` /
`ListObjects` (capped at 1000; `StreamedListObjects` uncapped), `LookupSubjects` / `ListUsers`,
`Expand`, `Watch` / `ReadChanges` (change feed → cache invalidation, recheck triggers).
**Consistency:** SpiceDB implements zookies as ZedTokens (`at_least_as_fresh` defeats the
new-enemy problem without full consistency); OpenFGA has only `MINIMIZE_LATENCY` vs
`HIGHER_CONSISTENCY` — no tokens yet.

**Scale truth.** Reverse lookup is the expensive direction everywhere: AuthZed calls
`LookupResources` heavy beyond ~10k results and prescribes check-filtered pagination or
**Materialize** (a product that maintains a denormalized principal→resource view in *your*
database); OpenFGA's guidance mirrors it. Purpose-built engines refuse unbounded enumeration —
they stream, or make you denormalize.

Sources: [Zanzibar paper](https://www.usenix.org/system/files/atc19-pang.pdf) ·
[zanzibar.tech (annotated)](https://zanzibar.tech/) ·
[SpiceDB caveats](https://authzed.com/docs/spicedb/concepts/caveats) ·
[SpiceDB consistency](https://authzed.com/docs/spicedb/concepts/consistency) ·
[protecting a list endpoint](https://authzed.com/docs/spicedb/modeling/protecting-a-list-endpoint) ·
[AuthZed Materialize](https://authzed.com/docs/authzed/concepts/authzed-materialize) ·
[OpenFGA conditions](https://openfga.dev/docs/modeling/conditions) ·
[OpenFGA ListObjects](https://openfga.dev/docs/getting-started/perform-list-objects) ·
[improved ListObjects algorithm](https://auth0.com/blog/openfga-improved-listobjects-algorithm/)

## 2. The Leopard index — tag intersection is Zanzibar's own fast path

Zanzibar's graph walk struggles with deep/wide group nesting, so Google built **Leopard**:
flattened sets `GROUP2GROUP(ancestor) → {descendant groups}` and `MEMBER2GROUP(user) → {direct
groups}`; a check is `MEMBER2GROUP(U) ∩ GROUP2GROUP(G) ≠ ∅` over ordered skip-list integer sets —
O(min(|A|,|B|)) seeks, ~1.5M QPS, sub-millisecond p99. Freshness: an offline builder periodically
re-materializes shards; an incremental layer ingests timestamped, tombstoned deltas and merges
them at query time. The hard part is the incremental *flattener* (one nesting write fans out into
many index updates), not the check.

The tag-store design in permissions.md is this architecture with permission objects attached to the
intersection result. Related precedents, same shape:

- **AWS IAM ABAC**: policy conditions match `aws:PrincipalTag/k` against `aws:ResourceTag/k`
  (session tags ≤50, resource tags ≤50); marketed as the scaling escape from per-resource RBAC
  policy edits ("applies automatically to future resources"). Discipline to copy: a *handful* of
  tag keys. Notable gap: IAM cannot enumerate ("what can this principal access" needs an external
  scanner) — an indexed reverse query is strictly better.
- **Discord**: roles = tags carrying permission bitsets over 200M+ MAU. Computation: union of role
  bitsets (base) → channel overwrites in fixed layers, each an allow/deny pair: @everyone
  deny→allow, union-of-role-denies→union-of-role-allows, member deny→allow. Production proof of
  layered union+override permission merging — and of its support burden (an ecosystem of
  permission calculators).
- **MAC / security labels** (SELinux MLS/MCS, FHIR HCS): subject clearance vs object label
  compared by set dominance/intersection — decades-old proof that label-set comparison is a sound
  primitive, and that label *assignment governance* is where such systems get hard.
- **Postgres RLS + arrays**: `USING (acl_tags && user_tags())` with a GIN index = the reverse
  lookup as a plain indexed query. Traps: non-LEAKPROOF functions in policies block index use;
  keep per-row tag arrays small; EXPLAIN, don't assume.
- **Elasticsearch/OpenSearch DLS**: role query filters documents by matching a doc `groups` field
  against user groups at query time — ACL-as-filter-terms at search scale; invalidation pushed to
  reindexing when terms must live in the doc.

**Flattening problem (the sore spot).** Token-carried group claims hit walls: Entra ID caps JWT
group claims at 200 then degrades to an overage lookup; flattened claims are frozen for token
lifetime, so revocation waits for refresh unless a server-side cache is authoritative. Leopard's
answer: async rebuild + live delta, bounded staleness. Consequences adopted: tags are flat inside
yhub (nesting is flattened by whoever owns the group graph), tag sets stay small, the cache — not
the token — is authoritative for removals, and staleness is a documented bound.

Sources: [Zanzibar §Leopard](https://www.usenix.org/system/files/atc19-pang.pdf) ·
[AWS ABAC tutorial](https://docs.aws.amazon.com/IAM/latest/UserGuide/tutorial_attribute-based-access-control.html) ·
[principal tags](https://aws.amazon.com/blogs/security/simplify-granting-access-to-your-aws-resources-by-using-tags-on-aws-iam-users-and-roles) ·
[Discord permissions](https://docs.discord.com/developers/topics/permissions) ·
[Entra group overage](https://learn.microsoft.com/en-us/troubleshoot/entra/entra-id/app-integration/get-signed-in-users-groups-in-access-token) ·
[RLS footguns](https://www.bytebase.com/blog/postgres-row-level-security-footguns/) ·
[GIN array indexes](https://www.tigerdata.com/learn/optimizing-array-queries-with-gin-indexes-in-postgresql) ·
[Search Guard DLS](https://docs.search-guard.com/latest/document-level-security)

## 3. Policy combination: how override semantics survive practice

- **XACML**: ~11 configurable combining algorithms; in practice `deny-overrides` is the universal
  default, `permit-overrides` and `first-applicable` (order-as-priority) are the acknowledged
  footguns, and the research literature is largely about detecting the conflicts this flexibility
  creates. *User-selectable combining semantics don't survive; one fixed rule does.*
- **Cloud IAM** (AWS / GCP Deny policies / Azure deny assignments): additive allows + **one
  absolute deny layer** with fixed semantics; nothing re-permits above a deny; Azure won't even
  let users author the top layer directly. None expose numeric priorities.
- **Cedar**: forbid-overrides-permit, no priorities *by design* — every policy readable in
  isolation, order-independent evaluation, SMT-analyzable. Priorities were rejected because they
  destroy local readability.
- **Windows ACLs**: priority-by-ordering (deny ACEs first, canonical order maintained by tools by
  convention) — and the pathology: the kernel honors whatever order exists while every GUI assumes
  canonical, so mis-ordered ACLs behave differently from what tools display. Note Windows *does*
  re-allow across specificity (child explicit allow beats inherited deny).
- **Kubernetes RBAC**: union-only, no deny at all — the most auditable model in the survey;
  "everything except X" is inexpressible and outsourced to admission control. Every bit of
  deny/override you add is where the complexity comes from.
- **Discord / Cerbos**: fixed specificity ladders; same-level tie ⇒ deny.

Adopted: a fixed named ladder (`defaults ⊂ grant ⊂ restrict ⊂ override`), union with
tombstone-wins-tie within a level, refinement across levels, re-grant-above-tombstone allowed
because the tombstone is configuration shadowing (Discord member-allow over role-deny), and — if
guardrails are ever needed — one absolute operator-only deny layer rather than big numbers.
Every layered system eventually shipped an effective-permissions explainer (IAM Policy Simulator,
Windows Effective Access, Discord calculators); plan the debug helper from day one.

Sources: [Cedar semantics](https://docs.cedarpolicy.com/auth/authorization.html) ·
[Cedar paper](https://dl.acm.org/doi/10.1145/3649835) ·
[AWS evaluation logic](https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_evaluation-logic.html) ·
[GCP Deny policies](https://docs.cloud.google.com/iam/docs/deny-overview) ·
[Azure deny assignments](https://learn.microsoft.com/en-us/azure/role-based-access-control/deny-assignments) ·
[ACE ordering](https://learn.microsoft.com/en-us/windows/win32/secauthz/order-of-aces-in-a-dacl) ·
[k8s deny-rules issue #85963](https://github.com/kubernetes/kubernetes/issues/85963) ·
[Cerbos scoped policies](https://docs.cerbos.dev/cerbos/latest/policies/scoped_policies.html) ·
[XACML 3.0](https://docs.oasis-open.org/xacml/3.0/xacml-3.0-core-spec-cd-03-en.html)

## 4. Access-level encodings

- **POSIX `rwx`**: char string = display encoding of a bitset; union/intersection = bitwise ops;
  canonical by fixed letter position. Cautionary tale: the encoding never grew (setuid jammed into
  the `x` slot; real extension needed ACLs).
- **NFSv4 ACLs**: 14 single-char flags; coarse aliases `R`/`W`/`X` *expand* to letter sets — the
  useful trick; also proof that single-char namespaces exhaust fast (`t/T`, `c/C`).
- **Discord/Windows bitsets**: trivially canonical; Discord outgrew 53-bit JS integers (BigInt +
  string serialization, API migration). New verb = new bit, default-deny for old grants — the safe
  default; opaque in logs/JSON, though.
- **Ably**: `{resource: [ops]}` with 18 verbs and `['*']`; token capability = intersection of
  requested and key capability. No canonical ordering of op arrays defined — equality is undefined.
- **AWS IAM actions**: verb strings with wildcards; *no canonical form exists* — comparing
  policies semantically requires an SMT solver (Zelkova/Access Analyzer). Wildcards inside grants
  destroy cheap comparison.
- **Firestore rules**: the versioning headline — `read`/`write` later split into
  `get`/`list`/`create`/`update`/`delete`; coarse verbs survived as aliases for the union of their
  fine verbs. Design coarse verbs as macros from day one.
- **Redis ACLs**: ordered rule lists (`+@geo -@read` ≠ `-@read +@geo`) — order-sensitive encodings
  have no cheap canonical form.
- **Liveblocks**: small colon-namespaced scope arrays with an overlay hierarchy
  (`defaultAccesses ← groupsAccesses ← usersAccesses`, each level replacing the last) — a clean
  overlay precedent; `room:write` implies presence write (an implication baked into the vocabulary).

Adopted: char-flag strings over a **closed** per-facet alphabet, fixed canonical letter order,
schema-validated as literal unions (`s.$union(s.$literal('r'), s.$literal('rw'))`), `===`
comparison; no wildcards inside access values; new verbs are new letters, default-deny; verb
splits keep the old letter as an expanding alias. Rejected: `{read: true, write: true}` objects
(no precedent, worst canonical-equality story), verb arrays (right for many/namespaced verbs,
overkill for ≤5), bitsets (opaque).

Sources: [nfs4_setfacl](https://man7.org/linux/man-pages/man1/nfs4_setfacl.1.html) ·
[Discord PermissionsBitField](https://discord.js.org/docs/packages/discord.js/main/PermissionsBitField:Class) ·
[Ably capabilities](https://ably.com/docs/auth/capabilities) ·
[Firestore rules structure](https://firebase.google.com/docs/firestore/security/rules-structure) ·
[Redis ACL](https://redis.io/docs/latest/commands/acl-setuser/) ·
[Liveblocks permissions](https://liveblocks.io/docs/rooms/permissions) ·
[Zelkova](https://www.amazon.science/blog/custom-policy-checks-help-democratize-automated-reasoning)

## 5. Realtime-collaboration platforms

- **Liveblocks**: room access levels + scoped permissions (`room:write`, `comments:write`,
  presence implied); *id tokens* (identity, permissions resolved server-side per room) vs *access
  tokens* (permissions in the token — capped around 10 room grants per token: the token-size wall
  for per-doc grant lists). Wildcard room patterns (`org1:*`).
- **Ably**: per-channel operation lists in tokens (subscribe/publish/presence/history split —
  presence-send separate from subscribe is the granularity practitioners actually needed);
  attenuation by intersection.
- **Hocuspocus/Tiptap**: auth webhook returning read-only flags; **Y-Sweet**: doc-scoped
  read/write tokens; **Firebase**: declarative per-resource rules over auth context.
- **Figma/Google Docs** (UX prior art): viewer/commenter/editor + link sharing — "commenter" is a
  facet grant (comments-write without doc-write), the exact shape the endpoint/facet split serves.
- Cross-cutting: presence tied to doc-write is a repeated complaint (viewers' cursors); permission
  *changes* propagate by disconnect-and-resync in every surveyed system — matching yhub's
  recheck-then-4401 contract.

## 6. Token/policy grant models

- **OAuth scopes**: flat strings, no resource addressing — insufficient alone.
- **RFC 9396 Rich Authorization Requests**: typed JSON objects (`type`, `actions`, `locations`,
  `datatypes`) — the closest standard to a structured permission object; no subsumption algebra.
- **UCAN** (`with`/`can` + caveats), **Biscuit** (Datalog checks, offline attenuation),
  **macaroons** (conjunctive caveats): attenuation-first designs; the adopted rule from macaroons —
  an unenforceable/unknown constraint must fail closed (drop the grant key), never widen.
- **AWS IAM policy documents**: Effect/Action/Resource/Condition with date operators — the
  precedent for constraints-as-values; also the precedent for what to avoid (wildcard actions,
  uncomparable policies).

## 7. Decisions traced to precedent

| permissions.md decision | precedent |
|---|---|
| facet-keyed permission object, verb-named leaves | Zanzibar permissions-not-roles; RFC 9396 |
| char-flag access strings, closed alphabet, canonical order | POSIX/NFSv4, Discord bitsets, Firestore alias lesson |
| union within layer / refine across named layers | Discord overwrite ladder, Cerbos, Liveblocks hierarchy |
| tombstone-wins-tie within a layer | Discord deny-batch-first, Cerbos tie ⇒ DENY |
| no numeric priorities; optional future operator-only deny layer | XACML/Windows pathologies; AWS/GCP/Azure deny layers; Cedar rationale |
| unknown keys warn+drop (fail closed per key) | macaroon caveat rule |
| tag store: user tags ∩ resource assignments, indexed reverse query | Zanzibar Leopard, AWS ABAC, Postgres RLS, ES DLS |
| flat tags, flattening outside yhub, small tag sets | Leopard flattener cost, Entra 200-group wall, AWS few-keys discipline |
| cache-authoritative revocation + recheck push | Leopard incremental layer, zookie new-enemy reasoning |
| org floor + bulk + paginated enumeration (no per-doc calls) | AuthZed list-endpoint ladder, OpenFGA streamed ListObjects, Materialize |
| effective-permissions explainer planned | IAM Policy Simulator, Windows Effective Access, Discord calculators |
| awareness send/receive split; presence for viewers | Ably op split; Liveblocks/Figma commenter feedback |
| disconnect-and-resync on permission change | universal platform behavior; yhub recheck 4401 |
