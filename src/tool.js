/**
 * jev_ask：给模型的 Jev 判定工具。
 *
 * 三个刻意的取舍：
 *   - **错误走返回值，不走 throw**：抛出去只会折叠成通用错误，模型看不到原因；
 *   - **exec.signal 透传**：用户按停止之后，在飞的那次 Jev 请求要跟着取消；
 *   - **要么 questions、要么 question**：模型只会写哪一种都接住，但哪一种都没给就明确报错。
 */

import { defineTool } from '@deepseek-ai/dsh-tools'

/** 提示里的示例文本（指标题与一句话两种形态）。 */
export const TOOL_DESCRIPTION =
  '向 Jev（TypeSafe System One 判定模型）提问，拿回校准过的概率分布。'
  + 'Jev **不生成文本**：它只回答「在给定的候选里选哪个 / 有多确信」。'
  + '需要一段解释、总结或代码时不要用它——那不是它的产出。'
  + '典型用法：分类（这段属于哪一类）、指派（下一步该谁做）、筛选（这几条里哪条最相关）。'
  + '两种写法二选一：(a) 结构化：给 questions，每个问题是 { type:"choice", instructions, criteria }，'
  + 'criteria 是「候选名 → 一句说明」，至少 2 项；(b) 一句话：只给 question 和 options，'
  + '服务会把它包成单个 choice 问题，答案在返回的 choice / probabilities 里。'
  + '返回里 answers 是原始的 id → { choice, confidence, probabilities }；'
  + 'probabilities 是**全分布**，一次调用就能按概率挑出前 k 项，不要为了排序反复调用。'

/** 统一的返回值渲染：把 JSON 给模型看，但去掉噪音。 */
const JSON_OUTPUT = {
  schema: { type: 'json' },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
}

/**
 * 把服务抛出的错误归类成模型能看见的原因。
 * @param {unknown} error - 异常。
 * @returns {string} reason 码。
 */
function reasonOf(error) {
  const message = error instanceof Error ? error.message : String(error)
  if (message.startsWith('JEV_NO_KEY')) return 'no_key'
  if (message.startsWith('JEV_DISABLED')) return 'disabled'
  if (message.includes('abort')) return 'aborted'
  return 'unreachable'
}

/**
 * 造 jev_ask 的工具定义。
 * @param {object} options - 参数。
 * @param {() => Promise<object|undefined>} options.serviceOf - 惰性取服务（拿不到时 undefined）。
 * @returns {object} defineTool 的结果。
 */
export function jevAskTool(options) {
  return defineTool({
    name: 'jev_ask',
    description: TOOL_DESCRIPTION,
    parameters: {
      state: {
        type: 'string',
        required: true,
        description: '要评估的文本：聊天记录、待分类的消息、候选说明都可以。Jev 全部的问题都基于它。',
      },
      questions: {
        type: 'object',
        description: '结构化写法：问题 id → { type:"choice", instructions, criteria }。'
          + 'criteria 是「候选名 → 一句说明」，每问至少 2 项。与 question/options 二选一。',
      },
      question: {
        type: 'string',
        description: '一句话写法：要做的判断。与 questions 二选一（给了 questions 时忽略它）。',
      },
      options: {
        type: 'array',
        items: { type: 'string' },
        description: '一句话写法：候选列表，至少 2 项。',
      },
      model: { type: 'string', description: '覆盖模型；省略用设置里的默认值。' },
    },
    output: JSON_OUTPUT,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const jev = await options.serviceOf()
      if (jev === undefined) return { ok: false, reason: 'missing' }
      const structured = args.questions && typeof args.questions === 'object' && Object.keys(args.questions).length > 0
      if (!structured) {
        const question = typeof args.question === 'string' ? args.question.trim() : ''
        const optionsList = Array.isArray(args.options) ? args.options : []
        if (question === '' || optionsList.length < 2) {
          return { ok: false, reason: 'bad_args', message: '要么给 questions，要么给 question 加至少 2 个 options。' }
        }
      }
      const state = typeof args.state === 'string' ? args.state : ''
      if (state.trim() === '') return { ok: false, reason: 'bad_args', message: 'state 不能为空。' }
      try {
        const spec = structured
          ? { state, questions: args.questions }
          : { state, question: args.question, options: args.options }
        const result = await jev.ask({
          ...spec,
          ...(typeof args.model === 'string' && args.model !== '' ? { model: args.model } : {}),
          ...(exec && exec.signal ? { signal: exec.signal } : {}),
        })
        return { ok: true, ...result }
      } catch (error) {
        return {
          ok: false,
          reason: reasonOf(error),
          message: error instanceof Error ? error.message : String(error),
        }
      }
    },
  })
}
