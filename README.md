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
import { askJevQuestions, rankOptions } from 'dsh-jev/client'
const { answers } = await askJevQuestions({ state, questions })
const top = rankOptions(answers.decision, ['a', 'b']).slice(0, 2)
```

`dsh-jev/client` 零宿主依赖（只依赖 `node:fs` / `node:path` / `yaml`）。

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

默认对模型开放（设置里 `tool: false` 可关）。两种写法二选一：

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
| `tool` | `true` | `jev_ask` 是否对模型开放 |

凭证解析顺序：`apiKey` → 环境变量 `apiKeyEnv` → `TYPESAFE_API_KEY` → 凭证文件 `refs`。
**没有 key 时 `ask()` 抛 `JEV_NO_KEY`，插件本身照常装载。**

## 安装

```bash
dsh plugin --profile web add link:F:/gitProject/dsh-plugins/dsh-jev
```

## 测试

```bash
pnpm install && pnpm test
```
