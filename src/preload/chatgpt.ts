import { ipcRenderer } from 'electron'
import type { CodeBlock, InboundPayload } from '@shared/types'

// Selector discovery and DOM injection are chatty while they work. These run
// inside the guest page on every operation, so the trace is off unless it's
// explicitly asked for — set `localStorage.brainstormDebug = '1'` in the guest
// (or launch with --enable-logging) when diagnosing a selector break.
const DEBUG = (() => {
  try {
    return new URLSearchParams(location.search).has('debug') || localStorage.getItem('brainstormDebug') === '1'
  } catch {
    return false
  }
})()

function debug(...args: unknown[]): void {
  if (DEBUG) console.log('[ChatGPT Bridge]', ...args)
}

// DOM Selectors for ChatGPT interface (current as of 2024-2025)
// Multiple fallback selectors for each element type
const SELECTORS = {
  // Input area - contenteditable div (try multiple selectors)
  input: [
    '#prompt-textarea',
    'div[contenteditable="true"][data-slate-editor]',
    'div[contenteditable="true"]',
    'textarea',
    'form textarea'
  ],
  // Send button
  sendButton: [
    'button[data-testid="send-button"]',
    'button[aria-label="Send prompt"]',
    'button:has(svg)',
    'form button[type="submit"]',
    'button[aria-label]'
  ],
  // New chat button
  newChatButton: [
    '[data-testid="new-chat-button"]',
    'a[href="/"]',
    'button:contains("New chat")',
    'button[aria-label*="new" i]'
  ],
  // Assistant messages container
  assistantMessage: '[data-message-author-role="assistant"]',
  // Code blocks within messages
  codeBlock: 'pre code',
  // Language class pattern
  languageClassPattern: /language-(\w+)/
} as const

// Helper to try multiple selectors and return the first match
function querySelectorWithFallback(selectors: string | string[]): Element | null {
  const selectorList = Array.isArray(selectors) ? selectors : [selectors]

  for (const selector of selectorList) {
    try {
      const el = document.querySelector(selector)
      if (el) {
        debug(`[ChatGPT Bridge] Found element with selector: ${selector}`)
        return el
      }
    } catch (e) {
      debug(`[ChatGPT Bridge] Invalid selector: ${selector}`, e)
    }
  }

  debug(`[ChatGPT Bridge] No element found for any selector:`, selectorList)
  return null
}

/**
 * Find element with retry logic for dynamic content
 */
async function findElement(
  selector: string | readonly string[],
  timeout = 5000
): Promise<Element | null> {
  const startTime = Date.now()
  while (Date.now() - startTime < timeout) {
    const el = querySelectorWithFallback(selector as string | string[])
    if (el) return el
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  return null
}

/**
 * Fill contenteditable input with proper React state triggering
 */
async function fillContenteditableInput(text: string): Promise<boolean> {
  const input = (await findElement(SELECTORS.input)) as HTMLElement | null
  if (!input) {
    console.error('[ChatGPT Bridge] Prompt input not found — the composer selector list needs updating')
    return false
  }

  // Focus the element
  input.focus()

  // Clear existing content
  input.textContent = ''
  input.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true }))
  debug('Cleared input content')

  // Use execCommand to insert text - this properly triggers React's onChange
  debug('Attempting execCommand insertText...')
  const success = document.execCommand('insertText', false, text)
  debug('execCommand result:', success)

  if (!success) {
    // Fallback: directly set textContent and dispatch events
    debug('Falling back to textContent')
    input.textContent = text
  }

  // Dispatch comprehensive event sequence to trigger React state updates
  debug('Dispatching events...')
  const events = [
    new InputEvent('input', { bubbles: true, cancelable: true, data: text }),
    new Event('input', { bubbles: true, cancelable: true }),
    new Event('change', { bubbles: true, cancelable: true }),
    new KeyboardEvent('keyup', { bubbles: true, cancelable: true, key: 'v', ctrlKey: true })
  ]

  events.forEach(event => input.dispatchEvent(event))

  // Trigger a focus event again to ensure state updates
  input.focus()
  debug('fillContenteditableInput completed successfully')

  return true
}

/**
 * Click the send button
 */
async function clickSendButton(): Promise<boolean> {
  const sendButton = await findElement(SELECTORS.sendButton) as HTMLButtonElement
  if (!sendButton) {
    console.error('[ChatGPT Bridge] Send button not found')
    return false
  }

  // Ensure button is enabled
  if (sendButton.disabled) {
    console.error('[ChatGPT Bridge] Send button is disabled')
    return false
  }

  // Click the button
  sendButton.click()

  // Also dispatch mousedown/mouseup/click events for completeness
  const rect = sendButton.getBoundingClientRect()
  const x = rect.left + rect.width / 2
  const y = rect.top + rect.height / 2

  sendButton.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: x, clientY: y }))
  sendButton.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, clientX: x, clientY: y }))
  sendButton.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: x, clientY: y }))

  return true
}

/**
 * Click the new chat button
 */
async function clickNewChatButton(): Promise<boolean> {
  const newChatBtn = await findElement(SELECTORS.newChatButton) as HTMLElement
  if (!newChatBtn) {
    console.error('[ChatGPT Bridge] New chat button not found')
    return false
  }

  newChatBtn.click()
  return true
}

/**
 * Fill input and submit with delay
 */
async function fillAndSubmit(text: string, delayMs = 500): Promise<boolean> {
  try {
    const fillSuccess = await fillContenteditableInput(text)
    if (!fillSuccess) {
      console.error('[ChatGPT Bridge] fillAndSubmit: could not fill the composer')
      return false
    }

    // Wait for React state to update and button to become enabled
    await new Promise(resolve => setTimeout(resolve, delayMs))

    const clickSuccess = await clickSendButton()
    return clickSuccess
  } catch (err) {
    console.error('[ChatGPT Bridge] fillAndSubmit caught error:', err)
    return false
  }
}

/**
 * Parse code blocks from an element
 */
function parseCodeBlocks(element: Element): CodeBlock[] {
  const blocks: CodeBlock[] = []
  const codeElements = element.querySelectorAll(SELECTORS.codeBlock)

  codeElements.forEach((codeEl) => {
    const className = codeEl.className || ''
    const match = className.match(SELECTORS.languageClassPattern)
    const language = match ? match[1] : 'plaintext'
    const code = codeEl.textContent || ''
    blocks.push({ language, code })
  })

  return blocks
}

/**
 * Recursively converts ChatGPT's rendered HTML DOM tree back into authentic raw Markdown.
 * Preserves headers (##), bold (**), italic (*), lists (- / 1.), blockquotes (>), links, and code blocks.
 */
function elementToMarkdown(element: Element): string {
  function convertNode(node: Node): string {
    if (node.nodeType === Node.TEXT_NODE) {
      return node.textContent || ''
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return ''

    const el = node as HTMLElement
    if (el.classList.contains('brainstorm-injected-toolbar')) return ''

    const tag = el.tagName.toLowerCase()

    // Pre/code blocks
    if (tag === 'pre') {
      const codeEl = el.querySelector('code')
      const langMatch = codeEl?.className.match(/language-(\w+)/)
      const lang = langMatch ? langMatch[1] : ''
      const codeText = codeEl ? codeEl.textContent : el.textContent
      return `\n\n\`\`\`${lang}\n${(codeText || '').trim()}\n\`\`\`\n\n`
    }
    if (tag === 'code' && el.parentElement?.tagName.toLowerCase() !== 'pre') {
      return `\`${el.textContent}\``
    }

    // Headings
    if (/^h[1-6]$/.test(tag)) {
      const level = parseInt(tag[1], 10)
      const hashes = '#'.repeat(level)
      const headingText = Array.from(el.childNodes).map(convertNode).join('').trim()
      return `\n\n${hashes} ${headingText}\n\n`
    }

    // Paragraphs & Line breaks
    if (tag === 'p') {
      const paragraphText = Array.from(el.childNodes).map(convertNode).join('').trim()
      return `\n\n${paragraphText}\n\n`
    }
    if (tag === 'br') return '\n'

    // Bold & Italic
    if (tag === 'strong' || tag === 'b') {
      return `**${Array.from(el.childNodes).map(convertNode).join('')}**`
    }
    if (tag === 'em' || tag === 'i') {
      return `*${Array.from(el.childNodes).map(convertNode).join('')}*`
    }

    // Blockquotes
    if (tag === 'blockquote') {
      const quoteText = Array.from(el.childNodes).map(convertNode).join('').trim()
      return `\n\n> ${quoteText.replace(/\n/g, '\n> ')}\n\n`
    }

    // Lists
    if (tag === 'ul' || tag === 'ol') {
      const listItems = Array.from(el.children).filter((c) => c.tagName.toLowerCase() === 'li')
      const items = listItems.map((li, i) => {
        const prefix = tag === 'ol' ? `${i + 1}. ` : '- '
        const itemText = Array.from(li.childNodes).map(convertNode).join('').trim()
        return `${prefix}${itemText}`
      })
      return `\n\n${items.join('\n')}\n\n`
    }

    // Links
    if (tag === 'a') {
      const href = el.getAttribute('href') || ''
      const text = Array.from(el.childNodes).map(convertNode).join('')
      return href && text ? `[${text}](${href})` : text
    }

    return Array.from(el.childNodes).map(convertNode).join('')
  }

  const raw = convertNode(element)
  return raw.replace(/\n{3,}/g, '\n\n').trim()
}

/**
 * Injects custom Brainstorm quick action buttons directly onto ChatGPT's frontend DOM
 * underneath or inside native action bar (next to Copy / Share icons).
 */
function injectInPageActionButtons(): void {
  // Find all assistant turn/message elements using multiple fallback selectors
  const assistantNodes = document.querySelectorAll(
    '[data-message-author-role="assistant"], div.markdown, article[data-testid*="turn"], [data-testid="conversation-turn-assistant"]'
  )

  assistantNodes.forEach((node) => {
    // Find the enclosing message turn or assistant container
    const turnEl = node.closest('article') || node.closest('[data-message-author-role="assistant"]') || node

    // Avoid double injection in the same message turn
    if (turnEl.querySelector('.brainstorm-injected-toolbar')) return

    // Find the target container for button insertion: prefer the native action bar next to Copy/Share buttons
    const nativeCopyBtn = turnEl.querySelector(
      'button[data-testid="copy-turn-action-button"], button[aria-label*="Copy"], button[aria-label*="copy"]'
    )
    const targetParent = nativeCopyBtn?.parentElement || turnEl.querySelector('[data-testid="message-actions"]') || node

    if (!targetParent) return

    const toolbar = document.createElement('div')
    toolbar.className = 'brainstorm-injected-toolbar'
    toolbar.style.cssText = `
      display: inline-flex !important;
      align-items: center !important;
      gap: 6px !important;
      margin: 6px 4px !important;
      padding: 4px 8px !important;
      background: #2d2d30 !important;
      border: 1px solid #4a4a4e !important;
      border-radius: 6px !important;
      font-family: system-ui, -apple-system, sans-serif !important;
      font-size: 12px !important;
      color: #ffffff !important;
      z-index: 99999 !important;
      box-shadow: 0 2px 6px rgba(0,0,0,0.3) !important;
      visibility: visible !important;
      opacity: 1 !important;
    `

    const btnCopy = document.createElement('button')
    btnCopy.innerHTML = '📋 Copy Raw'
    btnCopy.title = 'Copy authentic raw Markdown to clipboard'
    btnCopy.style.cssText = 'background: transparent; border: none; color: #ffffff !important; cursor: pointer; padding: 2px 6px; font-size: 12px; font-weight: 500;'
    btnCopy.onclick = (e) => {
      e.preventDefault()
      e.stopPropagation()
      const md = elementToMarkdown(node)
      void navigator.clipboard.writeText(md)
      btnCopy.innerHTML = '✅ Copied'
      setTimeout(() => (btnCopy.innerHTML = '📋 Copy Raw'), 2000)
    }

    const btnNotes = document.createElement('button')
    btnNotes.innerHTML = '📝 Add to Notes'
    btnNotes.title = 'Append raw Markdown to Brainstorm notes'
    btnNotes.style.cssText = 'background: transparent; border: none; color: #ffffff !important; cursor: pointer; padding: 2px 6px; font-size: 12px; font-weight: 500;'
    btnNotes.onclick = (e) => {
      e.preventDefault()
      e.stopPropagation()
      const md = elementToMarkdown(node)
      ipcRenderer.sendToHost('dom-bridge:add-to-notes', md)
      btnNotes.innerHTML = '✅ Added'
      setTimeout(() => (btnNotes.innerHTML = '📝 Add to Notes'), 2000)
    }

    const btnIdea = document.createElement('button')
    btnIdea.innerHTML = '💡 Save Idea'
    btnIdea.title = 'Save as single-line Idea item'
    btnIdea.style.cssText = 'background: transparent; border: none; color: #ffffff !important; cursor: pointer; padding: 2px 6px; font-size: 12px; font-weight: 500;'
    btnIdea.onclick = (e) => {
      e.preventDefault()
      e.stopPropagation()
      const md = elementToMarkdown(node)
      const firstLine = md.replace(/^#+\s+/gm, '').trim().split('\n')[0]
      ipcRenderer.sendToHost('dom-bridge:save-as-idea', firstLine)
      btnIdea.innerHTML = '✅ Saved'
      setTimeout(() => (btnIdea.innerHTML = '💡 Save Idea'), 2000)
    }

    toolbar.appendChild(btnCopy)
    toolbar.appendChild(btnNotes)
    toolbar.appendChild(btnIdea)

    if (nativeCopyBtn && nativeCopyBtn.parentElement) {
      nativeCopyBtn.parentElement.appendChild(toolbar)
    } else {
      targetParent.appendChild(toolbar)
    }
  })
}

// --- Reply capture ---------------------------------------------------------
let awaitingReply = false
let baselineAssistantCount = 0
let lastSeenText = ''
let settleTimer: ReturnType<typeof setTimeout> | null = null

function assistantMessages(): NodeListOf<Element> {
  return document.querySelectorAll(SELECTORS.assistantMessage)
}

// Called right after a successful submit: remember how many assistant messages
// already exist so we only capture the new one.
function armReplyCapture(): void {
  awaitingReply = true
  baselineAssistantCount = assistantMessages().length
  lastSeenText = ''
  if (settleTimer) {
    clearTimeout(settleTimer)
    settleTimer = null
  }
}

function emitSettledReply(): void {
  const messages = assistantMessages()
  if (messages.length <= baselineAssistantCount) return
  const el = messages[messages.length - 1]
  const text = elementToMarkdown(el)
  if (!text) return

  const payload: InboundPayload = {
    text,
    codeBlocks: parseCodeBlocks(el),
    timestamp: Date.now()
  }
  ipcRenderer.sendToHost('dom-bridge:message', payload)
  awaitingReply = false
}

function onPossibleReplyChange(): void {
  if (!awaitingReply) return
  const messages = assistantMessages()
  if (messages.length <= baselineAssistantCount) return
  const el = messages[messages.length - 1]
  const text = elementToMarkdown(el)
  if (text && text !== lastSeenText) {
    lastSeenText = text
    if (settleTimer) clearTimeout(settleTimer)
    settleTimer = setTimeout(emitSettledReply, 1200)
  }
}

// Re-injecting the in-page action bar walks the whole message list, so it is
// throttled to one pass per animation frame instead of running on every
// mutation — streaming a reply produces thousands of mutations per second.
let buttonInjectQueued = false
function scheduleButtonInject(): void {
  if (buttonInjectQueued) return
  buttonInjectQueued = true
  requestAnimationFrame(() => {
    buttonInjectQueued = false
    injectInPageActionButtons()
  })
}

/**
 * Set up a MutationObserver that drives settle-based reply capture and in-page button injection.
 */
function startMessageObserver(): void {
  const observer = new MutationObserver(() => onPossibleReplyChange())
  observer.observe(document.body, { childList: true, subtree: true, characterData: true })
  injectInPageActionButtons()
  // The bar is removed whenever the transcript re-renders; re-check periodically
  // so it reappears, but at a rate that can't compete with the observer.
  setInterval(scheduleButtonInject, 2000)
}

// --- Conversation URL tracking --------------------------------------------
//
// ChatGPT is a single-page app: each conversation has its own /c/<id> URL that
// the host stores per session, so a session can be reopened and continued. SPA
// navigations don't fire a page load, so we hook the History API instead of
// polling the location on a timer.
let lastReportedUrl = ''
function reportUrl(): void {
  const href = location.href
  if (href !== lastReportedUrl) {
    lastReportedUrl = href
    ipcRenderer.sendToHost('dom-bridge:url', href)
  }
}

function watchForSpaNavigation(): void {
  const notify = (): void => reportUrl()
  window.addEventListener('popstate', notify)
  window.addEventListener('hashchange', notify)

  // pushState/replaceState are not observable via events, so wrap them.
  for (const method of ['pushState', 'replaceState'] as const) {
    const original = history[method]
    history[method] = function patched(this: History, ...args: Parameters<History['pushState']>): void {
      original.apply(this, args)
      notify()
    }
  }
}

// --- IPC Operation Handlers ---

interface OperationPayload {
  type: 'fillInput' | 'clickElement' | 'fillAndSubmit'
  selector?: string
  text?: string
  delayMs?: number
}

async function handleOperation(_event: Electron.IpcRendererEvent, payload: string): Promise<void> {
  try {
    const operation: OperationPayload = JSON.parse(payload)
    let success = false
    let errorMessage = ''

    debug('operation', operation.type)

    switch (operation.type) {
      case 'fillInput':
        if (operation.text) {
          try {
            success = await fillContenteditableInput(operation.text)
            if (!success) errorMessage = 'fillContenteditableInput returned false'
          } catch (e) {
            errorMessage = e instanceof Error ? e.message : String(e)
          }
        } else {
          errorMessage = 'No text provided for fillInput'
        }
        break
      case 'clickElement':
        try {
          if (operation.selector === '[data-testid="new-chat-button"]') {
            success = await clickNewChatButton()
            if (!success) errorMessage = 'clickNewChatButton returned false'
          } else if (operation.selector === 'button[data-testid="send-button"]') {
            success = await clickSendButton()
            if (!success) errorMessage = 'clickSendButton returned false'
          } else {
            const el = document.querySelector(operation.selector || '') as HTMLElement
            if (el) {
              el.click()
              success = true
            } else {
              errorMessage = `Element not found: ${operation.selector}`
            }
          }
        } catch (e) {
          errorMessage = e instanceof Error ? e.message : String(e)
        }
        break
      case 'fillAndSubmit':
        if (operation.text) {
          try {
            success = await fillAndSubmit(operation.text, operation.delayMs || 500)
            if (success) armReplyCapture()
            if (!success) errorMessage = 'fillAndSubmit returned false'
          } catch (e) {
            errorMessage = e instanceof Error ? e.message : String(e)
          }
        } else {
          errorMessage = 'No text provided for fillAndSubmit'
        }
        break
      default:
        errorMessage = `Unknown operation type: ${(operation as {type: string}).type}`
    }

    if (!success) {
      console.error('[ChatGPT Bridge] Operation failed:', errorMessage)
      ipcRenderer.sendToHost('dom-bridge:error', {
        operation: operation.type,
        message: errorMessage || `Failed to execute ${operation.type}`
      })
    }
  } catch (err) {
    console.error('[ChatGPT Bridge] Operation error:', err)
    ipcRenderer.sendToHost('dom-bridge:error', {
      message: err instanceof Error ? err.message : String(err)
    })
  }
}

// Listen for operations from the renderer
ipcRenderer.on('dom-bridge:op', handleOperation)

// Also listen for ping to verify connection
ipcRenderer.on('dom-bridge:ping', () => {
  debug('Received ping, sending pong')
  ipcRenderer.sendToHost('dom-bridge:pong', {})
})

// Start observing for messages when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', startMessageObserver)
} else {
  startMessageObserver()
}

// Report the current conversation URL to the host, then watch for SPA
// navigations (new chat, switching conversations) so no polling is needed.
reportUrl()
watchForSpaNavigation()

// Signal to the renderer that the preload is ready
ipcRenderer.sendToHost('dom-bridge:ready', {})

// Export for potential external use
export {
  fillContenteditableInput,
  clickSendButton,
  clickNewChatButton,
  fillAndSubmit
}
