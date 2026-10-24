/**
 * `@deepseek-ai/dsh-tools` 的测试替身：只保证契约形状。
 */
export function defineTool(options) {
  if (options === null || typeof options !== 'object') throw new TypeError('defineTool 需要一个定义对象')
  if (typeof options.name !== 'string' || options.name === '') throw new TypeError('defineTool: name 必填')
  if (typeof options.description !== 'string' || options.description === '') throw new TypeError('defineTool: description 必填')
  if (options.parameters === undefined) throw new TypeError('defineTool: parameters 必填')
  if (options.output === undefined) throw new TypeError('defineTool: output 必填')
  if (typeof options.execute !== 'function') throw new TypeError('defineTool: execute 必填')
  return { ...options }
}
