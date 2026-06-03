import * as env from 'lib0/environment'
import * as Y from '@y/y'
import { applyUpdates } from '@y-crdt/yn'

/**
 * Merge a set of v1-encoded updates into a single v1 update.
 *
 * When the `use-y-native` conf is set, delegates to the native yrs (Rust)
 * binding (`@y-crdt/yn`); otherwise uses Yjs's own `Y.mergeUpdates`.
 *
 * @param {Array<Uint8Array<ArrayBuffer>>} updates
 * @returns {Uint8Array<ArrayBuffer>}
 */
export const mergeUpdates = env.hasConf('use-y-native')
  ? (/** @type {Array<Uint8Array<ArrayBuffer>>} */ updates) => /** @type {Uint8Array<ArrayBuffer>} */ (applyUpdates(false, updates))
  : Y.mergeUpdates
