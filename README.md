# dsh-jev

把 [Jev](https://typesafe.ai)（TypeSafe "System One" 判定模型）做成一个 **DSH 可注入服务**。
Jev 不生成文本：它对一段 state 回答类型化问题，返回**校准过的概率分布**。
适合路由、分类、相关性排序；不适合写解释或长文。

```
POST https://api.commandcode.ai/provider/v1/systemone
body  { model, state, questions: { <id>: { type, instructions, criteria } } }
resp  { model, answers: { <id>: { type, choice, confidence, probabilities } }, usage }
```

## 给其他插件用

### 1. 服务（推荐）

```js
// 装得上服务
export const inject = ['tools']
const jev = ctx.get('jev')          // 惰性读：没有这个插件时返回 undefined
if (jev) {
  const { answers } = await jev.ask({
    state: '……要评估的文本……',
    questions: {
      who: { type: 'choice', instructions: '下一位该谁做？', criteria: { a: '说明', b: '说明' } },
    },
  })
}
```

**不要**把 `'jev'` 写进 `inject` 数组：没装这个插件的 profile 会卡在 PENDING。
**不要**写 `ctx.jev` 属性访问：cordis 对未 inject 的服务直接抛错。

### 2. 纯函数（不需要装插件）

```js
import { askJevQuestions, rankOptions } from 'dsh-jev/ask'
const { answers } = await askJevQuestions({ state, questions })
const top = rankOptions(answers.decision, ['a', 'b']).slice(0, 2)
```

`dsh-jev/ask` 零宿主依赖（只依赖 `node:fs` / `node:path` / `yaml`）。

## 服务 API

| 方法 | 用途 |
| --- | --- |
| `await jev.ask({ state, questions })` | 一次往返，返回 `{ answers, model?, usage?, keyFrom }` |
| `await jev.ask({ state, question, options })` | 单问糖，额外返回顶层 `choice` / `confidence` / `probabilities` |
| `await jev.available()` | 有没有凭证（不发请求） |
| `await jev.describe()` | `{ configured, keyFrom, endpoint, model, enabled }`，**不含 key** |
| `await jev.settings()` | 生效设置；key 显示为 `***` |

端点与凭证**永远**取自本插件的设置：`ask()` 只允许覆盖 `model` / `timeoutMs` / `signal`，
调用方无法把 key 发到别处。

## 工具 `jev_ask`

**与插件同生共死**：`enabled` 同时决定服务与工具，没有独立的工具开关。两种写法二选一：

```jsonc
// 结构化
{ "state": "……", "questions": { "q": { "type": "choice", "instructions": "……", "criteria": { "a": "说明" } } } }
// 一句话
{ "state": "……", "question": "选一个", "options": ["a", "b"] }
```

错误不抛异常，而是返回 `{ ok: false, reason: 'no_key' | 'disabled' | 'missing' | 'bad_args' | 'unreachable', message }`。

## 配置

`$DSH_HOME/dsh-jev/config.json`（设置页写的就是它），默认值 → loader 配置 → 文件层。

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总闸 |
| `baseUrl` | command-code provider | 端点 base URL |
| `model` | `jev-latest` | 模型 |
| `apiKey` | `''` | 直接把 key 写进文件（不推荐） |
| `apiKeyEnv` | `COMMAND_CODE_API_KEY` | 凭证环境变量名 |
| `credentialsPath` | `$DSH_HOME/.credentials.yaml` | 凭证文件 |
| `timeoutMs` | `20000` | 单次超时 |

凭证解析顺序：`apiKey` → 环境变量 `apiKeyEnv` → `TYPESAFE_API_KEY` → 凭证文件 `refs`。
**没有 key 时 `ask()` 抛 `JEV_NO_KEY`，插件本身照常装载。**

## 两个维护入口，别搞混

| 子路径 | 文件 | 谁用 |
| --- | --- | --- |
| `dsh-jev` | `src/index.js` | 宿主 loader（`cordis.patch.yml`） |
| `dsh-jev/client` | `lib/client.js` | **浏览器**：web boot 按 `exports["./client"]` 找它 |
| `dsh-jev/ask` | `src/client.js` | **Node**：其他插件 `import { askJevQuestions } from 'dsh-jev/ask'` |

`./client` 必须是 `window.__ModuleLoader__.load({ id, factory })` 信封。它一旦是普通 ESM
模块，启动日志就会出现 `dsh-jev/client.js … loaded without registering`——这正是早期把
Node 侧的纯函数文件放在 `./client` 上造成的。

## 设置页在哪

**设置 → 插件 → dsh-jev**（插件详情页里，描述与组件列表之间），不是设置页的顶层栏目。

实现方式：客户端把组件注册到 **`plugins.bundle.config`** 这个 **keyed** 槽，
键就是包的 npm 名 `dsh-jev`。槽的所有者是 `@deepseek-ai/dsh-client-ui-plugin-manager`
（契约在它的 `src/client/slot-contract.ts`）；插件页把这个槽渲染在
`data-plugin-config` 段里，并且只传 `view: 'page'`。

字段：启用开关、端点、模型、凭证变量名、超时、以及 API Key（写入即走凭证缝，不回显）。
**启用 = 同时提供 `ctx.jev` 与 `jev_ask`**，不设第二个开关。

浏览器端经 `/api/jev` 走 HTTP 信封（`{ endpoint, args }` → `{ ok, value|error }`），
这与 `dsh-agents-group` 同一条已验证的通道；路由在宿主侧用 `ctx.inject(['connection'])`
惰性挂载，没有 Connection 的 profile 不受影响。

## 安装

```bash
dsh plugin --profile web add link:F:/gitProject/dsh-plugins/dsh-jev
```

## 测试

```bash
pnpm install && pnpm test
```
