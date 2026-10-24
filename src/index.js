/**
 * dsh-jev —— Jev（TypeSafe System One 判定模型）插件，宿主半。
 *
 * 它只做一件事：把 Jev 变成一个**其他插件可以注入的服务**。
 *
 *   ctx.jev.ask({ state, questions })   → 一次往返，拿回全分布
 *   ctx.jev.available()                 → 有没有凭证（不发请求）
 *   ctx.jev.describe()                  → 端点/模型/凭证来源（不含 key）
 *
 * 消费方式（两种都要能用）：
 *   - 装得上服务：inject(['jev']) 或 ctx.get('jev')；
 *   - 只要纯函数：import { askJevQuestions } from 'dsh-jev/ask'（零宿主依赖）。
 *
 * 工具 jev_ask 与插件同生共死（enabled 一个闸）；端点与凭证永远取自本插件的设置，
 * 调用方无法把它们指向别处。
 */

import { API_PATH, createApiHandler } from './api.js'
import { JevService } from './service.js'
import { jevAskTool } from './tool.js'

export { JevService } from './service.js'
export { DEFAULT_SETTINGS, loadSettings, normalizeSettings, saveSettings, settingsPath } from './settings.js'
export { jevAskTool, TOOL_DESCRIPTION } from './tool.js'
export * from './client.js'

/** Loader 诊断用的稳定插件名。 */
export const name = 'jev'

/** 只依赖工具注册表；其余一切都惰性读取。 */
export const inject = ['tools']

/** 插件配置（cordis patch 里给的 config 是设置文件的默认值层）。 */
export const CONFIG_DEFAULTS = Object.freeze({
  // **只有一个闸**：enabled 同时决定服务、工具与 HTTP 路由。
  // 再给工具一个独立开关就是两个真值来源，能配出「插件开着却没有工具」的半开状态。
  enabled: true,
})

/**
 * 装载插件。
 * @param {object} ctx - 宿主插件上下文。
 * @param {object} [config] - 插件配置。
 * @returns {void}
 */
export function apply(ctx, config) {
  const resolved = { ...CONFIG_DEFAULTS, ...(config ?? {}) }
  if (resolved.enabled === false) return

  // 服务是**核心产出**：注册名 'jev'。继承了 Service，所以 fiber 卸载时自动撤销。
  const jev = new JevService(ctx, { loaderConfig: resolved })

  // 浏览器端（设置页）用的 HTTP 路由。**不进 inject**：没有 Connection 的 profile
  // （headless / tui）会整个卡在 PENDING，而工具面在那里本来就该照常工作。
  const handler = createApiHandler(ctx, resolved, jev)
  if (typeof ctx.inject === 'function') {
    ctx.inject(['connection'], (scope) => {
      scope.effect(
        () => scope.connection.fetch.register({
          path: API_PATH,
          methods: ['POST'],
          requestBody: 'buffered',
          fetch: async (request) => await handler(request),
        }),
        'dsh-jev: http route',
      )
    })
  }

  // 工具与插件同生共死：能走到这里就说明它是开着的。
  ctx.tools.register(jevAskTool({ serviceOf: async () => jev }))

  // 提示词是可选增强：没有 systemPrompt 服务时静默跳过。
  const prompt = typeof ctx.get === 'function' ? ctx.get('systemPrompt') : undefined
  if (prompt === undefined || typeof prompt.context !== 'function') return
  prompt.context({
    name: 'plugin:dsh-jev',
    order: 140,
    text: () => 'Jev (jev_ask) is a typed decision model: it answers "which of these candidates" with a calibrated distribution, not prose. Use it for routing, classification, or relevance ranking; do not ask it to write or explain.',
  })
}
