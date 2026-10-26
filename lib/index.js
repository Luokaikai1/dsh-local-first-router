/**
 * dsh-ollama-kaiyuanjl (local-first router) — host half.
 *
 * Tiers for a new session:
 *   1. executor: a local, tool-capable Ollama model (default qwen2.5:7b-24k);
 *   2. advisor: a local reasoning model (default deepseek-r1:8b-8k) exposed as
 *      `consult_advisor` and auto-consulted for math/logic/proof prompts;
 *   3. cloud: a paid route used only when the executor looks stuck or its
 *      context outgrows the local window, and only when the off-peak/balance
 *      gate and the free-credit policy allow it.
 *
 * Existing sessions are opted in with `manageExistingSessions`; they are then
 * guarded (never forced onto local), so long conversations keep their model.
 * Every decision is appended to a JSONL log.
 *
 * @module dsh-ollama-kaiyuanjl
 */
import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { createDeveloperMessage } from '@deepseek-ai/dsh-llm';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { beijingClock, isPeakBeijing } from './peak.js';
import { decide, gateCheck, normalizeConfig } from './policy.js';

/** Cordis plugin name. */
export const name = 'dsh-ollama-kaiyuanjl';

/** The tool registry must be present before the tools can mount. */
export const inject = ['tools'];

/** Flat config: every key has a default so a partial user layer is valid. */
export const Config = z.object({
  enabled: z.boolean().default(true),
  localProvider: z.string().default('local-ollama'),
  localModel: z.string().default('qwen2.5:7b-24k'),
  localBaseModel: z.string().default('qwen2.5:7b'),
  localContextTokens: z.number().default(24576),
  contextReserveTokens: z.number().default(1024),
  autoContextExpansion: z.boolean().default(false),
  manageOnlyNewSessions: z.boolean().default(true),
  manageExistingSessions: z.boolean().default(false),
  respectInitialSelection: z.boolean().default(true),
  includeSubagents: z.boolean().default(false),
  cloudProvider: z.string().default('deepseek-account'),
  cloudModel: z.string().default('deepseek-flash'),
  cloudReasoningEffort: z.string().default(''),
  fallbackProvider: z.string().default(''),
  fallbackModel: z.string().default(''),
  minBonusCny: z.number().default(1),
  minPaidCny: z.number().default(1),
  minBalanceCny: z.number().default(3),
  askBeforePaid: z.boolean().default(true),
  requireOffPeak: z.boolean().default(true),
  onBalanceUnavailable: z.string().default('block'),
  balanceCacheMs: z.number().default(300000),
  escalateToolErrors: z.number().default(2),
  escalateRepeatedCalls: z.number().default(2),
  escalateAfterStep: z.number().default(6),
  escalateLocalErrors: z.number().default(1),
  contextOverflowAction: z.string().default('escalate'),
  advisorModel: z.string().default('deepseek-r1:8b-8k'),
  advisorBaseURL: z.string().default('http://127.0.0.1:11434'),
  advisorTimeoutMs: z.number().default(240000),
  advisorSystemPrompt: z.string().default(''),
  autoConsult: z.string().default('inject'),
  autoConsultMaxChars: z.number().default(4000),
  logPath: z.string().default(''),
  statePath: z.string().default(''),
});

const DEFAULT_ADVISOR_PROMPT = [
  '你是一位资深顾问，只负责给出思路，不负责执行。',
  '对方是一个能力较弱但可以调用工具的智能体，会把问题转述给你。',
  '请输出：1) 问题的关键点；2) 清晰的解题步骤或推导；3) 容易踩的坑。',
  '不要写代码去执行，不要假设自己能用工具；用简洁的中文回答。',
].join('\n');

const HARD_PATTERNS = [
  /证明|推导|数学|方程|公式|不等式|概率|微积分|线性代数|数论|几何/,
  /逻辑|谜题|悖论|推理题|论证|归谬|反证/,
  /复杂度|算法分析|动态规划|图论|递归式/,
  /\bprove\b|\bproof\b|\bderive\b|\bderivation\b|\btheorem\b|\blemma\b/i,
  /\bmath(ematics)?\b|\bequation\b|\bprobability\b|\bcomplexity\b/i,
  /\blogic(al)?\s+(puzzle|problem)\b|\bparadox\b|\breasoning\b/i,
];

function matchHardSignal(text) {
  return HARD_PATTERNS.find((pattern) => pattern.test(text));
}

function messageText(message) {
  const content = message?.content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n');
}

function withRoute(base, provider, model, reasoningEffort) {
  if (base.provider === provider && base.model === model && !reasoningEffort) return base;
  const { reasoningEffort: _inherited, ...rest } = base;
  return {
    ...rest,
    provider,
    model,
    ...(reasoningEffort ? { reasoningEffort } : {}),
  };
}

function developerMessage(text) {
  return createDeveloperMessage({
    source: { kind: 'local-first-router' },
    content: [{ type: 'text', text }],
  });
}

/** Mount the router. */
export function apply(ctx, rawConfig) {
  const cfg = normalizeConfig(rawConfig);
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh');
  const logPath = cfg.logPath || join(dshHome, 'logs', 'local-first-router.jsonl');
  const statePath = cfg.statePath || join(dshHome, 'local-first-router', 'state.json');

  let logDirReady = false;
  function log(record) {
    try {
      if (!logDirReady) {
        mkdirSync(dirname(logPath), { recursive: true });
        logDirReady = true;
      }
      appendFileSync(logPath, `${JSON.stringify({
        at: new Date().toISOString(),
        clock: beijingClock(Date.now()),
        peak: isPeakBeijing(Date.now()),
        ...record,
      })}\n`, 'utf8');
    } catch (error) {
      ctx.logger?.warn?.(`local-first-router: cannot write log: ${String(error)}`);
    }
  }

  // Persistent state: first-run prompt and an "always allow paid" choice.
  const state = { firstRunAsked: false, allowPaid: false };
  try {
    if (existsSync(statePath)) Object.assign(state, JSON.parse(readFileSync(statePath, 'utf8')));
  } catch (error) {
    ctx.logger?.warn?.(`local-first-router: cannot read state file: ${String(error)}`);
  }
  function saveState() {
    try {
      mkdirSync(dirname(statePath), { recursive: true });
      writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    } catch (error) {
      ctx.logger?.warn?.(`local-first-router: cannot write state file: ${String(error)}`);
    }
  }
  let firstRun = state.firstRunAsked !== true;

  if (!cfg.enabled) {
    log({ action: 'disabled' });
    ctx.logger?.info?.('local-first-router: disabled by config');
    return;
  }

  // Optional: create the widened local model variant when it is missing.
  async function ensureLocalModel() {
    if (!cfg.autoContextExpansion) return;
    const base = String(cfg.localBaseModel || '').trim();
    const model = String(cfg.localModel || '').trim();
    if (base === '' || model === '' || base === model) return;
    const root = String(cfg.advisorBaseURL || '').replace(/\/+$/, '');
    try {
      const shown = await fetch(`${root}/api/show`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: model }),
      });
      if (shown.ok) {
        log({ action: 'local-model-present', model });
        return;
      }
      const created = await fetch(`${root}/api/create`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model,
          from: base,
          parameters: { num_ctx: cfg.localContextTokens },
          stream: false,
        }),
      });
      log({ action: 'local-model-create', model, from: base, ok: created.ok });
    } catch (error) {
      log({ action: 'local-model-create-error', model, error: String(error) });
    }
  }
  void ensureLocalModel();

  // ---------------------------------------------------------------- advisor
  async function askAdvisor(question, context, signal) {
    const root = String(cfg.advisorBaseURL).replace(/\/+$/, '');
    const user = context ? `${question}\n\n【已知上下文】\n${context}` : question;
    const body = {
      model: cfg.advisorModel,
      stream: false,
      temperature: 0.6,
      messages: [
        { role: 'system', content: cfg.advisorSystemPrompt || DEFAULT_ADVISOR_PROMPT },
        { role: 'user', content: user },
      ],
    };
    const timeout = AbortSignal.timeout(cfg.advisorTimeoutMs);
    const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
    const response = await fetch(`${root}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: combined,
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`advisor HTTP ${response.status}: ${detail.slice(0, 300)}`);
    }
    const json = await response.json();
    const message = json?.choices?.[0]?.message;
    const text = [message?.reasoning_content, message?.content]
      .filter((part) => typeof part === 'string' && part.trim().length > 0)
      .join('\n\n')
      .trim();
    if (text.length === 0) throw new Error('advisor returned no text');
    return text;
  }

  // ------------------------------------------------------- balance / quotas
  const balance = { bonus: undefined, paid: undefined, total: undefined, at: 0, pending: false };
  async function refreshBalance() {
    if (balance.pending) return;
    balance.pending = true;
    try {
      const account = ctx.get('deepseekAccount');
      if (typeof account?.getBalance !== 'function') {
        balance.bonus = null;
        balance.paid = null;
        balance.total = null;
      } else {
        const client = {
          version: '0.2.1',
          locale: 'zh-CN',
          timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
        };
        const result = await account.getBalance(client);
        if (result?.status === 'ready') {
          const pickup = (wallets) => wallets
            .filter((wallet) => wallet?.currency === 'CNY')
            .reduce((sum, wallet) => sum + Number(wallet.balance ?? 0), 0);
          balance.paid = pickup(Array.isArray(result.value) ? result.value : []);
          balance.bonus = pickup(Array.isArray(result.bonusWallets) ? result.bonusWallets : []);
          balance.total = balance.paid + balance.bonus;
        } else {
          balance.bonus = null;
          balance.paid = null;
          balance.total = null;
        }
      }
    } catch (error) {
      balance.bonus = null;
      balance.paid = null;
      balance.total = null;
      log({ action: 'balance-error', error: String(error) });
    } finally {
      balance.at = Date.now();
      balance.pending = false;
    }
  }
  function currentBalance(now) {
    if (balance.total === undefined || now - balance.at > cfg.balanceCacheMs) void refreshBalance();
    return balance.total;
  }

  // ------------------------------------------------------------------ tools
  async function quotaSnapshot() {
    if (balance.total === undefined || Date.now() - balance.at > cfg.balanceCacheMs) await refreshBalance();
    const primary = `${cfg.cloudProvider}/${cfg.cloudModel}`;
    const fallback = cfg.fallbackProvider && cfg.fallbackModel
      ? `${cfg.fallbackProvider}/${cfg.fallbackModel}`
      : '';
    const lines = [
      `本地执行: ${cfg.localProvider}/${cfg.localModel} (${cfg.localContextTokens} ctx)`,
      `本地顾问: ${cfg.advisorModel}`,
      `云端主用: ${primary}  赠送余额 ${balance.bonus ?? '未知'} 元 / 充值余额 ${balance.paid ?? '未知'} 元`,
      `云端兜底: ${fallback || '(未配置)'}  (额度未知，按错误或询问切换)`,
      `峰谷: ${isPeakBeijing(Date.now()) ? '高峰' : '谷时'}  付费余额使用: ${state.allowPaid ? '已允许' : '需确认'}`,
    ];
    return lines.join('\n');
  }

  ctx.tools.register(defineTool({
    name: 'model_quota',
    description: '显示当前接入的本地/云端模型、各自的上下文窗口、DeepSeek 赠送与充值余额、峰谷状态，以及云端兜底配置。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          summary: { type: 'string', required: true, description: '人类可读的额度摘要。' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.summary }],
    },
    async execute() {
      return { summary: await quotaSnapshot() };
    },
  }));

  ctx.tools.register(defineTool({
    name: 'set_cloud_policy',
    description: [
      '调整云端付费策略。allowPaid=true 表示允许在赠送额度不足时使用充值余额；',
      'useFallback=true 表示接下来优先用兜底模型；scope=always 会持久化。',
      '当插件提示“赠送额度不足，是否允许付费”时，询问用户后调用本工具。',
    ].join(''),
    parameters: {
      allowPaid: { type: 'boolean', description: '是否允许使用付费余额。' },
      useFallback: { type: 'boolean', description: '是否优先使用兜底模型。' },
      scope: { type: 'string', description: 'turn（本会话）或 always（持久化）。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          summary: { type: 'string', required: true, description: '策略更新结果。' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.summary }],
    },
    async execute(args, exec) {
      const sessionId = exec.agent?.session?.id;
      const scoped = states.get(sessionId);
      if (typeof args.allowPaid === 'boolean') {
        if (scoped !== undefined) scoped.allowPaidTurn = args.allowPaid;
        if (args.scope === 'always') {
          state.allowPaid = args.allowPaid;
          saveState();
        }
        if (scoped !== undefined) scoped.pendingAsk = false;
      }
      if (typeof args.useFallback === 'boolean' && scoped !== undefined) scoped.useFallback = args.useFallback;
      log({ action: 'set-cloud-policy', sessionId, allowPaid: args.allowPaid, useFallback: args.useFallback, scope: args.scope });
      return {
        summary: `allowPaid=${args.allowPaid === true} useFallback=${args.useFallback === true} scope=${args.scope ?? 'turn'} (persisted=${state.allowPaid})`,
      };
    },
  }));

  ctx.tools.register(defineTool({
    name: 'consult_advisor',
    description: [
      '向本地推理顾问（deepseek-r1:8b-8k）请教思路（不会执行任何工具，只返回文字）。',
      '当任务涉及数学推导、逻辑谜题、证明、复杂算法分析，或你多次尝试仍没有把握时，',
      '先调用本工具拿到解题思路，再自己用工具执行。',
      'question 写清楚要解决的问题；context 可选，放已知条件、代码或报错。',
    ].join(''),
    parameters: {
      question: { type: 'string', required: true, description: '要请教的问题，尽量具体。' },
      context: { type: 'string', description: '可选的已知条件、相关代码、数据或报错信息。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          advice: { type: 'string', required: true, description: '顾问返回的思路与推导。' },
          model: { type: 'string', required: true, description: '实际使用的顾问模型。' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.advice }],
    },
    timeoutMs: Math.max(cfg.advisorTimeoutMs + 30000, 60000),
    async execute(args, exec) {
      const question = String(args.question ?? '').trim();
      if (question.length === 0) throw new Error('consult_advisor: question is empty');
      const started = Date.now();
      try {
        const advice = await askAdvisor(question, args.context === undefined ? '' : String(args.context), exec.signal);
        log({ action: 'advisor', sessionId: exec.agent?.session?.id, ms: Date.now() - started, chars: advice.length, error: null });
        return { advice, model: cfg.advisorModel };
      } catch (error) {
        log({ action: 'advisor-error', sessionId: exec.agent?.session?.id, ms: Date.now() - started, error: String(error) });
        throw error;
      }
    },
  }));

  // --------------------------------------------------------- prompt nudges
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next();
    try {
      if (decision?.kind !== 'enter' || payload.step !== 1) return decision;
      const extra = [];

      if (firstRun) {
        firstRun = false;
        state.firstRunAsked = true;
        saveState();
        if (!cfg.autoContextExpansion) {
          extra.push(developerMessage([
            '[local-first-router] 首次启动：请用 ask_user_question 问用户是否开启“自动上下文扩展”',
            '（把本地模型包装成 24k 窗口，会自动创建 qwen2.5:7b-24k）。',
            '开启后把插件配置 autoContextExpansion 设为 true；不开启则保持默认窗口。',
          ].join('')));
        }
      }

      const session = payload.agent?.session;
      const scoped = session === undefined ? undefined : states.get(session.id);
      if (scoped?.pendingAsk) {
        scoped.pendingAsk = false;
        extra.push(developerMessage([
          '[local-first-router] 赠送余额不足。是否允许本轮使用付费余额或兜底模型？',
          '请用 ask_user_question 询问用户；用户同意后调用 set_cloud_policy(allowPaid=true, scope=turn)。',
        ].join('')));
      }

      if (cfg.autoConsult === 'inject' || cfg.autoConsult === 'nudge') {
        const text = (payload.messages ?? []).map(messageText).join('\n').trim();
        if (text.length > 0 && matchHardSignal(text) !== undefined) {
          let advice;
          if (cfg.autoConsult === 'inject') {
            const started = Date.now();
            try {
              advice = await askAdvisor(text.slice(0, 6000), '', payload.signal);
              advice = String(advice).slice(0, cfg.autoConsultMaxChars).trim();
              log({ action: 'auto-advisor', sessionId: session?.id, turn: payload.turn, ms: Date.now() - started, chars: advice.length });
            } catch (error) {
              log({ action: 'auto-advisor-error', sessionId: session?.id, error: String(error) });
              advice = undefined;
            }
          }
          extra.push(developerMessage(advice === undefined
            ? '[local-first-router] 这看起来是数学/逻辑/推导类难题。先用 consult_advisor 向本地顾问请教思路，再执行。'
            : `[local-first-router] 已向本地推理顾问请教，以下是它的思路；请按这个思路用工具执行：\n\n${advice}`));
        }
      }

      if (extra.length === 0) return decision;
      return { ...decision, messages: [...decision.messages, ...extra] };
    } catch (error) {
      log({ action: 'pre-step-error', error: String(error) });
      return decision;
    }
  });

  // ------------------------------------------------------------ route logic
  const states = new Map();
  const skipped = new Set();

  function contextTokensOf(session) {
    try {
      const projections = ctx.get('sessionProjections');
      const value = projections?.stateOf?.(session, 'contextPressure');
      const tokens = Number(value?.surfaceTokens);
      return Number.isFinite(tokens) && tokens > 0 ? tokens : 0;
    } catch {
      return 0;
    }
  }

  function isSubagent(session) {
    return session?.header?.origin === 'subagent';
  }

  function adoption(payload, base) {
    const session = payload.agent?.session;
    if (!session) return undefined;
    if (skipped.has(session.id)) return undefined;
    let scoped = states.get(session.id);
    if (scoped !== undefined) return scoped;

    if (!cfg.includeSubagents && isSubagent(session)) {
      skipped.add(session.id);
      return undefined;
    }
    const existing = session.requestHeader() !== undefined;
    const baseIsLocal = base.provider === cfg.localProvider && base.model === cfg.localModel;
    const eligible = existing ? (cfg.manageExistingSessions || !cfg.manageOnlyNewSessions) : true;
    const adopted = eligible && (existing ? true : (!cfg.respectInitialSelection || baseIsLocal));
    if (!adopted) {
      skipped.add(session.id);
      log({
        action: 'skip-session',
        sessionId: session.id,
        reason: existing ? 'existing-session' : 'initial-selection-differs',
        route: `${base.provider}/${base.model}`,
      });
      return undefined;
    }
    scoped = {
      mode: existing ? 'guard' : 'local-first',
      turn: payload.turn,
      toolErrors: 0,
      repeatedCalls: 0,
      localErrors: 0,
      cloud: false,
      cloudReason: '',
      lastCall: '',
      contextNoted: false,
      allowPaidTurn: false,
      useFallback: false,
      pendingAsk: false,
    };
    states.set(session.id, scoped);
    log({ action: 'adopt-session', sessionId: session.id, turn: payload.turn, mode: scoped.mode });
    return scoped;
  }

  function resetTurn(scoped, turn) {
    scoped.turn = turn;
    scoped.toolErrors = 0;
    scoped.repeatedCalls = 0;
    scoped.localErrors = 0;
    scoped.cloud = false;
    scoped.cloudReason = '';
    scoped.lastCall = '';
    scoped.contextNoted = false;
    scoped.allowPaidTurn = false;
  }

  /**
   * Pick the cloud route honoring free credits first, then paid balance, then
   * the configured fallback. Returns `{ route }` or `{ ask, reason }`.
   */
  function pickCloud(scoped) {
    const primary = { provider: cfg.cloudProvider, model: cfg.cloudModel, reason: 'primary' };
    const fallback = cfg.fallbackProvider && cfg.fallbackModel
      ? { provider: cfg.fallbackProvider, model: cfg.fallbackModel, reason: 'fallback' }
      : undefined;
    if (scoped.useFallback && fallback !== undefined) return { route: fallback };
    if (cfg.cloudProvider !== 'deepseek-account') return { route: primary };
    // DeepSeek account: distinguish granted (free) from topped-up (paid).
    if (balance.bonus !== undefined && balance.bonus !== null) {
      if (balance.bonus >= cfg.minBonusCny) return { route: primary };
      if (balance.paid !== null && balance.paid >= cfg.minPaidCny) {
        if (!cfg.askBeforePaid || state.allowPaid || scoped.allowPaidTurn) return { route: primary };
        return { ask: 'paid', reason: 'bonus-low' };
      }
      if (fallback !== undefined && (!cfg.askBeforePaid || state.allowPaid || scoped.allowPaidTurn)) {
        return { route: fallback };
      }
      return { ask: 'paid', reason: 'bonus-empty' };
    }
    return { route: primary };
  }

  async function route(payload, base) {
    if (!cfg.enabled || !base) return base;
    const session = payload.agent?.session;
    if (!session) return base;
    const scoped = adoption(payload, base);
    if (scoped === undefined) return base;
    if (scoped.turn !== payload.turn) resetTurn(scoped, payload.turn);

    const now = Date.now();
    const gate = gateCheck(cfg, { peak: isPeakBeijing(now), balance: currentBalance(now) });
    const tokens = contextTokensOf(session);
    const localLimit = Math.max(1024, cfg.localContextTokens - cfg.contextReserveTokens);
    const contextFull = tokens > localLimit;
    const baseIsLocal = base.provider === cfg.localProvider;
    const localRoute = () => withRoute(base, cfg.localProvider, cfg.localModel, '');

    const useCloud = (reason) => {
      const pick = pickCloud(scoped);
      if (pick.route === undefined) {
        scoped.pendingAsk = pick.ask === 'paid';
        log({
          action: 'cloud-ask',
          sessionId: session.id,
          turn: payload.turn,
          step: payload.step,
          reason: pick.reason,
          bonus: balance.bonus,
          paid: balance.paid,
        });
        return localRoute();
      }
      scoped.cloud = true;
      scoped.cloudReason = scoped.cloudReason || reason;
      log({
        action: 'escalate',
        sessionId: session.id,
        turn: payload.turn,
        step: payload.step,
        reason,
        cloud: `${pick.route.provider}/${pick.route.model}`,
        via: pick.route.reason,
        bonus: balance.bonus,
        paid: balance.paid,
      });
      return withRoute(base, pick.route.provider, pick.route.model, cfg.cloudReasoningEffort);
    };

    if (scoped.mode === 'guard') {
      if (!contextFull) return base;
      if (!scoped.contextNoted) {
        scoped.contextNoted = true;
        log({
          action: 'context-hold-cloud',
          sessionId: session.id,
          turn: payload.turn,
          tokens,
          limit: localLimit,
          route: `${base.provider}/${base.model}`,
        });
      }
      if (baseIsLocal && gate.ok) return useCloud('context-full');
      if (baseIsLocal && !gate.ok) {
        log({ action: 'context-blocked', sessionId: session.id, turn: payload.turn, tokens, reason: gate.reason });
      }
      return base;
    }

    if (contextFull) {
      if (!scoped.contextNoted) {
        scoped.contextNoted = true;
        log({ action: 'context-full', sessionId: session.id, turn: payload.turn, tokens, limit: localLimit, gate: gate.ok });
      }
      if (gate.ok) return useCloud('context-full');
      log({ action: 'context-blocked', sessionId: session.id, turn: payload.turn, tokens, reason: gate.reason });
      return localRoute();
    }

    const verdict = decide(cfg, scoped, payload.step, gate);
    if (verdict.action === 'cloud') return useCloud(verdict.reason);

    log({
      action: 'stay-local',
      sessionId: session.id,
      turn: payload.turn,
      step: payload.step,
      reason: verdict.reason,
      balance: balance.total,
    });
    return localRoute();
  }

  ctx.on('agent/request', async (payload, next) => {
    const base = await next();
    try {
      return await route(payload, base);
    } catch (error) {
      log({ action: 'route-error', error: String(error), sessionId: payload?.agent?.session?.id });
      return base;
    }
  }, { prepend: true });

  ctx.on('session/event', (session, event) => {
    const scoped = states.get(session?.id);
    if (scoped === undefined || event === undefined) return;
    switch (event.type) {
      case 'turn/start':
        resetTurn(scoped, event.data?.turn ?? scoped.turn);
        break;
      case 'tool/call': {
        const signature = `${event.data?.name}\u0000${event.data?.arguments}`;
        if (scoped.lastCall === signature) scoped.repeatedCalls += 1;
        else {
          scoped.lastCall = signature;
          scoped.repeatedCalls = 0;
        }
        break;
      }
      case 'tool/result':
        if (event.data?.message?.isError === true || event.data?.error !== undefined) scoped.toolErrors += 1;
        break;
      default:
        break;
    }
  });

  ctx.on('agent/error', (payload) => {
    const session = payload?.agent?.session;
    const scoped = session === undefined ? undefined : states.get(session.id);
    if (scoped === undefined) return;
    const provider = session.requestContext?.()?.provider;
    if (provider === cfg.localProvider) {
      scoped.localErrors += 1;
      log({ action: 'local-error', sessionId: session.id, error: String(payload?.error ?? '') });
    }
    if (provider === cfg.cloudProvider && cfg.fallbackProvider && cfg.fallbackModel) {
      scoped.useFallback = true;
      log({ action: 'cloud-fallback', sessionId: session.id, from: cfg.cloudProvider, to: cfg.fallbackProvider });
    }
  });

  ctx.effect(() => () => {
    states.clear();
    skipped.clear();
    log({ action: 'unmount' });
  }, 'local-first-router: state');

  ctx.logger?.info?.(`local-first-router: executor ${cfg.localProvider}/${cfg.localModel}; advisor ${cfg.advisorModel}; cloud ${cfg.cloudProvider}/${cfg.cloudModel}${cfg.fallbackProvider ? ` -> ${cfg.fallbackProvider}/${cfg.fallbackModel}` : ''}`);
}
