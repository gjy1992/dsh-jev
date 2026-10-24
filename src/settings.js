/**
 * dsh-jev 的插件级设置（**全局**，一台机器一套）。
 *
 * 落盘在 $DSH_HOME/dsh-jev/config.json，人类可读可改；设置页写的就是它。
 * loader 配置（cordis patch 里给的 config）作为**默认值层**，文件层覆盖它，缺省值兜底。
 */

import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { DEFAULT_API_KEY_ENV, DEFAULT_BASE_URL, DEFAULT_MODEL, DEFAULT_TIMEOUT_MS, dshHome } from './client.js'

/** 默认设置。 */
export const DEFAULT_SETTINGS = Object.freeze({
  enabled: true,
  baseUrl: DEFAULT_BASE_URL,
  model: DEFAULT_MODEL,
  apiKey: '',
  apiKeyEnv: DEFAULT_API_KEY_ENV,
  credentialsPath: '',
  timeoutMs: DEFAULT_TIMEOUT_MS,
  /** jev_ask 工具是否对模型开放。 */
  tool: true,
  /** 允许模型只写 state + question 的一句话形态（不给 questions 时由服务包成单问题）。 */
  simple: true,
})

/**
 * 设置文件路径。
 * @returns {string} 绝对路径。
 */
export function settingsPath() {
  return join(dshHome(), 'dsh-jev', 'config.json')
}

/**
 * 补全并校验设置。
 * @param {unknown} raw - 原始设置。
 * @returns {object} 规范化设置。
 */
export function normalizeSettings(raw) {
  const source = raw && typeof raw === 'object' ? raw : {}
  return {
    enabled: source.enabled !== false,
    baseUrl: nonEmpty(source.baseUrl) ?? DEFAULT_SETTINGS.baseUrl,
    model: nonEmpty(source.model) ?? DEFAULT_SETTINGS.model,
    apiKey: typeof source.apiKey === 'string' ? source.apiKey.trim() : '',
    apiKeyEnv: nonEmpty(source.apiKeyEnv) ?? DEFAULT_SETTINGS.apiKeyEnv,
    credentialsPath: typeof source.credentialsPath === 'string' ? source.credentialsPath.trim() : '',
    timeoutMs: positiveInt(source.timeoutMs, DEFAULT_SETTINGS.timeoutMs),
    tool: source.tool !== false,
    simple: source.simple !== false,
  }
}

/**
 * 合并三层设置：默认值 → loader 配置 → 设置文件。
 * @param {object} [loaderConfig] - cordis patch 里给的 config。
 * @param {object} [options] - 读取参数。
 * @param {string} [options.path] - 设置文件路径，测试可注入。
 * @returns {Promise<object>} 合并后的设置。
 */
export async function loadSettings(loaderConfig = {}, options = {}) {
  const file = options.path ?? settingsPath()
  let fromFile = {}
  if (existsSync(file)) {
    try {
      fromFile = JSON.parse(await readFile(file, 'utf8'))
    } catch {
      // 坏设置文件不该让插件装载失败：退回默认值，让用户在设置页重写。
      fromFile = {}
    }
  }
  return normalizeSettings(deepMerge(deepMerge(DEFAULT_SETTINGS, loaderConfig), fromFile))
}

/**
 * 局部更新设置文件。
 * @param {object} patch - 要覆盖的字段（深合并）。
 * @param {object} [options] - 写入参数。
 * @param {string} [options.path] - 设置文件路径，测试可注入。
 * @returns {Promise<object>} 写入后的完整设置。
 */
export async function saveSettings(patch, options = {}) {
  const file = options.path ?? settingsPath()
  const current = await loadSettings({}, { path: file })
  const next = normalizeSettings(deepMerge(current, patch))
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify(next, null, 2) + '\n', 'utf8')
  return next
}

/** 深合并两个普通对象（数组与标量整体覆盖）。 */
function deepMerge(base, patch) {
  const out = { ...base }
  for (const [key, value] of Object.entries(patch ?? {})) {
    if (value === undefined) continue
    const current = out[key]
    if (isPlainObject(current) && isPlainObject(value)) out[key] = deepMerge(current, value)
    else out[key] = value
  }
  return out
}

/** @param {unknown} value @returns {boolean} */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** @param {unknown} value @returns {string|undefined} */
function nonEmpty(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/** @param {unknown} value @param {number} fallback @returns {number} */
function positiveInt(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback
}
