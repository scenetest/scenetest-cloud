import { describe, expect, it } from 'vitest'
import { commandEnv, isSafeRunId } from '../../../infra/box/agent.mjs'

// What systemd hands the agent: run.env (EnvironmentFile) plus the unit's
// Environment= lines and its defaults.
const agentEnv = {
  PATH: '/usr/local/bin:/usr/bin:/bin',
  LANG: 'C.UTF-8',
  HOME: '/root',
  USER: 'root',
  LOGNAME: 'root',
  INVOCATION_ID: 'abc',
  JOURNAL_STREAM: '8:1234',
  SCENETEST_BOX_ID: 'box-1',
  SCENETEST_REPO: 'acme/app',
  SCENETEST_HEAD_SHA: 'a'.repeat(40),
  SCENETEST_BASE_SHA: 'b'.repeat(40),
  SCENETEST_BASE_REF: 'main',
  SCENETEST_INGEST_URL: 'https://ci.example.com',
  SCENETEST_BEARER_TOKEN: 'secret-token',
  SCENETEST_RUN_AS: 'scenetest-run',
  SCENETEST_BLOCK_METADATA: '1',
}

const runUser = { name: 'scenetest-run', uid: 999, gid: 999, home: '/home/scenetest-run' }

describe('commandEnv', () => {
  it('passes nothing that names the agent, the deployment, or its credential', () => {
    const env = commandEnv(agentEnv, runUser)
    expect(Object.values(env)).not.toContain('secret-token')
    expect(Object.keys(env).filter((k) => k.startsWith('SCENETEST_'))).toEqual([])
  })

  it('is exactly the allowlist plus the run user identity', () => {
    expect(commandEnv(agentEnv, runUser)).toEqual({
      PATH: '/usr/local/bin:/usr/bin:/bin',
      LANG: 'C.UTF-8',
      HOME: '/home/scenetest-run',
      USER: 'scenetest-run',
      LOGNAME: 'scenetest-run',
    })
  })

  it('adds the caller extras on top', () => {
    const env = commandEnv(agentEnv, runUser, {
      SCENETEST_RUN_ID: 'r1',
      SCENETEST_REPORT_URL: 'http://127.0.0.1:4999/events/r1',
    })
    expect(env.SCENETEST_RUN_ID).toBe('r1')
    expect(env.SCENETEST_REPORT_URL).toBe('http://127.0.0.1:4999/events/r1')
    expect(env.SCENETEST_BEARER_TOKEN).toBeUndefined()
  })

  it('keeps the agent user identity when there is no run user', () => {
    const env = commandEnv({ HOME: '/home/dev', USER: 'dev', SCENETEST_BEARER_TOKEN: 't' }, null)
    expect(env).toEqual({ PATH: expect.any(String), HOME: '/home/dev', USER: 'dev' })
  })

  it('falls back to a system PATH when the agent has none', () => {
    expect(commandEnv({}, runUser).PATH).toBe('/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin')
  })
})

describe('isSafeRunId', () => {
  it('accepts uuids and the e2e fixture ids', () => {
    expect(isSafeRunId('3f1c2a9e-8b7d-4c6e-9a1b-2c3d4e5f6a7b')).toBe(true)
    expect(isSafeRunId('e2e-agent-run')).toBe(true)
  })

  it('rejects anything that could leave the work directory', () => {
    for (const id of ['../etc/cron.d/x', '..', '.', 'a/b', 'a\\b', '/etc/passwd', '-rf', '', 'a b', 'a\nb']) {
      expect(isSafeRunId(id), JSON.stringify(id)).toBe(false)
    }
  })

  it('rejects non-strings and overlong ids', () => {
    expect(isSafeRunId(undefined)).toBe(false)
    expect(isSafeRunId(42)).toBe(false)
    expect(isSafeRunId('a'.repeat(129))).toBe(false)
  })
})
