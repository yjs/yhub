import { createRequire } from 'node:module'
import * as env from 'lib0/environment'

// yn ships only a compiled `index.node` with no JS wrapper; Node's ESM loader
// can't import `.node` files directly, so route through CJS createRequire.
const require = createRequire(import.meta.url)
const YN = env.hasConf('use-y-crdt') ? require('yn') : /** @type {any} */ (null)

/**
 * Merge updates with the yrs (Rust) binding. Creates a yrs Doc, applies all
 * updates in a single transaction, and returns the v1-encoded merged state.
 *
 * @param {Array<Uint8Array<ArrayBuffer>>} updates
 * @returns {Uint8Array<ArrayBuffer>}
 */
export const ynMergeUpdates = (updates) => YN.applyUpdates(false, updates)
