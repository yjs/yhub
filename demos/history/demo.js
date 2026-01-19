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
import * as buffer from 'lib0/buffer'
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

const roomName = 'codemirror-suggestion-demo-8'

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
/**
 * @type {HTMLInputElement?}
 */
const elemToggleRenderVersion = document.querySelector('#toggle-render-version')
/**
 * @type {HTMLButtonElement?}
 */
const elemRollbackBtn = document.querySelector('#rollback-btn')
if (elemToggleShowSuggestions == null || elemToggleSuggestMode == null || elemToggleConnect == null || elemToggleRenderVersion == null || elemRollbackBtn == null) error.unexpectedCase()

if (localStorage.getItem('should-connect') != null) {
  elemToggleConnect.checked = localStorage.getItem('should-connect') === 'true'
}

elemToggleShowSuggestions.addEventListener('change', () => initEditorBindingSuggestions())

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
  initEditorBindingSuggestions()
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

elemToggleRenderVersion.addEventListener('change', () => {
  if (!elemToggleRenderVersion.checked) {
    // Re-enable the other checkboxes and disable render version
    elemToggleConnect.disabled = false
    elemToggleShowSuggestions.disabled = false
    elemToggleSuggestMode.disabled = false
    elemToggleRenderVersion.disabled = true
    // Hide rollback button and clear version range
    elemRollbackBtn.style.display = 'none'
    currentVersionRange = null
    // Clear version selection
    selectionStart = null
    selectionEnd = null
    renderVersionList()
    // Render suggestions again
    initEditorBindingSuggestions()
  }
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
const initEditorBindingSuggestions = () => {
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
initEditorBindingSuggestions()

/**
 * @param {Y.Doc} prevDoc
 * @param {Y.Doc} nextDoc
 * @param {Y.ContentMap} attributions
 */
const initEditorBindingVersionDiff = (prevDoc, nextDoc, attributions) => {
  const diffAttributions = Y.createAttributionManagerFromDiff(prevDoc, nextDoc, { attrs: attributions })
  const ytext = nextDoc.get('quill')
  const docContent = ytext.toDelta(diffAttributions).children.map(s.match().if(delta.$textOp, op => op.insert).else(() => '').done()).join('')
  const state = EditorState.create({
    doc: docContent,
    extensions: [
      keymap.of([
        ...yUndoManagerKeymap
      ]),
      basicSetup,
      // markdown(),
      EditorView.lineWrapping,
      EditorView.editable.of(false),
      yCollab(ytext, null, { attributionManager: diffAttributions })
      // oneDark
    ]
  })
  currentView?.destroy()
  currentView = new EditorView({ state, parent: /** @type {HTMLElement} */ (document.querySelector('#editor')) })
  // @ts-ignore
  window.example = { prevDoc, nextDoc, ytext, view: currentView, am: diffAttributions }
}

/*
 * # History Panel - Version Selection
 */

const yhubApiUrl = 'http://localhost:3002'

/**
 * @type {{ from: number, to: number } | null}
 */
let currentVersionRange = null

/**
 * @param {number} from
 * @param {number} to
 */
const renderVersions = async (from, to) => {
  try {
    const response = await fetch(`${yhubApiUrl}/history/${roomName}?yauth=${authToken}&from=${from}&to=${to}&ydoc=true&attributions=true`)
    if (response.ok) {
      const arrayBuffer = await response.arrayBuffer()
      const history = buffer.decodeAny(new Uint8Array(arrayBuffer))
      console.log({ history })
      const prevDoc = Y.createDocFromUpdate(history.prevDoc)
      const nextDoc = Y.createDocFromUpdate(history.nextDoc)
      const attrs = Y.decodeContentMap(history.attributions)
      console.log('rendering attrs', attrs)
      initEditorBindingVersionDiff(prevDoc, nextDoc, attrs)
      // Store current version range for rollback
      currentVersionRange = { from, to }
      // Disable other checkboxes and enable/check render version
      elemToggleConnect.disabled = true
      elemToggleShowSuggestions.disabled = true
      elemToggleSuggestMode.disabled = true
      elemToggleRenderVersion.disabled = false
      elemToggleRenderVersion.checked = true
      // Show rollback button
      elemRollbackBtn.style.display = 'inline-block'
    }
  } catch (e) {
    console.error('Failed to fetch history:', e)
  }
}

/**
 * Rollback to the currently rendered version
 */
const rollback = async () => {
  if (currentVersionRange === null) return
  try {
    const response = await fetch(`${yhubApiUrl}/rollback/${roomName}?yauth=${authToken}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream'
      },
      body: buffer.encodeAny({ from: currentVersionRange.from, to: currentVersionRange.to })
    })
    if (response.ok) {
      console.log('Rollback successful')
      // Exit version rendering mode
      elemToggleRenderVersion.checked = false
      elemToggleRenderVersion.dispatchEvent(new Event('change'))
    } else {
      console.error('Rollback failed:', await response.text())
    }
  } catch (e) {
    console.error('Failed to rollback:', e)
  }
}

elemRollbackBtn.addEventListener('click', rollback)

/**
 * @type {Array<number>}
 */
let timestamps = []

/**
 * @type {number | null}
 */
let selectionStart = null

/**
 * @type {number | null}
 */
let selectionEnd = null

/**
 * @type {boolean}
 */
let isSelecting = false

const versionListEl = /** @type {HTMLElement} */ (document.querySelector('#version-list'))

/**
 * Format a unix timestamp as a readable date/time string
 * @param {number} timestamp
 */
const formatTimestamp = (timestamp) => {
  const date = new Date(timestamp)
  return date.toLocaleString()
}

/**
 * Render the version list with current selection state
 */
const renderVersionList = () => {
  versionListEl.innerHTML = ''
  // Render in reverse order (newest first)
  for (let i = timestamps.length - 1; i >= 0; i--) {
    const ts = timestamps[i]
    const div = document.createElement('div')
    div.className = 'version-item'
    div.textContent = formatTimestamp(ts)
    div.dataset.index = String(i)
    div.dataset.timestamp = String(ts)

    // Apply selection styling
    if (selectionStart !== null && selectionEnd !== null) {
      const minIdx = Math.min(selectionStart, selectionEnd)
      const maxIdx = Math.max(selectionStart, selectionEnd)
      if (i >= minIdx && i <= maxIdx) {
        div.classList.add('selected')
      }
    }

    versionListEl.appendChild(div)
  }
}

/**
 * Fetch timestamps from the API
 */
const fetchTimestamps = async () => {
  try {
    const response = await fetch(`${yhubApiUrl}/timestamps/${roomName}?yauth=${authToken}`)
    if (response.ok) {
      const arrayBuffer = await response.arrayBuffer()
      const data = buffer.decodeAny(new Uint8Array(arrayBuffer)).timestamps
      if (Array.isArray(data) && data.length > 0) {
        timestamps = data
        renderVersionList()
      }
    }
  } catch (e) {
    console.error('Failed to fetch timestamps:', e)
  }
}

// Mouse event handlers for range selection
versionListEl.addEventListener('mousedown', (e) => {
  const target = /** @type {HTMLElement} */ (e.target)
  if (target.classList.contains('version-item')) {
    isSelecting = true
    selectionStart = parseInt(target.dataset.index || '0', 10)
    selectionEnd = selectionStart
    renderVersionList()
    e.preventDefault()
  }
})

versionListEl.addEventListener('mousemove', (e) => {
  if (!isSelecting) return
  const target = /** @type {HTMLElement} */ (e.target)
  if (target.classList.contains('version-item')) {
    selectionEnd = parseInt(target.dataset.index || '0', 10)
    renderVersionList()
  }
})

document.addEventListener('mouseup', () => {
  if (isSelecting && selectionStart !== null && selectionEnd !== null) {
    const minIdx = Math.min(selectionStart, selectionEnd)
    const maxIdx = Math.max(selectionStart, selectionEnd)
    const fromTimestamp = timestamps[minIdx]
    const toTimestamp = timestamps[maxIdx]
    renderVersions(fromTimestamp, toTimestamp)
  }
  isSelecting = false
})

// Fetch timestamps initially and then poll every 5 seconds
fetchTimestamps()
setInterval(fetchTimestamps, 5000)
