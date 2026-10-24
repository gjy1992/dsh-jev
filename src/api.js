/**
 * 宿主侧 HTTP 接口：给浏览器端（设置页）用。
 *
 * 走 Connection Fetch 路由而不是 RPC channel：`/api` 是浏览器唯一被挂载并做了
 * 信任围栏（Host/Origin + 浏览器鉴权）的前缀，dsh-agents-group 已实测这条路可用。
 *
 * 信封统一 `{ ok: true, value }` / `{ ok: false, error: { message } }`。
 */



/** 路由路径：必须在 `/api` 之下。 */
export const API_PATH = '/api/jev'

/** 请求体上限（字节）。这个面板只有几个短字段。 */
export const MAX_BODY_BYTES = 64 * 1024

/**
 * 构造路由处理器。
 * @param {object} ctx - 宿主上下文（credentials 可选）。
 * @param {object} pluginConfig - 插件配置（设置默认值层）。
 * @param {object} jev - JevService。
 * @returns {(request: Request) => Promise<Response>} fetch 处理器。
 */
export function createApiHandler(ctx, pluginConfig, jev) {
  return async function handle(request) {
    let payload
    try {
      const text = await request.text()
      if (text.length > MAX_BODY_BYTES) return errorEnvelope('请求体过大')
      payload = text === '' ? {} : JSON.parse(text)
    } catch {
      return errorEnvelope('请求体不是合法 JSON')
    }
    const endpoint = typeof payload.endpoint === 'string' ? payload.endpoint : ''
    const args = payload.args && typeof payload.args === 'object' ? payload.args : {}
    try {
      const value = await dispatch(ctx, pluginConfig, jev, endpoint, args)
      return json({ ok: true, value })
    } catch (error) {
      return json({ ok: false, error: { message: error instanceof Error ? error.message : String(error) } })
    }
  }
}

/**
 * 分发一个端点。
 * @param {object} ctx - 宿主上下文。
 * @param {object} pluginConfig - 插件配置。
 * @param {object} jev - JevService。
 * @param {string} endpoint - 端点名。
 * @param {object} args - 参数。
 * @returns {Promise<object>} 端点结果。
 */
async function dispatch(ctx, pluginConfig, jev, endpoint, args) {
  switch (endpoint) {
    case 'settings.get': {
      // 走服务自己的设置读法：服务可能带着注入的 settingsFile。
      const config = await jev.loadSettings()
      return {
        config: { ...config, apiKey: config.apiKey === '' ? '' : '***' },
        status: await jev.describe(),
      }
    }
    case 'settings.set': return await settingsSet(ctx, pluginConfig, jev, args)
    default: throw new Error('未知端点：' + endpoint)
  }
}

/**
 * 写设置。apiKey 单独处理：不落进 config.json（除非没有凭证缝可用）。
 *
 * `apiKey: null` 表示清除，空串/缺省表示不改动。
 *
 * @param {object} ctx - 宿主上下文。
 * @param {object} pluginConfig - 插件配置。
 * @param {object} jev - JevService。
 * @param {object} args - 参数。
 * @returns {Promise<object>} { config, status, keyAction }。
 */
async function settingsSet(ctx, pluginConfig, jev, args) {
  const patch = {}
  if (typeof args.enabled === 'boolean') patch.enabled = args.enabled
  if (typeof args.tool === 'boolean') patch.tool = args.tool
  for (const key of ['baseUrl', 'model', 'apiKeyEnv']) {
    if (typeof args[key] === 'string' && args[key].trim() !== '') patch[key] = args[key].trim()
  }
  if (Number.isInteger(args.timeoutMs) && args.timeoutMs > 0) patch.timeoutMs = args.timeoutMs
  if (Object.keys(patch).length > 0) await jev.saveSettings(patch)

  let keyAction = 'unchanged'
  const credentialEnv = typeof args.apiKeyEnv === 'string' && args.apiKeyEnv.trim() !== ''
    ? args.apiKeyEnv.trim()
    : (await jev.loadSettings()).apiKeyEnv
  const credentials = typeof ctx.get === 'function' ? ctx.get('credentials') : undefined
  if (typeof args.apiKey === 'string' && args.apiKey.trim() !== '') {
    if (credentials !== undefined && typeof credentials.set === 'function') {
      await credentials.set(credentialEnv, args.apiKey.trim())
    } else {
      // 没有凭证缝的部署（headless 等）退回落文件：能用，但比凭证缝弱一档。
      await jev.saveSettings({ apiKey: args.apiKey.trim() })
    }
    keyAction = 'set'
  } else if (args.apiKey === null) {
    if (credentials !== undefined && typeof credentials.unset === 'function') {
      await credentials.unset(credentialEnv).catch(() => {})
    }
    await jev.saveSettings({ apiKey: '' })
    keyAction = 'unset'
  }

  const config = await jev.loadSettings()
  // 清掉刚解析出的缓存，设置页上的状态立刻反映新 key。
  if (typeof jev.refresh === 'function') jev.refresh()
  return {
    config: { ...config, apiKey: config.apiKey === '' ? '' : '***' },
    status: await jev.describe(),
    keyAction,
  }
}

/** @param {object} body @returns {Response} */
function json(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/** @param {string} message @returns {Response} */
function errorEnvelope(message) {
  return json({ ok: false, error: { message } })
}
