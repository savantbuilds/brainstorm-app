import { useCallback, useEffect, useRef, useState } from 'react'
import type { DomBridgeConfig, InboundPayload } from '@shared/types'

// The `ipc-message` event Electron raises on a <webview> when the guest calls
// ipcRenderer.sendToHost(). Declared here so the bridge handlers stay typed
// instead of falling back to `any`.
export interface WebviewIpcMessageEvent extends Event {
  channel: string
  args: unknown[]
}

// Loosely typed webview element interface for renderer execution without
// ambient Node types. Custom events (`ipc-message`) are declared on the element
// itself so the add/removeEventListener pair stays type-checked.
export interface WebviewEventMap extends HTMLElementEventMap {
  'ipc-message': WebviewIpcMessageEvent
}

export type WebviewElement = Omit<HTMLElement, 'addEventListener' | 'removeEventListener'> & {
  send: (channel: string, ...args: unknown[]) => void
  reload: () => void
  loadURL: (url: string) => Promise<void>
  getURL: () => string
  isReady?: () => boolean
  executeJavaScript?: (code: string) => Promise<unknown>
  addEventListener<K extends keyof WebviewEventMap>(
    type: K,
    listener: (this: WebviewElement, ev: WebviewEventMap[K]) => void,
    options?: boolean | AddEventListenerOptions
  ): void
  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions
  ): void
  removeEventListener<K extends keyof WebviewEventMap>(
    type: K,
    listener: (this: WebviewElement, ev: WebviewEventMap[K]) => void,
    options?: boolean | EventListenerOptions
  ): void
  removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | EventListenerOptions
  ): void
}

export interface UseWebviewBridgeResult {
  webviewRef: React.RefCallback<WebviewElement | null>
  isReady: boolean
  sendOperation: (payload: string) => void
  onMessage: (callback: (data: InboundPayload) => void) => () => void
  onUrl: (callback: (url: string) => void) => () => void
  onAddToNotes: (callback: (text: string) => void) => () => void
  onSaveAsIdea: (callback: (text: string) => void) => () => void
  navigateTo: (url: string) => void
  navigateAndWait: (url: string, timeoutMs?: number) => Promise<void>
}

export interface BridgeOperation {
  type: 'fillInput' | 'clickElement' | 'fillAndSubmit'
  selector?: string
  text?: string
  delayMs?: number
}

/**
 * Custom React hook wrapping Electron <webview> IPC interaction.
 * Provides typed outbound operation dispatching and inbound message observation.
 */
export function useWebviewBridge(_config?: DomBridgeConfig): UseWebviewBridgeResult {
  // Use state instead of ref to trigger re-renders when webview is attached
  const [webviewNode, setWebviewNode] = useState<WebviewElement | null>(null)
  const [isReady, setIsReady] = useState(false)
  const messageListenersRef = useRef<Set<(data: InboundPayload) => void>>(new Set())
  const urlListenersRef = useRef<Set<(url: string) => void>>(new Set())
  const addToNotesListenersRef = useRef<Set<(text: string) => void>>(new Set())
  const saveAsIdeaListenersRef = useRef<Set<(text: string) => void>>(new Set())

  // Ref callback to capture the <webview> DOM element on attach.
  const webviewRef = useCallback((node: WebviewElement | null) => {
    if (node) {
      // The element can already be ready when the ref fires (e.g. a StrictMode
      // remount), so check before waiting for dom-ready to fire again.
      try {
        if (typeof node.isReady === 'function' && node.isReady()) setIsReady(true)
      } catch {
        // Treat an unavailable isReady() as "not ready yet".
      }
    }
    setWebviewNode(node)
  }, [])

  // Handles `ipc-message`, raised by the guest's ipcRenderer.sendToHost().
  useEffect(() => {
    if (!webviewNode) return

    setIsReady(false)

    const handleDomReady = (): void => {
      setIsReady(true)
    }

    const handleIpcMessage = (event: WebviewIpcMessageEvent): void => {
      const payload = event.args[0]
      switch (event.channel) {
        case 'dom-bridge:message':
          messageListenersRef.current.forEach((cb) => cb(payload as InboundPayload))
          break
        case 'dom-bridge:url':
          urlListenersRef.current.forEach((cb) => cb(payload as string))
          break
        case 'dom-bridge:add-to-notes':
          addToNotesListenersRef.current.forEach((cb) => cb(payload as string))
          break
        case 'dom-bridge:save-as-idea':
          saveAsIdeaListenersRef.current.forEach((cb) => cb(payload as string))
          break
        case 'dom-bridge:error':
          console.warn('[useWebviewBridge] Bridge error:', payload)
          break
        default:
          break
      }
    }

    webviewNode.addEventListener('dom-ready', handleDomReady)
    webviewNode.addEventListener('ipc-message', handleIpcMessage)

    return () => {
      webviewNode.removeEventListener('dom-ready', handleDomReady)
      webviewNode.removeEventListener('ipc-message', handleIpcMessage)
    }
  }, [webviewNode])

  /**
   * Transmits an outbound command payload to the guest webview.
   *
   * `webview.send()` is the supported path. The executeJavaScript fallback
   * dispatches through the guest's own `ipcRenderer`; the payload is passed as
   * a JSON literal argument rather than interpolated into the script body, so a
   * prompt containing quotes, newlines or backticks can't break out of it.
   */
  const sendOperation = useCallback(
    (payload: string): void => {
      if (!webviewNode) {
        console.warn('[useWebviewBridge] Cannot send operation: webview ref not attached.')
        return
      }

      try {
        webviewNode.send('dom-bridge:op', payload)
        return
      } catch (err) {
        console.warn('[useWebviewBridge] webview.send() failed, falling back:', err)
      }

      if (!isReady) {
        console.warn('[useWebviewBridge] Cannot send operation: webview not ready yet.')
        return
      }

      try {
        webviewNode.executeJavaScript?.(
          `require('electron').ipcRenderer.emit('dom-bridge:op', null, ${JSON.stringify(payload)})`
        )
      } catch (err) {
        console.error('[useWebviewBridge] All send methods failed:', err)
      }
    },
    [isReady, webviewNode]
  )

  /**
   * Registers callback for inbound DOM observation payloads emitted by guest webview
   */
  const onMessage = useCallback((callback: (data: InboundPayload) => void): (() => void) => {
    messageListenersRef.current.add(callback)
    return () => {
      messageListenersRef.current.delete(callback)
    }
  }, [])

  /**
   * Registers a callback fired when the guest webview's conversation URL changes.
   */
  const onUrl = useCallback((callback: (url: string) => void): (() => void) => {
    urlListenersRef.current.add(callback)
    return () => {
      urlListenersRef.current.delete(callback)
    }
  }, [])

  const onAddToNotes = useCallback((callback: (text: string) => void): (() => void) => {
    addToNotesListenersRef.current.add(callback)
    return () => {
      addToNotesListenersRef.current.delete(callback)
    }
  }, [])

  const onSaveAsIdea = useCallback((callback: (text: string) => void): (() => void) => {
    saveAsIdeaListenersRef.current.add(callback)
    return () => {
      saveAsIdeaListenersRef.current.delete(callback)
    }
  }, [])

  /**
   * Navigates the guest webview to a specific conversation URL (used to reopen a
   * saved session). No-op if we're already there.
   */
  const navigateTo = useCallback(
    (url: string): void => {
      if (!webviewNode) return
      try {
        if (webviewNode.getURL() === url) return
        webviewNode.loadURL(url)
      } catch (err) {
        console.warn('[useWebviewBridge] navigateTo failed:', err)
      }
    },
    [webviewNode]
  )

  /**
   * Navigates the guest webview and resolves once the new page's DOM is ready
   * (or after a timeout). Used to open a fresh chat before injecting context.
   */
  const navigateAndWait = useCallback(
    (url: string, timeoutMs = 20000): Promise<void> =>
      new Promise((resolve) => {
        if (!webviewNode) {
          resolve()
          return
        }
        let done = false
        const finish = (): void => {
          if (done) return
          done = true
          webviewNode.removeEventListener('dom-ready', onReady)
          resolve()
        }
        const onReady = (): void => finish()
        webviewNode.addEventListener('dom-ready', onReady)
        try {
          webviewNode.loadURL(url)
        } catch (err) {
          console.warn('[useWebviewBridge] navigateAndWait loadURL failed:', err)
          finish()
        }
        window.setTimeout(finish, timeoutMs)
      }),
    [webviewNode]
  )

  return {
    webviewRef,
    isReady,
    sendOperation,
    onMessage,
    onUrl,
    onAddToNotes,
    onSaveAsIdea,
    navigateTo,
    navigateAndWait
  }
}
