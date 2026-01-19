/* eslint-env browser */

import * as Y from 'yjs'
// @ts-ignore
import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next'
import { WebsocketProvider } from 'y-websocket'

import { EditorView, basicSetup } from 'codemirror'
import { keymap } from '@codemirror/view'
import { javascript } from '@codemirror/lang-javascript'

import * as random from 'lib0/random'
import { EditorState } from '@codemirror/state'

export const usercolors = [
  { color: '#30bced', light: '#30bced33' },
  { color: '#6eeb83', light: '#6eeb8333' },
  { color: '#ffbc42', light: '#ffbc4233' },
  { color: '#ecd444', light: '#ecd44433' },
  { color: '#ee6352', light: '#ee635233' },
  { color: '#9ac2c9', light: '#9ac2c933' },
  { color: '#8acb88', light: '#8acb8833' },
  { color: '#1be7ff', light: '#1be7ff33' }
]

export const userColor = usercolors[random.uint32() % usercolors.length]

const room = 'y-redis-demo-app'

// request an auth token before trying to connect
const authToken = await fetch(`http://${location.host}/auth/token`).then(request => request.text())

const ydoc = new Y.Doc()
const provider = new WebsocketProvider('ws://localhost:3002', room, ydoc, { params: { yauth: authToken }, disableBc: true })

// The auth token expires eventually (by default in one hour)
// Periodically pull a new auth token (e.g. every 30 minutes) and update the auth parameter
const _updateAuthToken = async () => {
  try {
    provider.params.yauth = await fetch(`http://${location.host}/auth/token`).then(request => request.text())
  } catch (e) {
    setTimeout(_updateAuthToken, 1000) // in case of an error, retry in a second
    return
  }
  setTimeout(_updateAuthToken, 30 * 60 * 60 * 1000) // send a new request in 30 minutes
}
_updateAuthToken()

const ytext = ydoc.getText('codemirror')

provider.awareness.setLocalStateField('user', {
  name: 'Anonymous ' + Math.floor(Math.random() * 100),
  color: userColor.color,
  colorLight: userColor.light
})

const state = EditorState.create({
  doc: ytext.toString(),
  extensions: [
    keymap.of([
      ...yUndoManagerKeymap
    ]),
    basicSetup,
    javascript(),
    EditorView.lineWrapping,
    yCollab(ytext, provider.awareness)
    // oneDark
  ]
})

const view = new EditorView({ state, parent: /** @type {HTMLElement} */ (document.querySelector('#editor')) })

// @ts-ignore
window.example = { provider, ydoc, ytext, view }
