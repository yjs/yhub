import * as env from 'lib0/environment'
import * as json from 'lib0/json'
import * as ecdsa from 'lib0/crypto/ecdsa'
import { createPostgresStorage } from '../src/storage.js'

/**
 * @type {Array<{ destroy: function():Promise<void>}>}
 */
export const prevClients = []

export const authPrivateKey = await ecdsa.importKeyJwk(json.parse(env.ensureConf('auth-private-key')))
export const authPublicKey = await ecdsa.importKeyJwk(json.parse(env.ensureConf('auth-public-key')))

export const redisPrefix = 'ytests'

export const authDemoServerPort = 5173
export const authDemoServerUrl = `http://localhost:${authDemoServerPort}`
export const checkPermCallbackUrl = `${authDemoServerUrl}/auth/perm/`
export const authTokenUrl = `${authDemoServerUrl}/auth/token`

export const yredisPort = 9999
export const yredisUrl = `ws://localhost:${yredisPort}/`

export const storage = await createPostgresStorage(env.ensureConf('postgres-testing'))
// Clean up test data - only delete if table exists
const tableExists = await storage.sql`
  SELECT EXISTS (
    SELECT FROM pg_tables
    WHERE tablename = 'yhub_updates_v1'
  );
`
if (tableExists?.[0]?.exists) {
  await storage.sql`DELETE from yhub_updates_v1`
}
