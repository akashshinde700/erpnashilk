import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Offline · ManuFlow ERP',
  description: 'ManuFlow ERP is offline.',
}

/**
 * Served by the service worker when a navigation request fails with no network and no cached copy.
 * Deliberately static and dependency-free: it must render from cache with no app JavaScript.
 */
export default function OfflinePage() {
  return (
    <main className="min-h-screen-safe grid place-items-center bg-background px-6 py-10">
      <div className="w-full max-w-sm text-center">
        <div className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-warning-soft text-warning">
          <svg
            viewBox="0 0 24 24"
            className="h-7 w-7"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.75"
            aria-hidden="true"
          >
            <path d="M2 8.8a15 15 0 0 1 20 0M5 12.5a10 10 0 0 1 14 0M8.5 16.2a5 5 0 0 1 7 0" strokeLinecap="round" />
            <circle cx="12" cy="20" r="1" fill="currentColor" stroke="none" />
          </svg>
        </div>
        <h1 className="mt-4 text-xl font-semibold tracking-tight">You&apos;re offline</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          ManuFlow needs a connection to load stock, invoices and production data. Nothing is saved while you
          are offline — reconnect and the page you were on will load normally.
        </p>
        <p className="mt-4 text-xs text-muted-foreground">
          Records already on screen keep showing their last loaded values.
        </p>
      </div>
    </main>
  )
}
