import { ApiError, companyRequired, handleError, ok, requireWrite } from '@/lib/erp-helpers'
import { cleanFileName } from '@/app/api/import-center/_shared'
import { VYAPAR_LIMITS, readVyaparBackup } from '@/lib/vyapar/backup'
import { dropSnapshot, putSnapshot, snapshotView } from '@/lib/vyapar/store'

// POST /api/import-center/vyapar/inspect — multipart: file (.vyb or .vyp), companyId?
// Reads the Vyapar backup on the server (nothing stored, nothing written) and returns what it holds:
// the company, party / item / voucher counts, the units ManuFlow has no equivalent for, warnings.
// The parsed snapshot stays in server memory (30 minutes) and is what the import route reads — the
// browser never sends the backup's data back.
export async function POST(req: Request) {
  try {
    const len = Number(req.headers.get('content-length') || '')
    if (!Number.isFinite(len) || len <= 0) throw new ApiError('Upload size is required (Content-Length)', 411)
    if (len > VYAPAR_LIMITS.maxFileBytes + 64 * 1024) {
      throw new ApiError(`The backup is larger than ${VYAPAR_LIMITS.maxFileBytes / (1024 * 1024)} MB`, 413)
    }
    requireWrite(req, 'import-center')
    const form = await req.formData().catch(() => null)
    if (!form) throw new ApiError('Send the file as multipart/form-data', 400)
    const companyId = await companyRequired(req, typeof form.get('companyId') === 'string' ? String(form.get('companyId')) : undefined)
    const file = form.get('file')
    if (!file || typeof file === 'string') throw new ApiError('Choose the Vyapar backup file', 400)
    if (file.size > VYAPAR_LIMITS.maxFileBytes) {
      throw new ApiError(`The backup is larger than ${VYAPAR_LIMITS.maxFileBytes / (1024 * 1024)} MB`, 413)
    }
    const fileName = cleanFileName(file.name)
    const { snapshot } = readVyaparBackup(Buffer.from(await file.arrayBuffer()), fileName)
    const id = putSnapshot(companyId, snapshot)
    return ok(snapshotView(id, snapshot), 'Vyapar backup read')
  } catch (e) {
    return handleError(e)
  }
}

// DELETE /api/import-center/vyapar/inspect?companyId=&snapshotId= — close the flow, forget the data.
export async function DELETE(req: Request) {
  try {
    requireWrite(req, 'import-center')
    const url = new URL(req.url)
    const companyId = await companyRequired(req, url.searchParams.get('companyId') ?? undefined)
    dropSnapshot(companyId, url.searchParams.get('snapshotId'))
    return ok({ dropped: true })
  } catch (e) {
    return handleError(e)
  }
}
