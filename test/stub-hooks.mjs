/**
 * 把宿主包解析到测试替身。
 *
 * `@deepseek-ai/*` 在真实运行里由 dsh 提供同一份实例，裸 Node 里没有，
 * 所以把接入点的**契约形状**替身掉：Service 只要求 provide，defineTool 只校验形状。
 */
export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@deepseek-ai/dsh-tools') {
    return { url: new URL('./stubs/dsh-tools.js', import.meta.url).href, shortCircuit: true }
  }
  if (specifier === '@deepseek-ai/cordis') {
    return { url: new URL('./stubs/cordis.js', import.meta.url).href, shortCircuit: true }
  }
  return nextResolve(specifier, context)
}
