/**
 * HTML helpers for the print / download layer.
 *
 * Everything the app prints goes through `printHtml()` in `src/components/erp/kit.tsx`, which writes a
 * whole document into a new window with `document.write`. That window inherits the app's origin, so a
 * `<script>` smuggled into the print output runs with the signed-in user's session — i.e. it is a stored
 * XSS, not a cosmetic problem.
 *
 * The rule for callers: **`body` must be markup the caller built, with every interpolated value escaped**
 * (each module has its own `esc()` for that). This module is responsible for the parts the caller does not
 * build — the document shell and its <title>.
 */

/** Escape a value for HTML text/attribute context (also escapes quotes, so it is attribute-safe). */
export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

const PRINT_CSS = `
  <style>
    * { box-sizing: border-box; }
    body { font-family: -apple-system, 'Segoe UI', Arial, sans-serif; color: #111; padding: 28px; font-size: 13px; }
    h1 { font-size: 20px; margin: 0 0 2px; }
    table { width: 100%; border-collapse: collapse; margin-top: 14px; }
    th, td { border: 1px solid #ddd; padding: 7px 9px; text-align: left; font-size: 12px; }
    th { background: #f4f4f5; font-weight: 600; }
    .num { text-align: right; }
    .muted { color: #666; font-size: 11px; }
    .totals td { border: none; padding: 3px 8px; }
    .totals .num { font-weight: 600; }
    .grand { font-size: 14px; font-weight: 700; border-top: 2px solid #111; }
    .head { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid #111; padding-bottom: 12px; }
    .badge { display: inline-block; border: 1px solid #999; border-radius: 4px; padding: 2px 8px; font-size: 10px; letter-spacing: 1px; }
    @media print { body { padding: 12px; } }
  </style>`

/**
 * The full print document. `title` is escaped here (it comes from user data — e.g. a party name in
 * "Statement of Account — …"); `body` is caller-built markup and must already be escaped by the caller.
 */
export function printDocument(title: string, body: string): string {
  return `<!DOCTYPE html><html><head><title>${escapeHtml(title)}</title>${PRINT_CSS}</head><body>${body}
  <script>window.onload = function(){ window.print(); }</script>
  </body></html>`
}
