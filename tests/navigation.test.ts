import { describe, expect, test } from 'bun:test'
import { MODULES, MODULE_GROUPS, findModule } from '@/components/erp/registry'
import { ROLES, canAccessModule } from '@/lib/erp-constants'

describe('Utilities → Import Center navigation', () => {
  test('the Utilities group sits before Admin and lists the Import Center', () => {
    const groups = [...MODULE_GROUPS]
    expect(groups.indexOf('Utilities')).toBe(groups.indexOf('Admin') - 1)
    const m = findModule('import-center')
    expect(m).toMatchObject({ key: 'import-center', label: 'Import Center', group: 'Utilities' })
    expect(m?.hidden).toBeFalsy() // listed in the sidebar (and so in the command palette / favourites)
    expect(MODULES.filter((x) => x.group === 'Utilities' && !x.hidden).map((x) => x.key)).toEqual(['import-center'])
    expect(MODULES.filter((x) => x.key === 'import-center')).toHaveLength(1)
  })

  test('only administrators see it', () => {
    const allowed = ROLES.filter((r) => canAccessModule(r, 'import-center'))
    expect(allowed).toEqual(['TENANT_ADMIN', 'MANAGEMENT'])
    expect(canAccessModule('SUPER_ADMIN', 'import-center')).toBe(true)
  })
})
