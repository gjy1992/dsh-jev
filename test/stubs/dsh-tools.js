/**
 * `@deepseek-ai/dsh-tools` 在测试里的转发层。
 *
 * **不要再造一个只校验形状的假 defineTool。** 一开始就是这么写的，于是它放过了一个
 * 真实启动时才炸的错：值 schema DSL 要求 object 节点显式声明 additionalProperties，
 * 而假桩从不编译 schema——测试全绿、插件却激活失败（2026-10-24 实测）。
 *
 * 这里直接把调用转给**真实实现**，测试跑的就是宿主同一套 schema 编译器。
 * 用的是包内文件的绝对路径而不是裸 specifier：裸 specifier 会被本钩子再拦一次，
 * 变成自我引用的解析环。
 */
export * from 'file:///F:/gitProject/dsh-plugins/dsh-jev/node_modules/@deepseek-ai/dsh-tools/lib/index.js'
