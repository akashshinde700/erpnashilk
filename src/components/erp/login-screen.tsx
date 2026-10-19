'use client'

import * as React from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { apiPost } from '@/lib/use-api'
import { toast } from 'sonner'
import { Eye, EyeOff, Factory, ScrollText, Loader2, Percent, ShieldCheck } from 'lucide-react'

export interface LoginUser {
  id: string
  name: string
  email: string
  role: string
  companyId: string
}

export interface LoginCompany {
  id: string
  name: string
  logoText: string | null
  gstin: string | null
  city: string | null
}

const FEATURES = [
  { icon: ScrollText, title: 'Order to cash', sub: 'Enquiries → quotations → orders → invoices' },
  { icon: Factory, title: 'Production + MRP', sub: 'Work orders, BOM explosion, material planning' },
  { icon: Percent, title: 'GST invoicing', sub: 'CGST/SGST/IGST splits, GSTR-ready reports' },
  { icon: ShieldCheck, title: 'Role-based access', sub: 'Multi-tenant with per-role module gating' },
]

export default function LoginScreen({ onLogin }: { onLogin: (user: LoginUser, company: LoginCompany) => void }) {
  const [email, setEmail] = React.useState('')
  const [password, setPassword] = React.useState('')
  const [showPw, setShowPw] = React.useState(false)
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (loading) return
    setError(null)
    if (!email.trim() || !password) {
      setError('Enter your email and password')
      return
    }
    setLoading(true)
    try {
      const d = await apiPost<{ user: LoginUser; company: LoginCompany }>('/api/auth/login', {
        email: email.trim(),
        password,
      })
      toast.success(`Welcome back, ${d.user.name}`)
      onLogin(d.user, d.company)
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Login failed. Please try again.'
      setError(msg)
      toast.error(msg)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen grid lg:grid-cols-2 bg-background">
      {/* Brand panel */}
      <aside className="hidden lg:flex flex-col justify-between bg-gradient-to-br from-emerald-950 via-emerald-900 to-teal-900 text-emerald-50 p-10 xl:p-14">
        <div>
          <div className="flex items-center gap-3">
            <div className="rounded-xl bg-emerald-400/15 p-3 ring-1 ring-emerald-300/20">
              <Factory className="h-7 w-7 text-emerald-300" aria-hidden="true" />
            </div>
            <div>
              <p className="text-lg font-bold tracking-tight">ManuFlow ERP</p>
              <p className="text-xs text-emerald-300/80">Manufacturing SaaS Suite</p>
            </div>
          </div>

          <h1 className="mt-14 text-3xl xl:text-4xl font-bold leading-tight tracking-tight">
            Run your factory end-to-end —
            <br />
            from enquiry to invoice.
          </h1>
          <p className="mt-3 text-sm text-emerald-200/80 max-w-md">
            Manufacturing SaaS Suite for Indian factories — GST-ready, multi-tenant and built for the shop floor.
          </p>

          <ul className="mt-10 space-y-5 max-w-md">
            {FEATURES.map((f) => (
              <li key={f.title} className="flex items-start gap-3">
                <div className="mt-0.5 rounded-lg bg-emerald-400/10 p-2 ring-1 ring-emerald-300/15 shrink-0">
                  <f.icon className="h-4 w-4 text-emerald-300" aria-hidden="true" />
                </div>
                <div>
                  <p className="text-sm font-semibold">{f.title}</p>
                  <p className="text-xs text-emerald-200/70">{f.sub}</p>
                </div>
              </li>
            ))}
          </ul>
        </div>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-emerald-200/70 border-t border-emerald-400/15 pt-5">
          <span className="font-semibold text-emerald-100">29 modules</span>
          <span aria-hidden="true">·</span>
          <span>multi-tenant</span>
          <span aria-hidden="true">·</span>
          <span>GST-ready</span>
        </div>
      </aside>

      {/* Login panel */}
      <main className="flex items-center justify-center p-4 sm:p-6">
        <Card className="w-full max-w-md">
          <CardHeader className="text-center">
            <div className="mx-auto mb-2 flex h-11 w-11 items-center justify-center rounded-xl bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300 lg:hidden">
              <Factory className="h-6 w-6" aria-hidden="true" />
            </div>
            <CardTitle className="text-xl">Sign in to ManuFlow ERP</CardTitle>
            <CardDescription>Use your workspace account to continue</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={submit} className="grid gap-4" noValidate>
              <div className="grid gap-1.5">
                <Label htmlFor="login-email">Email</Label>
                <Input
                  id="login-email"
                  type="email"
                  autoComplete="email"
                  placeholder="you@company.in"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  disabled={loading}
                  aria-invalid={!!error}
                />
              </div>

              <div className="grid gap-1.5">
                <Label htmlFor="login-password">Password</Label>
                <div className="relative">
                  <Input
                    id="login-password"
                    type={showPw ? 'text' : 'password'}
                    autoComplete="current-password"
                    placeholder="••••••••"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    disabled={loading}
                    className="pr-10"
                    aria-invalid={!!error}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPw((s) => !s)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
                    aria-label={showPw ? 'Hide password' : 'Show password'}
                  >
                    {showPw ? <EyeOff className="h-4 w-4" aria-hidden="true" /> : <Eye className="h-4 w-4" aria-hidden="true" />}
                  </button>
                </div>
              </div>

              {error && (
                <p role="alert" className="text-sm text-red-600 dark:text-red-400">
                  {error}
                </p>
              )}

              <Button type="submit" className="w-full h-10" disabled={loading}>
                {loading ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" aria-hidden="true" />Signing in…
                  </>
                ) : (
                  'Sign in'
                )}
              </Button>
            </form>
          </CardContent>
        </Card>
      </main>
    </div>
  )
}
