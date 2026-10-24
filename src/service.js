/**
 * ctx.jev：Jev 服务的**远程代理**形态。
 *
 * ## 为什么服务不能把凭证绑在 agent 作用域上
 *
 * DSH 里每个 agent 有自己的 agent.ctx（createScope → ctx.plugin(scope) → ctx.extend），
 * 而插件只装载一次。本服务的配置与凭证绑在**装载它的那个 fiber** 上，所以：
 *   - agent 作用域里 ctx.get('jev') 拿到的就是同一份配置；
 *   - 插件卸载时 cordis 自动撤销注册，不需要手写 dispose；
 *   - 凭证缓存挂在 this 上，HMR 之后不会残留旧 key。
 *
 * ## 为什么调用方拿不到端点
 *
 * ask() 只允许覆盖 model / timeoutMs / signal：端点和凭证永远取自设置。
 * 让调用方带 baseUrl 就等于让任何插件把 key 发到自己的服务器上。
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { Service } from '@deepseek-ai/cordis'
import { askJevQuestions, buildChoiceQuestion, resolveJevApiKey } from './client.js'
import { loadSettings } from './settings.js'

/** 凭证缓存的有效期：改完 credentials 文件不必重启。 */
const KEY_TTL_MS = 10_000

/** Jev 服务：注册名 'jev'。 */
export class JevService extends Service {
  /**
   * @param {object} ctx - 装载它的宿主上下文。
   * @param {object} [options] - 参数。
   * @param {object} [options.loaderConfig] - 插件配置（作为设置默认值层）。
   * @param {NodeJS.ProcessEnv} [options.env] - 环境变量表，测试可注入。
   * @param {typeof fetch} [options.fetchImpl] - fetch 实现，测试可注入。
   * @param {string} [options.settingsFile] - 设置文件路径，测试可注入。
   */
  constructor(ctx, options = {}) {
    super(ctx, 'jev')
    this.loaderConfig = options.loaderConfig ?? {}
    this.env = options.env ?? process.env
    this.fetchImpl = options.fetchImpl
    this.settingsFile = options.settingsFile
    this.keyCache = { credential: undefined, at: 0 }
  }

  /**
   * 当前生效的设置（**不含 key 本身**）。
   * @returns {Promise<object>} 设置快照。
   */
  async settings() {
    const settings = await loadSettings(this.loaderConfig, this.#settingsOptions())
    return {
      ...settings,
      apiKey: settings.apiKey === '' ? '' : '***',
      endpoint: settings.baseUrl.replace(/\/+$/, '') + '/systemone',
    }
  }

  /**
   * 是否有可用凭证（不发请求）。
   * @returns {Promise<boolean>} 是否可用。
   */
  async available() {
    return (await this.#credential()) !== undefined
  }

  /**
   * 端点/模型/凭证来源的可观测性（绝不回显 key）。
   * @returns {Promise<object>} { configured, keyFrom, endpoint, model, enabled }。
   */
  async describe() {
    const settings = await loadSettings(this.loaderConfig, this.#settingsOptions())
    const credential = await this.#credential(settings)
    return {
      configured: credential !== undefined,
      keyFrom: credential === undefined ? null : credential.from,
      endpoint: settings.baseUrl.replace(/\/+$/, '') + '/systemone',
      model: settings.model,
      enabled: settings.enabled,
    }
  }

  /**
   * 一次 HTTP 往返，回答一组类型化问题。
   *
   * @param {object} spec - 调用参数。
   * @param {string} spec.state - 要评估的文本。
   * @param {Record<string, object>} spec.questions - id → 问题体。
   * @param {string} [spec.model] - 覆盖模型。
   * @param {number} [spec.timeoutMs] - 覆盖超时。
   * @param {AbortSignal} [spec.signal] - 取消信号。
   * @returns {Promise<{ answers: object, model?: string, usage?: object, keyFrom: string }>} 原始答案。
   * @throws {Error} 设置关了、没 key、HTTP 失败或响应不合形状。
   */
  async ask(spec) {
    const settings = await loadSettings(this.loaderConfig, this.#settingsOptions())
    if (settings.enabled === false) throw new Error('JEV_DISABLED: dsh-jev 在设置里被关闭了')
    const credential = await this.#credential(settings)
    if (credential === undefined) throw new Error('JEV_NO_KEY: 没有可用的 Jev 凭证')
    // 两种形状都接：结构化 questions 直接转发；只给 question/options 时包成单问题，
    // 并把 decision 的答案提升到顶层——与客户端 askJev() 的单问糖完全一致。
    const single = !(spec.questions && typeof spec.questions === 'object')
    const questions = single
      ? { decision: buildChoiceQuestion({ question: spec.question, options: spec.options }) }
      : spec.questions
    const out = await askJevQuestions({
      state: spec.state,
      questions,
      baseUrl: settings.baseUrl,
      model: spec.model ?? settings.model,
      timeoutMs: spec.timeoutMs ?? settings.timeoutMs,
      // **总是传已解析的 key + 注入的 env**：askJevQuestions 会再走一次凭证链，
      // 不传的话它会去读 process.env 和真实的 ~/.dsh/.credentials.yaml——
      // 于是 keyFrom 与真正发出去的 key 对不上（测试注入的 env 被本机 key 抢答）。
      apiKey: credential.key,
      env: this.env,
      ...(spec.signal === undefined ? {} : { signal: spec.signal }),
      fetchImpl: this.fetchImpl,
    })
    // keyFrom 报**凭证真实的来源**（env / credentials 文件），而不是我们这里
    // 为了绕开二次解析而传字面 key 造成的 'config'。
    const stamped = { ...out, keyFrom: credential.from }
    if (!single) return stamped
    const answer = stamped.answers && stamped.answers.decision
    return {
      ...stamped,
      choice: answer && typeof answer.choice === 'string' ? answer.choice : '',
      ...(answer && typeof answer.confidence === 'number' ? { confidence: answer.confidence } : {}),
      ...(answer && answer.probabilities && typeof answer.probabilities === 'object' ? { probabilities: answer.probabilities } : {}),
    }
  }

  /** 设置文件的读取选项。 */
  #settingsOptions() {
    return this.settingsFile === undefined ? {} : { path: this.settingsFile }
  }

  /**
   * 取凭证，带 TTL 缓存（只缓存元数据，不缓存 HTTP 结果）。
   * @param {object} [settings] - 已读好的设置，省略时现读。
   * @returns {Promise<{ key: string, from: string }|undefined>} 凭证。
   */
  async #credential(settings) {
    const now = Date.now()
    if (this.keyCache.credential !== undefined && now - this.keyCache.at < KEY_TTL_MS) return this.keyCache.credential
    const resolved = settings ?? await loadSettings(this.loaderConfig, this.#settingsOptions())
    const credential = resolveJevApiKey({
      apiKey: resolved.apiKey,
      apiKeyEnv: resolved.apiKeyEnv,
      // 缺省 credentialsPath 指向一个**不存在的**文件：测试注入的 env 不该被本机
      // ~/.dsh/.credentials.yaml 里那把真实的 key 抢答。
      credentialsPath: resolved.credentialsPath === '' ? join(homedir(), '.dsh', '.credentials.yaml') : resolved.credentialsPath,
      env: this.env,
    })
    this.keyCache = { credential, at: now }
    return credential
  }
}
