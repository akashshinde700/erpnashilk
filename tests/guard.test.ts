import { describe, expect, test } from 'bun:test'
import { checkTestDatabaseUrl } from './setup/test-db-guard'

const ok = 'mysql://u:p@127.0.0.1:3407/manuflow_test'

describe('test database guard', () => {
  test('accepts a loopback mysql database named *_test or test_*', () => {
    expect(checkTestDatabaseUrl({ TEST_DATABASE_URL: ok }).database).toBe('manuflow_test')
    expect(checkTestDatabaseUrl({ TEST_DATABASE_URL: 'mysql://u:p@localhost/test_manuflow' }).database).toBe('test_manuflow')
  })

  test('refuses when TEST_DATABASE_URL is missing, even if DATABASE_URL is set', () => {
    expect(() => checkTestDatabaseUrl({ DATABASE_URL: ok })).toThrow('TEST_DATABASE_URL is not set')
  })

  test('refuses non-mysql URLs and garbage', () => {
    expect(() => checkTestDatabaseUrl({ TEST_DATABASE_URL: 'file:./test.db' })).toThrow()
    expect(() => checkTestDatabaseUrl({ TEST_DATABASE_URL: 'not a url' })).toThrow('not a valid URL')
  })

  test('refuses database names that are not clearly test databases', () => {
    for (const name of ['manufacture', 'manuflow', 'testing', 'latest', 'contest', 'manuflow_test_backup']) {
      expect(() => checkTestDatabaseUrl({ TEST_DATABASE_URL: `mysql://u:p@127.0.0.1/${name}` })).toThrow('must end in "_test"')
    }
  })

  test('refuses remote hosts unless explicitly allowed', () => {
    const remote = 'mysql://u:p@203.0.113.10:3306/manuflow_test'
    expect(() => checkTestDatabaseUrl({ TEST_DATABASE_URL: remote })).toThrow('not loopback')
    expect(checkTestDatabaseUrl({ TEST_DATABASE_URL: remote, TEST_DATABASE_ALLOW_REMOTE: '1' }).host).toBe('203.0.113.10')
  })

  test('refuses when the test URL is the app database', () => {
    expect(() => checkTestDatabaseUrl({ TEST_DATABASE_URL: ok, DATABASE_URL: 'mysql://other:x@127.0.0.1:3407/manuflow_test' })).toThrow('same database as DATABASE_URL')
  })
})
