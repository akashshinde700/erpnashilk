'use client'

import * as React from 'react'

/**
 * Registers the service worker (public/sw.js) in production builds only.
 *
 * Development is skipped on purpose: `next dev` streams HMR over its own connections, and a service
 * worker caching `/_next/static/**` while chunks change per compile produces confusing stale bundles.
 *
 * Update policy: when a new worker takes control of the page, reload once so the user is never left on
 * half-old JavaScript. We only do that when the page was already controlled by a worker before (a
 * first-ever install must not reload), so the first visit stays a single load.
 */
export function ServiceWorkerRegistrar() {
  React.useEffect(() => {
    if (process.env.NODE_ENV !== 'production') return
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return

    const hadController = !!navigator.serviceWorker.controller
    let reloading = false

    const onControllerChange = () => {
      if (!hadController || reloading) return
      reloading = true
      window.location.reload()
    }

    navigator.serviceWorker.addEventListener('controllerchange', onControllerChange)

    const register = async () => {
      try {
        const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' })
        // A worker installed before this page loaded can already be waiting.
        reg.waiting?.postMessage('SKIP_WAITING')
        reg.addEventListener('updatefound', () => {
          const sw = reg.installing
          if (!sw) return
          sw.addEventListener('statechange', () => {
            if (sw.state === 'installed') reg.waiting?.postMessage('SKIP_WAITING')
          })
        })
      } catch {
        // Offline, private mode or a blocked registration: the app works without it.
      }
    }

    // Do not compete with the first paint / hydration-critical requests.
    if (document.readyState === 'complete') void register()
    else window.addEventListener('load', () => void register(), { once: true })

    return () => navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange)
  }, [])

  return null
}
