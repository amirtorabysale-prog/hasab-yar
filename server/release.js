const SHA_VARIABLES = ['RAILWAY_GIT_COMMIT_SHA', 'GITHUB_SHA', 'SOURCE_VERSION', 'COMMIT_SHA'];

export function releaseIdentity(environment = process.env) {
  for (const name of SHA_VARIABLES) {
    const value = String(environment?.[name] || '').trim().toLowerCase();
    if (/^[0-9a-f]{7,40}$/.test(value)) return { sha: value, source: name };
  }
  return { sha: 'unknown', source: 'unavailable' };
}

export function healthPayload(environment = process.env) {
  return {
    ok: true,
    release: releaseIdentity(environment),
    voicePipeline: 'openai-transcribe+deterministic-parser+gemini-fallback-v2',
  };
}
