'use client'

import * as React from 'react'
import { toast } from 'sonner'
import { Eye, EyeOff, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { apiPost } from '@/lib/use-api'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  userId: string
  userName?: string
}

export default function ChangePasswordDialog({ open, onOpenChange, userId, userName }: Props) {
  const [current, setCurrent] = React.useState('')
  const [next, setNext] = React.useState('')
  const [confirm, setConfirm] = React.useState('')
  const [show, setShow] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  function reset() {
    setCurrent(''); setNext(''); setConfirm(''); setShow(false); setError(null)
  }

  function close() {
    onOpenChange(false)
    reset()
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    if (!current || !next || !confirm) { setError('All fields are required'); return }
    if (next.length < 8) { setError('New password must be at least 8 characters'); return }
    if (next !== confirm) { setError('New passwords do not match'); return }
    if (next === current) { setError('New password must be different from the current one'); return }
    setSaving(true)
    try {
      await apiPost('/api/auth/change-password', { userId, currentPassword: current, newPassword: next, userName })
      toast.success('Password updated', { description: 'Use the new password on your next sign-in.' })
      close()
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to change password'
      setError(msg)
      toast.error(msg)
    } finally {
      setSaving(false)
    }
  }

  const strength = next.length === 0 ? 0 : next.length < 8 ? 1 : next.length < 10 ? 2 : /[0-9]/.test(next) && /[a-zA-Z]/.test(next) ? 3 : 2
  const strengthLabel = ['', 'Too short', 'Okay', 'Strong'][strength]
  const strengthClass = ['', 'bg-red-400', 'bg-amber-400', 'bg-emerald-500'][strength]

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) close(); else onOpenChange(true) }}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Change password</DialogTitle>
          <DialogDescription>Update your own sign-in password. You stay signed in.</DialogDescription>
        </DialogHeader>
        <form onSubmit={(e) => void submit(e)} className="space-y-3.5">
          <div className="space-y-1.5">
            <Label htmlFor="cp-current">Current password</Label>
            <div className="relative">
              <Input
                id="cp-current" type={show ? 'text' : 'password'} value={current} autoComplete="current-password"
                onChange={(e) => setCurrent(e.target.value)} placeholder="Your current password" className="pr-9"
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cp-new">New password</Label>
            <div className="relative">
              <Input
                id="cp-new" type={show ? 'text' : 'password'} value={next} autoComplete="new-password"
                onChange={(e) => setNext(e.target.value)} placeholder="At least 8 characters" className="pr-9"
              />
              <button
                type="button" onClick={() => setShow((s) => !s)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                aria-label={show ? 'Hide passwords' : 'Show passwords'}
              >
                {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
            {next && (
              <div className="flex items-center gap-2 pt-0.5">
                <div className="h-1 flex-1 rounded-full bg-muted overflow-hidden">
                  <div className={`h-full transition-all ${strengthClass}`} style={{ width: `${(strength / 3) * 100}%` }} />
                </div>
                <span className="text-[10px] text-muted-foreground w-14 text-right">{strengthLabel}</span>
              </div>
            )}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cp-confirm">Confirm new password</Label>
            <Input
              id="cp-confirm" type={show ? 'text' : 'password'} value={confirm} autoComplete="new-password"
              onChange={(e) => setConfirm(e.target.value)} placeholder="Repeat new password"
            />
          </div>
          {error && <p className="text-xs text-red-600" role="alert">{error}</p>}
          <DialogFooter className="gap-2 sm:gap-0">
            <Button type="button" variant="outline" onClick={close} disabled={saving}>Cancel</Button>
            <Button type="submit" disabled={saving} className="bg-emerald-600 hover:bg-emerald-700 text-white">
              {saving && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}
              Update password
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
