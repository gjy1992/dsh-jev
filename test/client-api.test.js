/** 浏览器端 + HTTP 路由的契约测试：真装载、真发送信封、真的走到服务。 */
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { API_PATH, createApiHandler } from '../src/api.js'
import { loadSettings } from '../src/settings.js'
import { JevService } from '../src/service.js'

/** 用一个假的 ModuleLoader 把浏览器端跑起来，返回它注册的模块。 */
async function loadClient() {
  const captured = {}
  globalThis.window = {
    __ModuleLoader__: {
      load: ({ id, factory }) => {
        assert.equal(id, 'dsh-jev', 'ModuleLoader 的 id 必须与 package.json 对齐')
        captured.id = id
        captured.module = factory((spec) => {
          if (spec === 'react') {
            return { createElement: () => null, useState: () => [], useEffect: () => {}, useCallback: (f) => f }
          }
          throw new Error('unexpected require: ' + spec)
        })
      },
    },
  }
  // 加个 query 绕开 ESM 模块缓存，保证每次都是全新的一次装载。
  await import('../lib/client.js?' + Date.now())
  return captured
}

test('浏览器端：是 ModuleLoader 信封，且注册了 settings.section', async () => {
  const registrations = []
  const captured = await loadClient()
  const calls = []
  const ctx = {
    slots: {
      inject: (name, callback) => { calls.push(name); callback() },
      register: (spec, component) => { registrations.push({ spec, component }) },
    },
  }
  const mod = captured.module
  assert.ok(mod, 'ModuleLoader.load 必须被调用')
  assert.equal(typeof mod.apply, 'function')
  assert.deepEqual(mod.inject, ['slots'])
  mod.apply(ctx)
  assert.deepEqual(calls, ['settings.section'])
  assert.equal(registrations.length, 1)
  assert.equal(registrations[0].spec.name, 'settings.section')
  assert.equal(registrations[0].spec.id, 'jev')
  assert.equal(typeof registrations[0].component, 'function')
})

/** 临时设置文件 + 注入环境。 */
async function sandbox(extra = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-jev-api-'))
  const settingsFile = join(dir, 'config.json')
  const env = { JEV_TEST_KEY: 'test-key' }
  await writeFile(settingsFile, JSON.stringify({ apiKeyEnv: 'JEV_TEST_KEY', ...extra }), 'utf8')
  return { dir, settingsFile, env }
}

test('HTTP settings.get：回显设置与服务状态，绝不回显 key', async () => {
  const { settingsFile, env } = await sandbox({ apiKey: 'literal-secret' })
  const ctx = new Context()
  const jev = new JevService(ctx, { settingsFile, env })
  const handler = createApiHandler(ctx, {}, jev)
  const value = await envelope(handler, 'settings.get')
  assert.equal(value.config.apiKey, '***')
  assert.equal(JSON.stringify(value).includes('literal-secret'), false)
  assert.equal(value.status.configured, true)
  assert.match(value.status.endpoint, /systemone$/)
})

test('HTTP settings.set：落盘并可读回；apiKey 走凭证缝', async () => {
  const { settingsFile, env } = await sandbox()
  const ctx = new Context()
  const stored = new Map()
  ctx.provide('credentials', {
    set: async (name, value) => { stored.set(name, value) },
    unset: async (name) => { stored.delete(name) },
  })
  const jev = new JevService(ctx, { settingsFile, env })
  const handler = createApiHandler(ctx, {}, jev)

  const saved = await envelope(handler, 'settings.set', { model: 'jev-new', timeoutMs: 5000, tool: false })
  assert.equal(saved.config.model, 'jev-new')
  assert.equal(saved.config.tool, false)
  assert.equal(saved.keyAction, 'unchanged')

  const withKey = await envelope(handler, 'settings.set', { apiKey: 'sk-abc' })
  assert.equal(withKey.keyAction, 'set')
  assert.equal(stored.get('JEV_TEST_KEY'), 'sk-abc', '有凭证缝时必须走凭证缝')
  assert.equal(JSON.stringify(withKey.config).includes('sk-abc'), false, 'config 里不能出现明文')

  const cleared = await envelope(handler, 'settings.set', { apiKey: null })
  assert.equal(cleared.keyAction, 'unset')
  assert.equal(stored.has('JEV_TEST_KEY'), false)
})

test('HTTP：未知端点回错误信封，而不是抛异常', async () => {
  const { settingsFile, env } = await sandbox()
  const ctx = new Context()
  const jev = new JevService(ctx, { settingsFile, env })
  const handler = createApiHandler(ctx, {}, jev)
  const response = await handler(new Request('http://x' + API_PATH, {
    method: 'POST', body: JSON.stringify({ endpoint: 'nope' }),
  }))
  const body = await response.json()
  assert.equal(body.ok, false)
  assert.match(body.error.message, /未知端点/)
})

test('HTTP：坏 JSON 也被信封接住', async () => {
  const { settingsFile, env } = await sandbox()
  const ctx = new Context()
  const jev = new JevService(ctx, { settingsFile, env })
  const handler = createApiHandler(ctx, {}, jev)
  const response = await handler(new Request('http://x' + API_PATH, { method: 'POST', body: '{ bad' }))
  const body = await response.json()
  assert.equal(body.ok, false)
  assert.match(body.error.message, /JSON/)
})

/** 发一个信封请求并取回 value。 */
async function envelope(handler, endpoint, args) {
  const response = await handler(new Request('http://x' + API_PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ endpoint, args: args ?? {} }),
  }))
  const body = await response.json()
  assert.equal(body.ok, true, '期望成功，实际：' + JSON.stringify(body))
  return body.value
}
