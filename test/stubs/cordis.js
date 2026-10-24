/**
 * `@deepseek-ai/cordis` 的最小替身：只保留本插件用到的契约。
 *
 * 真实实现里 Service 的构造函数会 ctx.reflect.provide(name, this)，并把注册的
 * 生命周期绑到当前 fiber 上。这里只保留「注册进 ctx」这一点，够测可见性。
 */
export class Service {
  constructor(ctx, name) {
    this.ctx = ctx
    this.name = name
    if (typeof ctx.provide === 'function') ctx.provide(name, this)
  }
}
