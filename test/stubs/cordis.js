/**
 * `@deepseek-ai/cordis` 在测试里的版本。
 *
 * **不要造假 Context / Service**：`@deepseek-ai/dsh-tools` 会 `import { Context }
 * from '@deepseek-ai/cordis'`，一个只有 Service 的假桩会让它在链接期就崩。
 * 这里全部转给真实实现；真实 cordis 能在裸 Node 里直接 new Context()，
 * 测出来的就是宿主里那份行为。
 */
export * from 'file:///F:/gitProject/dsh-plugins/dsh-jev/node_modules/@deepseek-ai/cordis/lib/index.js'
