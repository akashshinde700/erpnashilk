'use client'

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import { Kbd } from '@/components/erp/kit'

interface ShortcutItem {
  keys: string[][]
  desc: string
}

const GROUPS: { title: string; items: ShortcutItem[] }[] = [
  {
    title: 'General',
    items: [
      { keys: [['Ctrl', 'K']], desc: 'Command palette — search modules, items, orders, invoices' },
      { keys: [['/']], desc: 'Open search' },
      { keys: [['?']], desc: 'Show this shortcuts help' },
      { keys: [['n']], desc: 'New document on the current screen' },
      { keys: [['Alt', 'S']], desc: 'New Sales Invoice (from anywhere)' },
      { keys: [['Alt', 'P']], desc: 'New Purchase Bill (from anywhere)' },
      { keys: [['Ctrl', 'S']], desc: 'Save the open form (Ctrl + Enter also works)' },
      { keys: [['Esc']], desc: 'Close dialogs & menus' },
    ],
  },
  {
    title: 'Navigate modules',
    items: [
      { keys: [['[']], desc: 'Previous module' },
      { keys: [[']']], desc: 'Next module' },
      { keys: [['g', 'd']], desc: 'Dashboard' },
      { keys: [['g', 'i']], desc: 'Items' },
      { keys: [['g', 'c']], desc: 'Customers' },
      { keys: [['g', 'v']], desc: 'Suppliers' },
      { keys: [['g', 's']], desc: 'Stock' },
      { keys: [['g', 'o']], desc: 'Sales Orders' },
      { keys: [['g', 'q']], desc: 'Quotations' },
      { keys: [['g', 'e']], desc: 'Enquiries' },
      { keys: [['g', 'n']], desc: 'Sales Invoices' },
      { keys: [['g', 'p']], desc: 'Purchase Orders' },
      { keys: [['g', 'w']], desc: 'Work Orders' },
      { keys: [['g', 'm']], desc: 'MRP' },
      { keys: [['g', 'r']], desc: 'Reports Center' },
      { keys: [['g', 'x']], desc: 'Parties (customers & suppliers)' },
      { keys: [['g', 'h']], desc: 'Delivery Challans' },
      { keys: [['g', 'y']], desc: 'Payment In / Out' },
      { keys: [['g', 'k']], desc: 'Outstanding (receivables)' },
      { keys: [['g', 'g']], desc: 'GRN' },
      { keys: [['g', 'f']], desc: 'Purchase Invoices' },
      { keys: [['g', 'b']], desc: 'BOM' },
      { keys: [['g', 'l']], desc: 'Stock Ledger' },
      { keys: [['g', 't']], desc: 'Stock Transfers' },
      { keys: [['g', 'u']], desc: 'Users & Roles' },
      { keys: [['g', 'a']], desc: 'Audit Log' },
    ],
  },
]

export default function ShortcutsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md p-0 gap-0">
        <DialogHeader className="px-5 pt-5 pb-3">
          <DialogTitle className="flex items-center gap-2 text-base">
            Keyboard shortcuts
            <span className="text-[10px] font-normal text-muted-foreground">press <Kbd>?</Kbd> anytime</span>
          </DialogTitle>
          <DialogDescription className="text-xs">
            Shortcuts only trigger outside input fields. <Kbd>g</Kbd> sequences work for modules your role can access.
          </DialogDescription>
        </DialogHeader>
        <Separator />
        <ScrollArea className="max-h-[60vh]">
          <div className="px-5 py-4 space-y-4">
            {GROUPS.map((group) => (
              <section key={group.title} aria-label={group.title}>
                <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-2">{group.title}</p>
                <div className="space-y-1">
                  {group.items.map((item) => (
                    <div key={item.desc} className="flex items-center justify-between gap-3 rounded-md px-2 py-1.5 hover:bg-muted/60">
                      <span className="text-[13px] text-foreground/90">{item.desc}</span>
                      <span className="flex items-center gap-1 shrink-0">
                        {item.keys.map((combo, i) => (
                          <span key={i} className="flex items-center gap-1">
                            {i > 0 && <span className="text-[10px] text-muted-foreground">then</span>}
                            {combo.map((k) => (
                              <Kbd key={k}>{k}</Kbd>
                            ))}
                          </span>
                        ))}
                      </span>
                    </div>
                  ))}
                </div>
              </section>
            ))}
            <p className="text-[11px] text-muted-foreground pt-1">
              Tip: star a module in the sidebar to pin it under Favorites for one-click access.
            </p>
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  )
}
