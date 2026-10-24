/* dsh-jev — 浏览器端。
 *
 * 这里是**真正的浏览器插件**：web boot 按 package.json 的 exports["./client"] 找到它，
 * 所以必须是 window.__ModuleLoader__.load({ id, factory }) 的信封——直接 import 一个
 * ESM 模块会在启动时报 "loaded without registering"。
 *
 * 挂的槽是 plugins.bundle.config，**键 = 包名 dsh-jev**：它渲染在
 * 「设置 → 插件 → dsh-jev」那一页里（描述与组件列表之间），不是设置页的顶层栏目。
 * 槽的所有者是 ui-plugin-manager，契约见 slot-contract.ts。
 *
 * 状态都在宿主侧（$DSH_HOME/dsh-jev/config.json），这里通过 /api/jev 的 HTTP 信封读写：
 * Connection 只围栏 /api 前缀，浏览器端也就只走这一条。
 */
window.__ModuleLoader__.load({
  id: 'dsh-jev',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback } = React

    /** 与宿主 src/api.js 的 API_PATH 必须一致。 */
    const API = '/api/jev'

    /**
     * 一次 HTTP 往返。
     * @param {string} endpoint - 端点名。
     * @param {object} [args] - 参数。
     * @returns {Promise<object>} value。
     */
    async function post(endpoint, args) {
      const response = await fetch(API, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ endpoint, args: args || {} }),
      })
      const body = await response.json().catch(() => ({ ok: false, error: { message: '不是合法 JSON' } }))
      if (body && body.ok) return body.value
      throw new Error(body && body.error && body.error.message ? body.error.message : '请求失败')
    }

    const S = {
      input: {
        width: '100%', height: 32, padding: '0 10px', fontSize: 13, fontFamily: 'inherit',
        color: 'var(--dsw-alias-label-primary)',
        background: 'var(--dsw-alias-bg-layer-1)',
        border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 8, outline: 'none',
      },
      label: { display: 'block', fontSize: 12, color: 'var(--dsw-alias-label-secondary)', marginBottom: 4 },
      row: { display: 'flex', gap: 12 },
      field: { marginBottom: 12 },
      button: {
        height: 32, padding: '0 14px', fontSize: 13, fontFamily: 'inherit',
        color: 'var(--dsw-alias-label-primary)',
        background: 'var(--dsw-alias-bg-layer-1)',
        border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 8, cursor: 'pointer',
      },
      err: { color: 'var(--dsw-alias-state-error-primary)', fontSize: 12, margin: '0 0 8px' },
      note: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', marginTop: 10, lineHeight: '18px' },
      meta: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', marginBottom: 12 },
    }

    /**
     * 「Jev 引擎」设置页。
     * @returns {object} 元素树。
     */
    function JevSettingsPage() {
      const [settings, setSettings] = useState(null)
      const [status, setStatus] = useState(null)
      const [apiKey, setApiKey] = useState('')
      const [notice, setNotice] = useState('')
      const [error, setError] = useState('')
      const [busy, setBusy] = useState(false)

      const load = useCallback(async () => {
        try {
          setError('')
          const data = await post('settings.get')
          setSettings(data.config)
          setStatus(data.status)
        } catch (cause) {
          setError(cause && cause.message ? cause.message : String(cause))
        }
      }, [])

      useEffect(() => { void load() }, [load])

      /** 改一个字段（只动草稿，不落盘）。 */
      const set = (key, value) => setSettings({ ...settings, [key]: value })

      async function save() {
        setBusy(true); setNotice(''); setError('')
        try {
          const data = await post('settings.set', {
            enabled: settings.enabled,
            baseUrl: settings.baseUrl,
            model: settings.model,
            apiKeyEnv: settings.apiKeyEnv,
            timeoutMs: settings.timeoutMs,
            ...(apiKey.trim() === '' ? {} : { apiKey: apiKey.trim() }),
          })
          setApiKey('')
          setSettings(data.config)
          setStatus(data.status)
          setNotice(data.keyAction === 'set' ? '已保存，并写入 API Key' : '已保存')
        } catch (cause) {
          setError(cause && cause.message ? cause.message : String(cause))
        } finally { setBusy(false) }
      }

      async function clearKey() {
        setBusy(true); setNotice(''); setError('')
        try {
          const data = await post('settings.set', { apiKey: null })
          setStatus(data.status)
          setNotice('已清除 API Key')
        } catch (cause) {
          setError(cause && cause.message ? cause.message : String(cause))
        } finally { setBusy(false) }
      }

      if (settings === null) {
        return h('div', { style: { color: 'var(--dsw-alias-label-secondary)', fontSize: 13 } },
          error === '' ? '加载中…' : error)
      }

      const field = (label, key, extra) => h('label', { style: S.field, key },
        h('span', { style: S.label }, label),
        h('input', {
          style: S.input,
          value: settings[key] === undefined || settings[key] === null ? '' : String(settings[key]),
          onChange: (event) => set(key, event.target.value),
          ...(extra || {}),
        }))

      return h('div', { style: { maxWidth: 560 } },
        h('div', { style: S.meta },
          status && status.configured
            ? 'Jev 可用（凭证来源：' + status.keyFrom + '）'
            : '未找到凭证：群聊会静默降级到管理 AI 兜底，jev_ask 会返回 no_key。'),
        status && status.endpoint
          ? h('div', { style: { ...S.meta, fontFamily: 'ui-monospace,monospace' } }, status.endpoint)
          : null,

        error !== '' && h('div', { style: S.err }, error),
        notice !== '' && h('div', { style: { ...S.meta, color: 'var(--dsw-alias-label-primary)' } }, notice),

        h('label', { style: { ...S.field, display: 'flex', alignItems: 'center', gap: 8 } },
          h('input', {
            type: 'checkbox', checked: settings.enabled !== false,
            onChange: (event) => set('enabled', event.target.checked),
            style: { accentColor: 'var(--dsw-alias-brand-primary)' },
          }),
          h('span', { style: { fontSize: 13 } }, '启用 Jev')),

        // 一个开关管两件事，界面上说清楚，免得再被问「工具在哪开」。
        h('div', { style: { ...S.note, marginTop: 0, marginBottom: 12 } },
          '启用即同时提供 ctx.jev 服务与 jev_ask 工具（两者由这一个开关决定）。'),

        field('端点（base URL）', 'baseUrl'),
        field('模型', 'model'),
        h('div', { style: S.row },
          h('div', { style: { flex: 1 } }, field('凭证环境变量名', 'apiKeyEnv')),
          h('div', { style: { flex: 1 } }, field('超时（毫秒）', 'timeoutMs', { type: 'number', min: '1000' })),
        ),

        h('label', { style: S.field },
          h('span', { style: S.label }, 'API Key（留空表示不改动）'),
          h('input', {
            style: S.input, type: 'password', value: apiKey, placeholder: '••••••••',
            onChange: (event) => setApiKey(event.target.value),
          })),

        h('div', { style: { ...S.row, marginTop: 14 } },
          h('button', { style: S.button, onClick: () => { void save() }, disabled: busy }, '保存'),
          h('button', { style: S.button, onClick: () => { void clearKey() }, disabled: busy }, '清除 API Key')),

        h('div', { style: S.note },
          '设置落在 $DSH_HOME/dsh-jev/config.json。凭证解析顺序：这里填的 key → 环境变量 → '
          + 'TYPESAFE_API_KEY → ~/.dsh/.credentials.yaml 的 refs。'),
      )
    }

    /**
     * 挂上设置页。
     * @param {object} ctx - 浏览器插件上下文。
     * @returns {void}
     */
    function apply(ctx) {
      // plugins.bundle.config 是 **keyed** 槽：key 必须是包的 npm 名，
      // 插件页按它把这块挂到「设置 → 插件 → dsh-jev」的页面里。
      ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
        name: 'plugins.bundle.config',
        key: 'dsh-jev',
      }, JevSettingsPage))
    }

    exports.apply = apply
    exports.inject = ['slots']
    // 给单测用的纯函数缝：信封可以脱离 DOM 断言。
    exports.internals = { JevSettingsPage, API }
    return module.exports
  },
})
