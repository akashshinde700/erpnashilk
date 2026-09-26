import type { Metadata } from 'next'
import PlatformAdmin from '@/components/platform/platform-admin'

export const metadata: Metadata = {
  title: 'Platform Admin · ManuFlow ERP',
  robots: { index: false, follow: false },
}

export default function PlatformAdminPage() {
  return <PlatformAdmin />
}
