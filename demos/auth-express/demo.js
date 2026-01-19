/* eslint-env browser */
import * as Y from '@y/y'
// @ts-ignore
import { yCollab, yUndoManagerKeymap } from '@y/codemirror'
import { WebsocketProvider } from '@y/websocket'

import { EditorView, basicSetup } from 'codemirror'
import { keymap } from '@codemirror/view'
// import { markdown } from '@codemirror/lang-markdown'
// import { oneDark } from '@codemirror/next/theme-one-dark'

import * as delta from 'lib0/delta'
import * as random from 'lib0/random'
import * as error from 'lib0/error'
import * as s from 'lib0/schema'
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

const roomName = 'codemirror-suggestion-demo-4'

/*
 * # Logic for toggling connection & suggestion mode
 */

/**
 * @type {HTMLInputElement?}
 */
const elemToggleConnect = document.querySelector('#toggle-connect')

/**
 * @type {HTMLInputElement?}
 */
const elemToggleShowSuggestions = document.querySelector('#toggle-show-suggestions')
/**
 * @type {HTMLInputElement?}
 */
const elemToggleSuggestMode = document.querySelector('#toggle-suggest-mode')
if (elemToggleShowSuggestions == null || elemToggleSuggestMode == null || elemToggleConnect == null) error.unexpectedCase()

if (localStorage.getItem('should-connect') != null) {
  elemToggleConnect.checked = localStorage.getItem('should-connect') === 'true'
}

elemToggleShowSuggestions.addEventListener('change', () => initEditorBinding())

// when in suggestion-mode, we should use a different clientId to reduce some overhead. This is not
// strictly necessary.
let otherClientID = random.uint53()
elemToggleSuggestMode.addEventListener('change', () => {
  const enabled = elemToggleSuggestMode.checked
  attributionManager.suggestionMode = enabled
  if (enabled) {
    elemToggleShowSuggestions.checked = true
    elemToggleShowSuggestions.disabled = true
  } else {
    elemToggleShowSuggestions.disabled = false
  }
  const nextClientId = otherClientID
  otherClientID = suggestionDoc.clientID
  suggestionDoc.clientID = nextClientId
  initEditorBinding()
})

elemToggleConnect.addEventListener('change', () => {
  if (elemToggleConnect.checked) {
    providerYdoc.connectBc()
    providerYdocSuggestions.connectBc()
  } else {
    providerYdoc.disconnectBc()
    providerYdocSuggestions.disconnectBc()
  }
  localStorage.setItem('should-connect', elemToggleConnect.checked ? 'true' : 'false')
})

const yhubUrl = 'ws://localhost:3002/ws'

// request an auth token before trying to connect
const authToken = await fetch(`http://${location.host}/auth/token`).then(request => request.text())
// The auth token expires eventually (by default in one hour)
// Periodically pull a new auth token (e.g. every 30 minutes) and update the auth parameter
const _updateAuthToken = async () => {
  try {
    const updatedAuthToken = await fetch(`http://${location.host}/auth/token`).then(request => request.text())
    providerYdoc.params.yauth = updatedAuthToken
    providerYdocSuggestions.params.yauth = updatedAuthToken
  } catch (e) {
    setTimeout(_updateAuthToken, 1000) // in case of an error, retry in a second
    return
  }
  setTimeout(_updateAuthToken, 30 * 60 * 60 * 1000) // send a new request in 30 minutes
}
_updateAuthToken()

/*
 * # Init two Yjs documents.
 *
 * The suggestion document is a fork of the original document. By keeping them separate, we can
 * enforce different permissions on these documents.
 */

const ydoc = new Y.Doc()
const providerYdoc = new WebsocketProvider(yhubUrl, roomName, ydoc, { params: { yauth: authToken } })
elemToggleConnect.checked && providerYdoc.connectBc()
const suggestionDoc = new Y.Doc({ isSuggestionDoc: true })
const providerYdocSuggestions = new WebsocketProvider(yhubUrl, roomName + '--suggestions', suggestionDoc,  { params: { yauth: authToken, branch: 'suggestions' } })
elemToggleConnect.checked && providerYdocSuggestions.connectBc()
const attributionManager = Y.createAttributionManagerFromDiff(ydoc, suggestionDoc)

providerYdoc.awareness.setLocalStateField('user', {
  name: 'Anonymous ' + Math.floor(Math.random() * 100),
  color: userColor.color,
  colorLight: userColor.light
})

/**
 * @type {EditorView?}
 */
let currentView = null
const initEditorBinding = () => {
  const withSuggestions = elemToggleShowSuggestions.checked
  const ytext = (withSuggestions ? suggestionDoc : ydoc).get('quill')
  const docContent = ytext.toDelta(attributionManager).children.map(s.match().if(delta.$textOp, op => op.insert).else(() => '').done()).join('')
  const state = EditorState.create({
    doc: docContent,
    extensions: [
      keymap.of([
        ...yUndoManagerKeymap
      ]),
      basicSetup,
      // markdown(),
      EditorView.lineWrapping,
      yCollab(ytext, (withSuggestions ? providerYdocSuggestions : providerYdoc).awareness, { attributionManager })
      // oneDark
    ]
  })
  currentView?.destroy()
  currentView = new EditorView({ state, parent: /** @type {HTMLElement} */ (document.querySelector('#editor')) })
  // @ts-ignore
  window.example = { provider: providerYdoc, ydoc: ytext.doc, ytext, view: currentView, am: attributionManager }
}
initEditorBinding()
