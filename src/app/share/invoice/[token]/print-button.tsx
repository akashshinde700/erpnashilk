'use client'

// "Print / Save as PDF" on the public shared-invoice page (hidden in the printout itself).
export default function PrintButton() {
  return (
    <button type="button" className="si-print-btn" onClick={() => window.print()}>
      Print / Save as PDF
    </button>
  )
}
