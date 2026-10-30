'use client'

import * as React from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { apiPost } from '@/lib/use-api'
import { toast } from 'sonner'
import { Eye, EyeOff, Factory, ScrollText, Loader2, Percent, ShieldCheck, ArrowRight, CheckCircle2 } from 'lucide-react'

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
  const errorRef = React.useRef<HTMLParagraphElement>(null)

  React.useEffect(() => {
    if (error) errorRef.current?.focus()
  }, [error])

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
    <div className="grid min-h-screen bg-background lg:grid-cols-[1.05fr_1fr]">
      {/* Brand panel — the only place in the app that uses the deep emerald field, so signing in
          feels like entering the product rather than filling a generic form. */}
      <aside className="relative hidden overflow-hidden bg-[oklch(0.24_0.06_165)] p-10 text-emerald-50 lg:flex lg:flex-col lg:justify-between xl:p-14">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0"
          style={{
            backgroundImage:
              'radial-gradient(720px 460px at 12% 0%, oklch(0.55 0.13 163 / 45%), transparent 62%), radial-gradient(620px 420px at 92% 18%, oklch(0.62 0.13 60 / 22%), transparent 60%)',
          }}
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 opacity-[0.14]"
          style={{
            backgroundImage:
              'linear-gradient(to right, oklch(1 0 0 / 18%) 1px, transparent 1px), linear-gradient(to bottom, oklch(1 0 0 / 18%) 1px, transparent 1px)',
            backgroundSize: '56px 56px',
            maskImage: 'radial-gradient(70% 60% at 30% 10%, black, transparent)',
          }}
        />

        <div className="relative">
          <div className="flex items-center gap-3">
            <div className="rounded-xl bg-white/10 p-2.5 ring-1 ring-inset ring-white/15 backdrop-blur">
              <Factory className="h-6 w-6 text-emerald-200" aria-hidden="true" />
            </div>
            <div>
              <p className="text-lg font-semibold tracking-tight">ManuFlow ERP</p>
              <p className="text-xs text-emerald-200/75">Manufacturing SaaS Suite</p>
            </div>
          </div>

          <h1 className="mt-14 max-w-lg text-3xl font-semibold leading-[1.15] tracking-tight text-balance xl:text-[2.6rem]">
            Run your factory end-to-end —<br />
            <span className="text-emerald-200">from enquiry to invoice.</span>
          </h1>
          <p className="mt-4 max-w-md text-sm leading-relaxed text-emerald-100/75">
            Manufacturing SaaS Suite for Indian factories — GST-ready, multi-tenant and built for the shop floor.
          </p>

          <ul className="mt-10 grid max-w-md gap-4">
            {FEATURES.map((f) => (
              <li key={f.title} className="flex items-start gap-3">
                <div className="mt-0.5 shrink-0 rounded-lg bg-white/8 p-2 ring-1 ring-inset ring-white/12">
                  <f.icon className="h-4 w-4 text-emerald-200" aria-hidden="true" />
                </div>
                <div>
                  <p className="text-sm font-medium">{f.title}</p>
                  <p className="text-xs leading-relaxed text-emerald-100/65">{f.sub}</p>
                </div>
              </li>
            ))}
          </ul>
        </div>

        <div className="relative flex flex-wrap items-center gap-x-4 gap-y-1.5 border-t border-white/12 pt-5 text-xs text-emerald-100/70">
          <span className="inline-flex items-center gap-1.5 font-medium text-emerald-100">
            <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" /> 29 modules
          </span>
          <span aria-hidden="true">·</span>
          <span>multi-tenant</span>
          <span aria-hidden="true">·</span>
          <span>GST-ready</span>
          <span aria-hidden="true">·</span>
          <span>audit-logged</span>
        </div>
      </aside>

      {/* Login panel */}
      <main className="brand-wash flex items-center justify-center p-4 sm:p-8">
        <div className="w-full max-w-[400px]">
          {/* Mobile brand lockup (the aside is hidden below lg) */}
          <div className="mb-6 flex items-center gap-3 lg:hidden">
            <div className="grid h-10 w-10 place-items-center rounded-xl bg-primary text-primary-foreground elev-1">
              <Factory className="h-5 w-5" aria-hidden="true" />
            </div>
            <div className="leading-tight">
              <p className="text-sm font-semibold tracking-tight">ManuFlow ERP</p>
              <p className="text-[11px] text-muted-foreground">Manufacturing SaaS Suite</p>
            </div>
          </div>

          <div className="rounded-2xl border bg-card p-6 shadow-[var(--shadow-2)] sm:p-8">
            <div className="mb-6">
              <h2 className="text-xl font-semibold tracking-tight">Sign in to ManuFlow ERP</h2>
              <p className="mt-1 text-sm text-muted-foreground">Use your workspace account to continue</p>
            </div>

            <form onSubmit={submit} className="grid gap-4" noValidate>
              <div className="grid gap-1.5">
                <Label htmlFor="login-email" className="text-xs font-medium text-muted-foreground">Email</Label>
                <Input
                  id="login-email"
                  type="email"
                  inputMode="email"
                  autoComplete="email"
                  autoFocus
                  placeholder="you@company.in"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  disabled={loading}
                  aria-invalid={!!error}
                  aria-describedby={error ? 'login-error' : undefined}
                  className="h-10"
                />
              </div>

              <div className="grid gap-1.5">
                <Label htmlFor="login-password" className="text-xs font-medium text-muted-foreground">Password</Label>
                <div className="relative">
                  <Input
                    id="login-password"
                    type={showPw ? 'text' : 'password'}
                    autoComplete="current-password"
                    placeholder="••••••••"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    disabled={loading}
                    className="h-10 pr-10"
                    aria-invalid={!!error}
                    aria-describedby={error ? 'login-error' : undefined}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPw((s) => !s)}
                    className="absolute right-1.5 top-1/2 grid h-7 w-7 -translate-y-1/2 cursor-pointer place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                    aria-label={showPw ? 'Hide password' : 'Show password'}
                    aria-pressed={showPw}
                  >
                    {showPw ? <EyeOff className="h-4 w-4" aria-hidden="true" /> : <Eye className="h-4 w-4" aria-hidden="true" />}
                  </button>
                </div>
              </div>

              {/* Text-only <p role="alert"> on purpose: the message must read exactly as the server
                  phrased it (asserted in e2e/specs/01-auth.spec.ts), so the glyph lives in styling
                  rather than the DOM. */}
              {error && (
                <p
                  id="login-error"
                  ref={errorRef}
                  role="alert"
                  tabIndex={-1}
                  className="rounded-lg border border-danger-border bg-danger-soft px-3 py-2 text-sm font-medium text-destructive"
                >
                  {error}
                </p>
              )}

              <Button type="submit" className="mt-1 h-10 w-full gap-2" disabled={loading} aria-busy={loading || undefined}>
                {loading ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />Signing in…
                  </>
                ) : (
                  <>
                    Sign in
                    <ArrowRight className="h-4 w-4" aria-hidden="true" />
                  </>
                )}
              </Button>
            </form>

            <p className="mt-5 text-center text-[11px] leading-relaxed text-muted-foreground">
              Access is granted by your administrator. Forgot your password? Ask an admin to reset it from{' '}
              <span className="whitespace-nowrap font-medium text-foreground/80">Settings → Users</span>.
            </p>
          </div>

          <p className="mt-4 text-center text-[11px] text-muted-foreground">
            Multi-tenant SaaS · FY Apr–Mar · Data stays in your workspace
          </p>
        </div>
      </main>
    </div>
  )
}
