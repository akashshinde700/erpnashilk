import { db } from '@/lib/db'
import { companyRequired, handleError, ok } from '@/lib/erp-helpers'

// GET /api/numbering?companyId= → { seqs } document number sequences (read-only)
export async function GET(req: Request) {
  try {
    const companyId = await companyRequired(req)
    const seqs = await db.numberSeq.findMany({
      where: { companyId },
      orderBy: [{ docType: 'asc' }, { financialYear: 'desc' }],
    })
    return ok({ seqs })
  } catch (e) {
    return handleError(e)
  }
}
