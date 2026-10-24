/**
 * Jev 客户端：**纯函数**，零宿主依赖，可以直接 inNode 里 import。
 *
 * Jev（TypeSafe "System One"）不生成文本：它对一段 state 回答类型化问题，
 * 返回**校准过的概率分布**。
 *
 *   POST https://api.commandcode.ai/provider/v1/systemone  →  200
 *   body  { model, state, questions: { <id>: { type, instructions, criteria } } }
 *   响应  { model, answers: { <id>: { type, choice, confidence, probabilities } }, usage }
 *
 * ## 两条接缝
 *
 *  1. **服务**（@deepseek-ai/dsh-jev 的 apply）：消费方 inject 或 ctx.get('jev')，
 *     配置由插件持有一份，所有 agent 共享。
 *  2. **纯函数**（本文件）：只想问一次/还没装服务时直接用；凭证按 env → credentials
 *     文件自己解析。
 *
 * 端口形状对社区变种是**加宽**的：
 *   - askJevQuestions({ state, questions }) → { answers, model, usage }（推荐）
 *   - askJev({ state, question, options })  → 单问糖，返回里同时带 answers 与顶层 choice
 *   - askJevChoice(...)                     → 只回 { choice, confidence, probabilities }
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'

/** 默认端点：command-code provider 的 base URL。 */
export const DEFAULT_BASE_URL = 'https://api.commandcode.ai/provider/v1'

/** 默认模型。 */
export const DEFAULT_MODEL = 'jev-latest'

/** 默认凭证来源：与 profile 里 command-code provider 用的是同一把 key。 */
export const DEFAULT_API_KEY_ENV = 'COMMAND_CODE_API_KEY'

/** 备选凭证来源：TypeSafe 官方 key（配了就用）。 */
export const FALLBACK_API_KEY_ENV = 'TYPESAFE_API_KEY'

/** 默认超时。 */
export const DEFAULT_TIMEOUT_MS = 20000

/** 单问题糖用的判定 id，与请求体 questions 映射的键一致。 */
export const QUESTION_ID = 'decision'

/**
 * DSH home 目录。
 * @returns {string} $DSH_HOME，缺省 ~/.dsh。
 */
export function dshHome() {
  const configured = process.env.DSH_HOME
  if (typeof configured === 'string' && configured.trim() !== '') return configured
  return join(homedir(), '.dsh')
}

/**
 * 解析 Jev 凭证，按序：
 * 1. 显式 apiKey（插件设置里填的）；
 * 2. 环境变量 apiKeyEnv（默认 COMMAND_CODE_API_KEY）；
 * 3. 环境变量 TYPESAFE_API_KEY；
 * 4. ~/.dsh/.credentials.yaml 的 refs.<apiKeyEnv>；
 * 5. 同一文件的 refs.TYPESAFE_API_KEY。
 *
 * @param {object} [options] - 解析参数。
 * @param {string} [options.apiKey] - 显式 key，优先级最高。
 * @param {string} [options.apiKeyEnv] - 环境变量名，默认 COMMAND_CODE_API_KEY。
 * @param {NodeJS.ProcessEnv} [options.env] - 环境变量表，测试可注入。
 * @param {string} [options.credentialsPath] - 凭证文件路径，测试可注入。
 * @returns {{ key: string, from: string }|undefined} key 及其来源；都没有时 undefined。
 */
export function resolveJevApiKey(options = {}) {
  const explicit = options.apiKey
  if (typeof explicit === 'string' && explicit.trim() !== '') return { key: explicit.trim(), from: 'config' }

  const env = options.env ?? process.env
  const apiKeyEnv = typeof options.apiKeyEnv === 'string' && options.apiKeyEnv !== '' ? options.apiKeyEnv : DEFAULT_API_KEY_ENV
  for (const name of [apiKeyEnv, FALLBACK_API_KEY_ENV]) {
    const value = env[name]
    if (typeof value === 'string' && value.trim() !== '') return { key: value.trim(), from: 'env:' + name }
  }

  const file = options.credentialsPath ?? join(dshHome(), '.credentials.yaml')
  try {
    const doc = parseYaml(readFileSync(file, 'utf8'))
    const refs = doc && typeof doc === 'object' ? doc.refs : undefined
    if (refs && typeof refs === 'object') {
      for (const name of [apiKeyEnv, FALLBACK_API_KEY_ENV]) {
        const value = refs[name]
        if (typeof value === 'string' && value.trim() !== '') return { key: value.trim(), from: 'credentials:' + name }
      }
    }
  } catch {
    // 文件不存在或不可读：与「没配 key」同义，静默略过。
  }
  return undefined
}

/**
 * 当前是否具备调用 Jev 的条件（只看有没有 key，不发请求）。
 * @param {object} [options] - 同 resolveJevApiKey。
 * @returns {boolean} 是否可用。
 */
export function jevConfigured(options = {}) {
  return resolveJevApiKey(options) !== undefined
}

/**
 * 构造一个 choice 判定问题。
 *
 * @param {object} spec - 问题描述。
 * @param {string} spec.question - 要做的判断。
 * @param {string[]} [spec.options] - 候选项（>= 2）；给了 criteria 时可省略。
 * @param {Record<string, string|null>} [spec.criteria] - 候选项 → 说明；给了就直接用。
 * @returns {{ type: 'choice', instructions: string, criteria: Record<string, string|null> }} 官方问题体。
 * @throws {TypeError} 有效候选项少于 2 个时抛出。
 */
export function buildChoiceQuestion(spec) {
  const provided = spec.criteria && typeof spec.criteria === 'object' && !Array.isArray(spec.criteria) ? spec.criteria : null
  const criteria = {}
  if (provided !== null) {
    for (const [key, value] of Object.entries(provided)) criteria[key] = value === undefined ? null : value
  } else {
    const options = Array.isArray(spec.options) ? spec.options.filter((item) => typeof item === 'string' && item !== '') : []
    for (const option of options) criteria[option] = null
  }
  if (Object.keys(criteria).length < 2) throw new TypeError('Jev choice 判定至少需要 2 个候选项')
  return { type: 'choice', instructions: spec.question, criteria }
}

/**
 * 把单问题的 choice 答案压成调用方关心的形状。
 * @param {unknown} response - 原始响应。
 * @returns {{ choice: string, confidence?: number, probabilities?: Record<string, number>, model?: string, usage?: object }} 判定结果。
 * @throws {Error} 响应缺少 answers.decision 时抛出。
 */
export function summarizeJevResponse(response) {
  const answers = response && typeof response === 'object' ? response.answers : undefined
  const answer = answers && typeof answers === 'object' ? answers[QUESTION_ID] : undefined
  if (answer === null || answer === undefined || typeof answer !== 'object') {
    throw new Error('Jev 响应缺少 answers.' + QUESTION_ID + '：' + JSON.stringify(response).slice(0, 200))
  }
  const record = /** @type {Record<string, unknown>} */ (answer)
  return {
    choice: typeof record.choice === 'string' ? record.choice : '',
    confidence: typeof record.confidence === 'number' ? record.confidence : undefined,
    probabilities: record.probabilities && typeof record.probabilities === 'object'
      ? /** @type {Record<string, number>} */ (record.probabilities)
      : undefined,
    model: response && typeof response.model === 'string' ? response.model : undefined,
    usage: response && response.usage && typeof response.usage === 'object' ? response.usage : undefined,
  }
}

/**
 * 按概率把候选项排序。
 *
 * Jev 的 choice 一次就给出**全分布**，所以"挑出最相关的几条历史"不需要 N 次调用，
 * 一次调用按 probabilities 排序即可。
 *
 * @param {{ probabilities?: Record<string, number> }} result - 含 probabilities 的结果。
 * @param {string[]} options - 原始候选项。
 * @returns {Array<{ option: string, probability: number }>} 由高到低。
 */
export function rankOptions(result, options = []) {
  const probabilities = result && result.probabilities ? result.probabilities : {}
  return options
    .map((option) => ({ option, probability: typeof probabilities[option] === 'number' ? probabilities[option] : 0 }))
    .sort((left, right) => right.probability - left.probability)
}

/**
 * 通用多问题调用：一次 HTTP 往返回答一组类型化问题。
 *
 * spec 里若带 settings（{ baseUrl, model, apiKey, apiKeyEnv, credentialsPath, timeoutMs }），
 * 它作为**默认值层**，显式字段覆盖它。服务层传的就是这一层。
 *
 * @param {object} spec - 调用参数。
 * @param {string} spec.state - 要评估的文本。
 * @param {Record<string, object>} spec.questions - id → 问题体。
 * @param {string} [spec.model] - 模型，默认 jev-latest。
 * @param {string} [spec.baseUrl] - 端点，默认 command-code provider。
 * @param {string} [spec.apiKey] - 显式 key；缺省按 resolveJevApiKey 解析。
 * @param {string} [spec.apiKeyEnv] - 凭证环境变量名。
 * @param {string} [spec.credentialsPath] - 凭证文件路径。
 * @param {number} [spec.timeoutMs] - 单次请求超时。
 * @param {AbortSignal} [spec.signal] - 外部取消信号。
 * @param {typeof fetch} [spec.fetchImpl] - fetch 实现，测试可注入。
 * @returns {Promise<{ answers: object, model?: string, usage?: object, keyFrom: string }>} 原始 answers。
 * @throws {Error} 没有 key、HTTP 失败或响应不合形状时抛出（调用方负责降级）。
 */
export async function askJevQuestions(spec) {
  const options = { ...(spec.settings ?? {}), ...spec }
  const credential = resolveJevApiKey(options)
  if (credential === undefined) throw new Error('JEV_NO_KEY: 没有可用的 Jev 凭证')
  if (options.questions === null || typeof options.questions !== 'object' || Object.keys(options.questions).length === 0) {
    throw new TypeError('askJevQuestions：至少需要一个判定问题')
  }
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
  const doFetch = options.fetchImpl ?? globalThis.fetch
  if (typeof doFetch !== 'function') throw new Error('当前运行环境没有 fetch，无法调用 Jev')

  const payload = {
    model: options.model ?? DEFAULT_MODEL,
    state: options.state,
    questions: options.questions,
  }

  const timeoutMs = Number.isInteger(options.timeoutMs) ? options.timeoutMs : DEFAULT_TIMEOUT_MS
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const relay = () => controller.abort()
  if (options.signal) {
    if (options.signal.aborted) controller.abort()
    else options.signal.addEventListener('abort', relay, { once: true })
  }
  try {
    // 429/529 建议退避重试；只重试一次，不把用户卡在决策层上。
    for (let attempt = 0; ; attempt += 1) {
      const response = await doFetch(baseUrl + '/systemone', {
        method: 'POST',
        headers: { authorization: 'Bearer ' + credential.key, 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      })
      if ((response.status === 429 || response.status === 529) && attempt === 0) {
        await new Promise((resolve) => setTimeout(resolve, 1000))
        continue
      }
      if (!response.ok) {
        const body = await response.text()
        throw new Error('Jev HTTP ' + response.status + '：' + body.slice(0, 200))
      }
      const json = await response.json()
      const answers = json && typeof json === 'object' ? json.answers : undefined
      if (answers === null || answers === undefined || typeof answers !== 'object') {
        throw new Error('Jev 响应缺少 answers：' + JSON.stringify(json).slice(0, 200))
      }
      return {
        answers,
        ...(typeof json.model === 'string' ? { model: json.model } : {}),
        ...(json.usage && typeof json.usage === 'object' ? { usage: json.usage } : {}),
        keyFrom: credential.from,
      }
    }
  } finally {
    clearTimeout(timer)
    if (options.signal) options.signal.removeEventListener('abort', relay)
  }
}

/**
 * 统一入口：给了 questions 就多问题；只给 question/options 就包成单问题。
 *
 * 返回里**总是**带 answers；单问题时额外把 decision 的答案提升到顶层，
 * 这样旧的 { choice, confidence, probabilities } 消费方不用改。
 *
 * @param {object} spec - 同 askJevQuestions，另可给 question/options。
 * @returns {Promise<object>} { answers, choice?, confidence?, probabilities?, model?, usage?, keyFrom }。
 */
export async function askJev(spec) {
  const single = spec.questions && typeof spec.questions === 'object' ? false : true
  const questions = single
    ? { [QUESTION_ID]: buildChoiceQuestion({ question: spec.question, options: spec.options, criteria: spec.criteria }) }
    : spec.questions
  const out = await askJevQuestions({ ...spec, questions })
  if (!single) return out
  const answer = out.answers[QUESTION_ID]
  if (answer === null || answer === undefined || typeof answer !== 'object') {
    throw new Error('Jev 响应缺少 answers.' + QUESTION_ID + '：' + JSON.stringify(out.answers).slice(0, 200))
  }
  const record = /** @type {Record<string, unknown>} */ (answer)
  return {
    ...out,
    choice: typeof record.choice === 'string' ? record.choice : '',
    ...(typeof record.confidence === 'number' ? { confidence: record.confidence } : {}),
    ...(record.probabilities && typeof record.probabilities === 'object' ? { probabilities: record.probabilities } : {}),
  }
}

/**
 * 问 Jev 一个 choice 问题（旧形状，保留给已有调用方与测试）。
 *
 * @param {object} spec - 同 askJev。
 * @returns {Promise<object>} summarizeJevResponse 的结果 + keyFrom。
 */
export async function askJevChoice(spec) {
  const result = await askJev(spec)
  return {
    choice: result.choice ?? '',
    confidence: result.confidence,
    probabilities: result.probabilities,
    model: result.model,
    usage: result.usage,
    keyFrom: result.keyFrom,
  }
}
