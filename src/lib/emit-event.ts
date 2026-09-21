// Task 6-c — server-side helper: fire a real-time notification event at the
// notify-service (mini-services/notify-service, port 3003). Fire-and-forget,
// dependency-free, never throws (service-down is silently ignored).

export type NotifyLevel = 'INFO' | 'WARNING' | 'CRITICAL'

export interface EmitEventPayload {
  companyId: string
  title: string
  message?: string
  level?: NotifyLevel
  topic?: string
}

export async function emitEvent(payload: EmitEventPayload): Promise<void> {
  try {
    await fetch('http://127.0.0.1:3003/emit', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-notify-secret': 'manuflow-rt-secret' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(800),
    })
  } catch {
    /* notify-service down — silent, real-time is best-effort */
  }
}
