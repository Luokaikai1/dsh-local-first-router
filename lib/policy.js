/**
 * Routing policy for dsh-local-first-router (pure logic, no dependencies).
 *
 * A session starts on the local model. Within one turn the router escalates to
 * the cloud model only when a trigger fires AND the gate agrees (off-peak,
 * balance above the floor). Escalation is sticky until the turn ends.
 */

/** Defaults applied over the user's flat config. */
export const DEFAULTS = {
  enabled: true,
  localProvider: 'local-ollama',
  localModel: 'qwen2.5:7b-24k',
  cloudProvider: 'deepseek-account',
  cloudModel: 'deepseek-flash',
  cloudReasoningEffort: '',
  localContextTokens: 24576,
  contextReserveTokens: 1024,
  manageExistingSessions: false,
  contextOverflowAction: 'escalate',
  advisorModel: 'deepseek-r1:8b-8k',
  advisorBaseURL: 'http://127.0.0.1:11434',
  advisorTimeoutMs: 240000,
  advisorSystemPrompt: '',
  autoConsult: 'inject',
  autoConsultMaxChars: 4000,
  fallbackProvider: '',
  fallbackModel: '',
  minBonusCny: 1,
  minPaidCny: 1,
  askBeforePaid: true,
  autoContextExpansion: false,
  localBaseModel: 'qwen2.5:7b',
  statePath: '',
  escalateToolErrors: 2,
  escalateRepeatedCalls: 2,
  escalateAfterStep: 6,
  escalateLocalErrors: 1,
  requireOffPeak: true,
  minBalanceCny: 3,
  balanceCacheMs: 300000,
  onBalanceUnavailable: 'block',
  manageOnlyNewSessions: true,
  respectInitialSelection: true,
  includeSubagents: false,
  logPath: '',
};

/** Merge a user config over {@link DEFAULTS}, ignoring `undefined` values. */
export function normalizeConfig(raw) {
  const out = { ...DEFAULTS };
  for (const key of Object.keys(DEFAULTS)) {
    const value = raw?.[key];
    if (value !== undefined && value !== null && value !== '') out[key] = value;
  }
  out.enabled = raw?.enabled !== false;
  out.requireOffPeak = raw?.requireOffPeak !== false;
  out.manageOnlyNewSessions = raw?.manageOnlyNewSessions !== false;
  out.respectInitialSelection = raw?.respectInitialSelection !== false;
  out.includeSubagents = raw?.includeSubagents === true;
  out.manageExistingSessions = raw?.manageExistingSessions === true;
  out.askBeforePaid = raw?.askBeforePaid !== false;
  out.autoContextExpansion = raw?.autoContextExpansion === true;
  return out;
}

/** Whether a positive threshold is configured and reached. */
function reached(threshold, value) {
  return Number.isFinite(threshold) && threshold > 0 && value >= threshold;
}

/**
 * First trigger that says the local model is stuck in this turn, or `null`.
 * @param cfg normalized config
 * @param st per-session state
 * @param step current step number (1-based)
 */
export function evaluateTrigger(cfg, st, step) {
  if (reached(cfg.escalateLocalErrors, st.localErrors)) return 'local-error';
  if (reached(cfg.escalateToolErrors, st.toolErrors)) return 'tool-errors';
  if (reached(cfg.escalateRepeatedCalls, st.repeatedCalls)) return 'repeated-call';
  if (reached(cfg.escalateAfterStep, step)) return 'long-turn';
  return null;
}

/**
 * Off-peak + balance gate.
 * @param cfg normalized config
 * @param facts `{ peak, balance }`; `balance === undefined` means not yet known,
 *              `null` means the query failed or the account is signed out.
 * @returns `{ ok, reason }`
 */
export function gateCheck(cfg, facts) {
  if (cfg.requireOffPeak && facts.peak) return { ok: false, reason: 'peak-hours' };
  const min = Number(cfg.minBalanceCny);
  if (Number.isFinite(min) && min > 0) {
    if (facts.balance === undefined) return { ok: false, reason: 'balance-unknown' };
    if (facts.balance === null) {
      return cfg.onBalanceUnavailable === 'allow'
        ? { ok: true, reason: 'balance-unavailable-allowed' }
        : { ok: false, reason: 'balance-unavailable' };
    }
    if (facts.balance < min) return { ok: false, reason: `balance-low(${facts.balance})` };
  }
  return { ok: true, reason: 'ok' };
}

/**
 * Final action for one request.
 * @returns `{ action: 'local' | 'cloud', reason }`
 */
export function decide(cfg, st, step, gate) {
  if (st.cloud) return { action: 'cloud', reason: `${st.cloudReason}+sticky` };
  const trigger = evaluateTrigger(cfg, st, step);
  if (trigger === null) return { action: 'local', reason: 'local-first' };
  if (!gate.ok) return { action: 'local', reason: `blocked:${gate.reason}<-${trigger}` };
  return { action: 'cloud', reason: trigger };
}
