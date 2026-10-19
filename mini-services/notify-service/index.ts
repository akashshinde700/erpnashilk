// ManuFlow — real-time notification broadcast service (Task 6-c)
// Single port 3003: socket.io (rooms per companyId) + REST endpoints (/emit, /health).
// NOTE: engine.io's attach() intercepts ALL requests when path is '/' (its check is a
// prefix match), so after attaching we re-take control of the 'request' event with a
// dispatcher that routes REST paths to our handler and socket.io traffic to engine.io.
import { createServer, type IncomingMessage, type ServerResponse } from 'http'
import { Server } from 'socket.io'

const PORT = 3003
const SECRET = process.env.NOTIFY_SECRET || ''
const LEVELS = ['INFO', 'WARNING', 'CRITICAL'] as const

interface NotificationPayload {
  id: string
  companyId: string
  title: string
  message: string
  level: (typeof LEVELS)[number]
  createdAt: string
  topic?: string
}

const httpServer = createServer()

const io = new Server(httpServer, {
  // DO NOT change the path, it is used by Caddy to forward the request to the correct port
  path: '/',
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
  pingTimeout: 60000,
  pingInterval: 25000,
})

// ------------------------------ socket.io ------------------------------

function roomOf(data: unknown): string | null {
  if (typeof data === 'string') return data.trim() || null
  if (data && typeof data === 'object') {
    const d = data as Record<string, unknown>
    for (const key of ['companyId', 'room', 'company']) {
      const v = d[key]
      if (typeof v === 'string' && v.trim()) return v.trim()
    }
  }
  return null
}

io.on('connection', (socket) => {
  console.log(`[notify] connect ${socket.id}`)

  socket.on('join', (data: unknown) => {
    const room = roomOf(data)
    if (!room) {
      console.log(`[notify] join rejected for ${socket.id}: no companyId`)
      return
    }
    socket.join(room)
    socket.emit('erp:joined', { companyId: room })
    console.log(`[notify] socket ${socket.id} joined room ${room}`)
  })

  socket.on('leave', (data: unknown) => {
    const room = roomOf(data)
    if (!room) return
    socket.leave(room)
    socket.emit('erp:left', { companyId: room })
    console.log(`[notify] socket ${socket.id} left room ${room}`)
  })

  socket.on('disconnect', (reason: string) => {
    console.log(`[notify] disconnect ${socket.id} (${reason})`)
  })

  socket.on('error', (error: unknown) => {
    console.error(`[notify] socket error (${socket.id}):`, error)
  })
})

// ------------------------------ REST ------------------------------

function readBody(req: IncomingMessage, limit = 64 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > limit) {
        reject(new Error('Body too large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, {
    'content-type': 'application/json',
    'access-control-allow-origin': '*',
  })
  res.end(JSON.stringify(body))
}

async function handleRest(req: IncomingMessage, res: ServerResponse) {
  const url = (req.url || '').split('?')[0]

  // GET /health → { ok, clients, rooms }
  if (url === '/health' && req.method === 'GET') {
    const rooms = Array.from(io.sockets.adapter.rooms.entries())
      .filter(([name]) => !io.sockets.sockets.has(name))
      .map(([room, sockets]) => ({ room, size: sockets.size }))
    return json(res, 200, { ok: true, clients: io.engine.clientsCount, rooms })
  }

  // POST /emit — { companyId, title, message?, level?, topic? }
  if (url === '/emit' && req.method === 'POST') {
    if (!SECRET || req.headers['x-notify-secret'] !== SECRET) {
      return json(res, 401, { ok: false, error: 'Unauthorized' })
    }
    let raw: string
    try {
      raw = await readBody(req)
    } catch {
      return json(res, 400, { ok: false, error: 'Invalid request body' })
    }
    let body: Record<string, unknown>
    try {
      body = JSON.parse(raw || '{}')
    } catch {
      return json(res, 400, { ok: false, error: 'Body must be valid JSON' })
    }
    const companyId = typeof body.companyId === 'string' ? body.companyId.trim() : ''
    if (!companyId) {
      return json(res, 400, { ok: false, error: 'companyId is required' })
    }
    const levelRaw = typeof body.level === 'string' ? body.level.toUpperCase() : 'INFO'
    const level = (LEVELS as readonly string[]).includes(levelRaw)
      ? (levelRaw as NotificationPayload['level'])
      : 'INFO'
    const payload: NotificationPayload = {
      id: crypto.randomUUID(),
      companyId,
      title: typeof body.title === 'string' && body.title.trim() ? body.title.trim() : 'Notification',
      message: typeof body.message === 'string' ? body.message : '',
      level,
      createdAt: new Date().toISOString(),
    }
    if (typeof body.topic === 'string' && body.topic.trim()) payload.topic = body.topic.trim()

    io.to(companyId).emit('erp:notification', payload)
    io.to(companyId).emit('erp:ping', { ts: Date.now() })
    console.log(`[notify] emit → room ${companyId}: "${payload.title}" (${payload.level}, ${io.sockets.adapter.rooms.get(companyId)?.size ?? 0} clients)`)
    return json(res, 200, { ok: true, rooms: io.sockets.adapter.rooms.get(companyId)?.size ?? 0 })
  }

  return json(res, 404, { ok: false, error: 'Not found' })
}

// ------------------------------ start ------------------------------

httpServer.listen(PORT, '127.0.0.1', () => {
  console.log(`[notify] notify-service listening on port ${PORT}`)
})

// engine.io takes over the 'request' event when attaching and, with path '/',
// would intercept EVERY request (check is a prefix match). Re-take control:
// REST paths → our handler, engine.io-looking traffic → engine.io, rest → 404.
const engineListeners = httpServer.listeners('request')
httpServer.removeAllListeners('request')
httpServer.on('request', (req, res) => {
  const url = (req.url || '').split('?')[0]
  if (url === '/emit' || url === '/health') {
    handleRest(req, res).catch((err) => {
      console.error('[notify] REST handler error:', err)
      if (!res.headersSent) json(res, 500, { ok: false, error: 'Internal error' })
    })
    return
  }
  const raw = req.url || ''
  const looksLikeEngineIo =
    raw.startsWith('/socket.io') || raw.includes('EIO=') || raw.includes('transport=')
  if (looksLikeEngineIo) {
    for (const l of engineListeners) l.call(httpServer, req, res)
    return
  }
  json(res, 404, { ok: false, error: 'Not found' })
})

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('[notify] SIGTERM received, shutting down...')
  io.close()
  httpServer.close(() => process.exit(0))
})

process.on('SIGINT', () => {
  console.log('[notify] SIGINT received, shutting down...')
  io.close()
  httpServer.close(() => process.exit(0))
})
