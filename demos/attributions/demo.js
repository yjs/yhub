/* eslint-env browser */

import * as Y from 'yjs'
// @ts-ignore
import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next'
import { WebsocketProvider } from 'y-websocket'

import { EditorView, basicSetup } from 'codemirror'
import { keymap } from '@codemirror/view'
import { javascript } from '@codemirror/lang-javascript'

import * as random from 'lib0/random'
import * as decoding from 'lib0/decoding'
import * as encoding from 'lib0/encoding'
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

const room = 'y-redis-demo-app-3'

// request an auth token before trying to connect
const authToken = await fetch(`http://${location.host}/auth/token`).then(request => request.text())

const ydoc = new Y.Doc()
const yhubHost = 'localhost:3002'
const provider = new WebsocketProvider(`ws://${yhubHost}/ws`, room, ydoc, { params: { yauth: authToken }, disableBc: true })

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

const ytext = ydoc.getText()

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

// History panel functionality
const fromSelect = /** @type {HTMLSelectElement} */ (document.getElementById('from-timestamp'))
const toSelect = /** @type {HTMLSelectElement} */ (document.getElementById('to-timestamp'))
const renderBtn = /** @type {HTMLButtonElement} */ (document.getElementById('render-btn'))
const rollbackBtn = /** @type {HTMLButtonElement} */ (document.getElementById('rollback-btn'))

// Popup elements
const diffPopup = /** @type {HTMLElement} */ (document.getElementById('diff-popup'))
const popupContent = /** @type {HTMLElement} */ (document.getElementById('popup-content'))
const popupClose = /** @type {HTMLButtonElement} */ (document.getElementById('popup-close'))

const showPopup = (/** @type {string} */ content) => {
  popupContent.textContent = content
  diffPopup.classList.add('active')
}

const hidePopup = () => {
  diffPopup.classList.remove('active')
}

popupClose.addEventListener('click', hidePopup)
diffPopup.addEventListener('click', (e) => {
  if (e.target === diffPopup) hidePopup()
})

/**
 * @param {number} timestamp
 */
const formatTimestamp = (timestamp) => {
  return new Date(timestamp).toLocaleString()
}

/**
 * @param {HTMLSelectElement} select
 * @param {Array<number>} timestamps
 */
const populateSelect = (select, timestamps) => {
  const prevValue = select.value
  select.innerHTML = ''
  timestamps.forEach((ts, index) => {
    const option = document.createElement('option')
    option.value = ts.toString()
    const hexId = index.toString(16).toUpperCase().padStart(2, '0')
    option.textContent = `${hexId}: ${formatTimestamp(ts)}`
    select.appendChild(option)
  })
  // Restore previous selection if it still exists
  if (prevValue && Array.from(select.options).some(opt => opt.value === prevValue)) {
    select.value = prevValue
  }
}

const fetchTimestamps = async () => {
  try {
    const response = await fetch(`http://${yhubHost}/timestamps/${room}`)
    const data = await response.arrayBuffer()
    const decoder = decoding.createDecoder(new Uint8Array(data))
    const { timestamps } = decoding.readAny(decoder)
    console.log('RECEIVED TIMESTAMPS!!', timestamps)
    if (Array.isArray(timestamps) && timestamps.length > 0) {
      populateSelect(fromSelect, timestamps)
      populateSelect(toSelect, timestamps)
      // Set 'to' to the last timestamp by default
      toSelect.value = timestamps[timestamps.length - 1].toString()
    } else {
      fromSelect.innerHTML = '<option value="">No timestamps</option>'
      toSelect.innerHTML = '<option value="">No timestamps</option>'
    }
  } catch (e) {
    console.error('Failed to fetch timestamps:', e)
    fromSelect.innerHTML = '<option value="">Error loading</option>'
    toSelect.innerHTML = '<option value="">Error loading</option>'
  }
}

renderBtn.addEventListener('click', async () => {
  const from = fromSelect.value
  const to = toSelect.value
  if (!from || !to) {
    alert('Please select both from and to timestamps')
    return
  }
  try {
    const response = await fetch(`http://${yhubHost}/history/${room}?from=${from}&to=${to}&delta=true&ydoc=true`)
    const data = await response.arrayBuffer()
    const decoder = decoding.createDecoder(new Uint8Array(data))
    const result = decoding.readAny(decoder)
    /**
     * @param {Uint8Array} update
     */
    const createDocFromUpdate = update => {
      const ydoc = new Y.Doc()
      Y.applyUpdate(ydoc, update)
      return ydoc
    }

    const message = `prevDoc: ${JSON.stringify(createDocFromUpdate(result.prevDoc).getText().toJSON())}

nextDoc: ${JSON.stringify(createDocFromUpdate(result.nextDoc).getText().toJSON())}

delta: ${JSON.stringify(result.delta, null, 2)}`
    showPopup(message)
  } catch (e) {
    alert('Error fetching history: ' + e)
  }
})

rollbackBtn.addEventListener('click', async () => {
  const from = fromSelect.value
  const to = toSelect.value
  if (!from || !to) {
    alert('Please select both from and to timestamps')
    return
  }
  try {
    const encoder = encoding.createEncoder()
    encoding.writeAny(encoder, { from: Number(from), to: Number(to) })
    const body = encoding.toUint8Array(encoder)
    const response = await fetch(`http://${yhubHost}/rollback/${room}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream'
      },
      body
    })
    if (response.ok) {
      alert('Rollback successful')
      fetchTimestamps() // Refresh timestamps
    } else {
      alert('Rollback failed: ' + response.statusText)
    }
  } catch (e) {
    alert('Error during rollback: ' + e)
  }
})

// Initial fetch and periodic polling
fetchTimestamps()
setInterval(fetchTimestamps, 2000) // Refresh timestamps every 5 seconds
