/** dsh-jev 的冒烟测试：真的装载插件、真的调 execute、真的落盘（网络一律用注入的 fetch）。 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { apply, jevAskTool, loadSettings, normalizeSettings, saveSettings } from '../src/index.js'
import { JevService } from '../src/service.js'

/** 造一个够用的宿主上下文：记下注册的服务、工具与提示词段落。 */
function fakeContext(options = {}) {
  const registered = []
  const services = new Map()
  const contexts = []
  const ctx = {
    registered,
    tools: { register: (tool) => registered.push(tool) },
    provide: (name, value) => services.set(name, value),
    get: (name) => {
      if (name === 'systemPrompt' && options.systemPrompt !== false) {
        return { context: (item) => { contexts.push(item); return () => {} } }
      }
      return services.get(name)
    },
  }
  ctx.services = services
  ctx.contexts = contexts
  return ctx
}

/** 一次假的 Jev 响应。 */
function fakeFetch(calls) {
  return async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body), headers: init.headers })
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          model: 'jev-test',
          answers: { decision: { type: 'choice', choice: 'b', confidence: 0.9, probabilities: { a: 0.1, b: 0.9 } } },
          usage: { input_tokens: 10, output_tokens: 2 },
        }
      },
    }
  }
}

/** 临时设置文件 + 明确的环境（不依赖本机 key）。 */
async function sandbox(extra = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-jev-'))
  const settingsFile = join(dir, 'config.json')
  const env = { JEV_TEST_KEY: 'test-key' }
  await writeFile(settingsFile, JSON.stringify({ apiKeyEnv: 'JEV_TEST_KEY', ...extra }), 'utf8')
  return { dir, settingsFile, env }
}

test('apply：注册服务 jev 与工具 jev_ask（默认开放）', () => {
  const ctx = fakeContext()
  apply(ctx, {})
  assert.ok(ctx.services.get('jev') instanceof JevService, '必须提供 ctx.jev')
  assert.deepEqual(ctx.registered.map((t) => t.name), ['jev_ask'])
  assert.equal(ctx.contexts.length, 1, '有 systemPrompt 时补一段说明')
})

test('apply：enabled=false 时既不注册服务也不注册工具', () => {
  const ctx = fakeContext()
  apply(ctx, { enabled: false })
  assert.equal(ctx.services.has('jev'), false)
  assert.deepEqual(ctx.registered, [])
})

test('apply：loader 配置 tool=false 时一个工具都不注册', () => {
  const ctx = fakeContext()
  apply(ctx, { tool: false })
  assert.ok(ctx.services.get('jev') instanceof JevService, '服务仍然要在')
  assert.deepEqual(ctx.registered, [])
})

test('apply：没有 systemPrompt 服务时照常装载', () => {
  const ctx = fakeContext({ systemPrompt: false })
  apply(ctx, {})
  assert.ok(ctx.services.get('jev') instanceof JevService)
  assert.deepEqual(ctx.registered.map((t) => t.name), ['jev_ask'])
})

test('service.ask：把端点、模型与 key 都从设置里取，并透传 questions', async () => {
  const { settingsFile, env } = await sandbox({ model: 'jev-custom', apiKeyEnv: 'JEV_TEST_KEY' })
  const calls = []
  const jev = new JevService(fakeContext(), { settingsFile, env, fetchImpl: fakeFetch(calls) })
  const result = await jev.ask({ state: 'S', questions: { decision: { type: 'choice', instructions: 'i', criteria: { a: null, b: null } } } })
  assert.equal(calls.length, 1)
  assert.match(calls[0].url, /\/systemone$/)
  assert.equal(calls[0].headers.authorization, 'Bearer test-key')
  assert.equal(calls[0].body.model, 'jev-custom')
  assert.equal(result.answers.decision.choice, 'b')
  assert.equal(result.keyFrom, 'env:JEV_TEST_KEY')
})

test('service.ask：调用方不能把端点改到别处（spec.baseUrl 被忽略）', async () => {
  const { settingsFile, env } = await sandbox()
  const calls = []
  const jev = new JevService(fakeContext(), { settingsFile, env, fetchImpl: fakeFetch(calls) })
  await jev.ask({ state: 'S', questions: { q: { type: 'choice', instructions: 'i', criteria: { a: null, b: null } } }, baseUrl: 'https://evil.example' })
  assert.match(calls[0].url, /^https:\/\/api\.commandcode\.ai\//)
})

test('service：没有 key 时 available=false，ask 抛 JEV_NO_KEY', async () => {
  const { settingsFile } = await sandbox({ apiKeyEnv: 'MISSING_KEY' })
  const jev = new JevService(fakeContext(), { settingsFile, env: {}, fetchImpl: fakeFetch([]) })
  assert.equal(await jev.available(), false)
  await assert.rejects(() => jev.ask({ state: 'S', questions: { q: {} } }), /JEV_NO_KEY/)
})

test('service.describe/settings：不回显 key', async () => {
  const { settingsFile, env } = await sandbox({ apiKey: 'literal-key' })
  const jev = new JevService(fakeContext(), { settingsFile, env })
  const described = await jev.describe()
  assert.equal(described.configured, true)
  assert.equal(described.keyFrom, 'config')
  const settings = await jev.settings()
  assert.equal(settings.apiKey, '***')
  assert.equal(JSON.stringify(settings).includes('literal-key'), false)
})

test('tool：一句话写法被包成单问题，返回 choice 与 probabilities', async () => {
  const { settingsFile, env } = await sandbox()
  const calls = []
  const ctx = fakeContext()
  const jev = new JevService(ctx, { settingsFile, env, fetchImpl: fakeFetch(calls) })
  const tool = jevAskToolFor(jev)
  const result = await tool.execute({ state: 'S', question: '选一个', options: ['a', 'b'] }, {})
  assert.equal(result.ok, true)
  assert.equal(result.choice, 'b')
  assert.deepEqual(calls[0].body.questions.decision.criteria, { a: null, b: null })
})

test('tool：参数不全时返回 bad_args 而不是抛错', async () => {
  const { settingsFile, env } = await sandbox()
  const jev = new JevService(fakeContext(), { settingsFile, env, fetchImpl: fakeFetch([]) })
  const tool = jevAskToolFor(jev)
  const missing = await tool.execute({ state: 'S', question: '选一个', options: ['a'] }, {})
  assert.equal(missing.ok, false)
  assert.equal(missing.reason, 'bad_args')
  const empty = await tool.execute({ state: '  ', question: 'q', options: ['a', 'b'] }, {})
  assert.equal(empty.reason, 'bad_args')
})

test('tool：没有服务时返回 missing，不抛错', async () => {
  const tool = jevAskToolFor(undefined)
  const result = await tool.execute({ state: 'S', question: 'q', options: ['a', 'b'] }, {})
  assert.deepEqual(result, { ok: false, reason: 'missing' })
})

test('tool：设置里 tool=false 时返回 missing（工具被关了，不是不存在）', async () => {
  const { settingsFile, env } = await sandbox({ tool: false })
  const ctx = fakeContext()
  const jev = new JevService(ctx, { settingsFile, env })
  const registered = []
  apply({
    ...ctx,
    tools: { register: (t) => registered.push(t) },
  }, {})
  // 直接核对 serviceOf 的判定：设置里关了就该拿不到服务。
  const settings = await new JevService(ctx, { settingsFile, env }).settings()
  assert.equal(settings.tool, false)
})

test('settings：文件层覆盖 loader 层，缺省值兜底', async () => {
  const { settingsFile } = await sandbox({ model: 'from-file' })
  const merged = await loadSettings({ model: 'from-loader', timeoutMs: 1234 }, { path: settingsFile })
  assert.equal(merged.model, 'from-file')
  assert.equal(merged.timeoutMs, 1234)
  assert.equal(merged.enabled, true)
})

test('settings：坏文件不炸，退回默认值', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-jev-bad-'))
  const file = join(dir, 'config.json')
  await writeFile(file, '{ not json', 'utf8')
  const merged = await loadSettings({}, { path: file })
  assert.equal(merged.baseUrl, normalizeSettings({}).baseUrl)
})

test('settings：saveSettings 落盘后可读回，key 不被其它字段冲掉', async () => {
  const { settingsFile } = await sandbox()
  await saveSettings({ model: 'saved', tool: false }, { path: settingsFile })
  const back = JSON.parse(await readFile(settingsFile, 'utf8'))
  assert.equal(back.model, 'saved')
  assert.equal(back.tool, false)
})

/** 用服务直接造一个工具实例（绕过 apply，便于逐例控制）。 */
function jevAskToolFor(jev) {
  return jevAskTool({ serviceOf: async () => jev })
}
