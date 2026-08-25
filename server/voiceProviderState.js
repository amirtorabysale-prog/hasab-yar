const DEFAULT_RATE_LIMIT_SECONDS = 60;
const DEFAULT_QUOTA_COOLDOWN_SECONDS = 30 * 60;

const cooldowns = new Map();

function positiveSeconds(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.ceil(parsed) : fallback;
}

function failureFromCooldown(cooldown, now = Date.now()) {
  const retryAfterSeconds = Math.max(1, Math.ceil((cooldown.until - now) / 1000));
  return Object.assign(new Error(cooldown.message), {
    code: cooldown.code,
    status: 503,
    provider: 'openai',
    retryAfterSeconds,
    requiresAction: cooldown.requiresAction,
  });
}

export function activeOpenAICooldown(scope, now = Date.now()) {
  for (const key of ['openai-all', scope]) {
    const cooldown = cooldowns.get(key);
    if (!cooldown) continue;
    if (cooldown.until <= now) {
      cooldowns.delete(key);
      continue;
    }
    return { ...cooldown, retryAfterSeconds: Math.max(1, Math.ceil((cooldown.until - now) / 1000)) };
  }
  return null;
}

function publicCooldown(scope, now) {
  const cooldown = activeOpenAICooldown(scope, now);
  if (!cooldown) return null;
  return {
    code: cooldown.code,
    retryAfterSeconds: cooldown.retryAfterSeconds,
    requiresAction: Boolean(cooldown.requiresAction),
  };
}

export function voiceProviderStatus(env = process.env, now = Date.now()) {
  const order = String(env.VOICE_PROVIDER_ORDER || 'openai,gemini')
    .split(',')
    .map((provider) => provider.trim().toLowerCase())
    .filter((provider, index, values) => ['openai', 'gemini'].includes(provider) && values.indexOf(provider) === index);
  const configured = {
    openai: Boolean(env.OPENAI_API_KEY),
    gemini: Boolean(env.GEMINI_API_KEY),
  };
  const realtimeCooldown = publicCooldown('openai-realtime', now);
  const fileCooldown = publicCooldown('openai-file', now);
  const fileProviders = order.map((provider) => {
    const cooldown = provider === 'openai' ? fileCooldown : null;
    return {
      provider,
      configured: configured[provider],
      available: configured[provider] && !cooldown,
      model: provider === 'openai'
        ? (env.OPENAI_TRANSCRIBE_MODEL || 'gpt-transcribe')
        : (env.GEMINI_MODEL || 'gemini-3.7-flash'),
      cooldown,
    };
  });
  return {
    realtime: {
      configured: configured.openai,
      available: configured.openai && !realtimeCooldown,
      model: env.OPENAI_REALTIME_TRANSCRIBE_MODEL || 'gpt-live-transcribe',
      cooldown: realtimeCooldown,
    },
    file: {
      available: fileProviders.some((provider) => provider.available),
      providers: fileProviders,
    },
  };
}

export function assertOpenAIAvailable(scope, now = Date.now()) {
  const cooldown = activeOpenAICooldown(scope, now);
  if (cooldown) throw failureFromCooldown(cooldown, now);
}

export function markOpenAIRateLimit(scope, response, body = {}, now = Date.now()) {
  const upstreamCode = String(body?.error?.code || '');
  const upstreamType = String(body?.error?.type || '');
  const requiresAction = [upstreamCode, upstreamType].some((value) => /insufficient_quota|billing|hard_limit/i.test(value));
  const retryAfterSeconds = requiresAction
    ? DEFAULT_QUOTA_COOLDOWN_SECONDS
    : positiveSeconds(response?.headers?.get?.('retry-after'), DEFAULT_RATE_LIMIT_SECONDS);
  const code = requiresAction ? 'VOICE_QUOTA' : 'VOICE_RATE_LIMIT';
  const message = requiresAction
    ? 'اعتبار یا بودجهٔ پروژهٔ OpenAI تمام شده است؛ Billing و Limits پروژه را بررسی کن.'
    : 'محدودیت موقت سرویس صدا فعال شده است؛ کمی بعد دوباره امتحان کن.';
  const key = requiresAction ? 'openai-all' : scope;
  const cooldown = { code, message, requiresAction, until: now + retryAfterSeconds * 1000 };
  cooldowns.set(key, cooldown);
  return failureFromCooldown(cooldown, now);
}

export function resetVoiceProviderState() {
  cooldowns.clear();
}
