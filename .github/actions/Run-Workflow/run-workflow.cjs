const fs = require('node:fs');

function configFromEnv(env) {
  const config = {
    repo: env.INPUT_REPO,
    workflow: env.INPUT_WORKFLOW,
    ref: env.INPUT_REF,
    goal: env.INPUT_GOAL || 'start',
    token: env.INPUT_ACCESS_TOKEN,
    nameFilter: env.INPUT_WAIT_NAME_FILTER || '',
    interval: Number(env.INPUT_POLL_INTERVAL_SECONDS || 60) * 1000,
    timeout: Number(env.INPUT_TIMEOUT_MINUTES || 45) * 60000,
    apiUrl: env.GITHUB_API_URL || 'https://api.github.com',
    debug: env.INPUT_DEBUG === 'true',
    inputs: {},
  };
  if (!/^[^/\s]+\/[^/\s]+$/.test(config.repo || '')) throw new Error('repo must be owner/name');
  if (!config.workflow || !config.ref) throw new Error('workflow and ref are required');
  if (!['start', 'complete', 'success'].includes(config.goal)) throw new Error('Invalid goal');
  if (!Number.isInteger(config.interval) || config.interval < 30000) {
    throw new Error('poll_interval_seconds must be at least 30');
  }
  if (!Number.isInteger(config.timeout) || config.timeout < 60000 || config.timeout > 3300000) {
    throw new Error('timeout_minutes must be between 1 and 55');
  }
  for (let i = 1; i <= 10; i++) {
    const field = env[`INPUT_FIELD${i}`];
    if (!field) continue;
    const separator = field.indexOf('=');
    if (separator < 1) throw new Error(`field${i} must be name=value`);
    const name = field.slice(0, separator);
    if (Object.hasOwn(config.inputs, name)) throw new Error(`Duplicate workflow input: ${name}`);
    // Older callers wrap values in quotes for the previous shell-based implementation.
    let value = field.slice(separator + 1);
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    Object.defineProperty(config.inputs, name, { value, enumerable: true });
  }
  return config;
}

function validateCredentials(env) {
  const hasApp = Boolean(env.INPUT_APP_ID || env.INPUT_APP_PRIVATE_KEY);
  if (hasApp && !(env.INPUT_APP_ID && env.INPUT_APP_PRIVATE_KEY)) {
    throw new Error('Both app_id and app_private_key are required');
  }
  if (hasApp === Boolean(env.INPUT_ACCESS_TOKEN)) {
    throw new Error('Supply either App credentials or access_token, not both or neither');
  }
}

function createClient(config, deps = {}) {
  const now = deps.now || Date.now;
  const sleep = deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const fetch = deps.fetch || globalThis.fetch;
  const log = deps.log || console.log;
  const deadline = now() + config.timeout;
  const cache = new Map();
  let nextRequestAt = 0;
  async function pause(ms) {
    if (now() + ms >= deadline) throw new Error('Workflow deadline exceeded (including rate-limit backoff)');
    if (ms > 0) await sleep(ms);
  }
  async function request(path, method = 'GET', body) {
    for (let attempt = 0; attempt < 4; attempt++) {
      await pause(Math.max(0, nextRequestAt - now()));
      const remainingTime = deadline - now();
      if (remainingTime <= 0) throw new Error('Workflow deadline exceeded');
      const response = await fetch(`${config.apiUrl.replace(/\/$/, '')}/${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${config.token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'Content-Type': 'application/json',
          ...(method === 'GET' && cache.get(path)?.etag ? { 'If-None-Match': cache.get(path).etag } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(Math.min(30000, remainingTime)),
        redirect: 'error',
      });
      const remaining = response.headers.get('x-ratelimit-remaining');
      const reset = Number(response.headers.get('x-ratelimit-reset'));
      const resetDelay = reset > 0 ? Math.max(1000, reset * 1000 - now() + 1000) : 60000;
      if (remaining === '0') nextRequestAt = now() + resetDelay;
      if (config.debug) log(`GitHub ${response.status}: quota=${response.headers.get('x-ratelimit-limit')}, remaining=${remaining}, reset=${reset}`);
      if (response.status === 304) return cache.get(path).data;
      const text = await response.text();
      const isLimited = [403, 429].includes(response.status) && (
        response.status === 429 || remaining === '0' ||
        response.headers.has('retry-after') || /rate limit|secondary rate|abuse detection/i.test(text)
      );
      if (isLimited && attempt < 3) {
        const retryAfter = response.headers.get('retry-after');
        const retrySeconds = Number(retryAfter);
        const retryDelay = retryAfter === null ? 0 : (
          Number.isFinite(retrySeconds) ? retrySeconds * 1000 : Date.parse(retryAfter) - now()
        );
        const delay = Math.max(
          remaining === '0' ? resetDelay : 60000 * (2 ** attempt),
          Number.isFinite(retryDelay) ? retryDelay : 0,
        );
        log(`GitHub HTTP ${response.status} rate limit; backing off ${Math.ceil(delay / 1000)} seconds`);
        await pause(delay);
        continue;
      }
      if (!response.ok) {
        // Do not replay an ambiguous POST after transport errors or server failures.
        throw new Error(`GitHub ${method} ${path}: HTTP ${response.status}; check token permissions, installation scope and rate-limit headers`);
      }
      const data = text ? JSON.parse(text) : null;
      if (method === 'GET') cache.set(path, { etag: response.headers.get('etag'), data });
      return data;
    }
  }
  return { request, pause, now, log };
}

async function runWorkflow(config, deps = {}) {
  if (!config.token) throw new Error('An explicit access token is required');
  const client = createClient(config, deps);
  const repo = config.repo.split('/').map(encodeURIComponent).join('/');
  const workflow = `repos/${repo}/actions/workflows/${encodeURIComponent(config.workflow)}`;
  const started = new Date(Math.floor(client.now() / 1000) * 1000).toISOString().replace('.000Z', 'Z');
  await client.request(`${workflow}/dispatches`, 'POST', { ref: config.ref, inputs: config.inputs });
  client.log('Workflow dispatched');
  if (config.goal === 'start') return {};

  let matched;
  while (!matched) {
    await client.pause(config.interval);
    const candidates = [];
    for (let page = 1; ; page++) {
      const query = new URLSearchParams({
        event: 'workflow_dispatch', created: `>=${started}`, per_page: '100', page: String(page),
      });
      const data = await client.request(`${workflow}/runs?${query}`);
      if (!Array.isArray(data?.workflow_runs)) throw new Error('Invalid workflow run list response');
      candidates.push(...data.workflow_runs.filter((run) =>
        run.created_at >= started &&
        (run.head_branch === config.ref || run.head_sha === config.ref) &&
        (run.display_title || run.name || '').includes(config.nameFilter)
      ));
      if (data.workflow_runs.length < 100) break;
      if (page === 10) throw new Error('Run discovery exceeded 1000 runs; use a unique wait_name_filter');
    }
    if (candidates.length > 1) throw new Error('Ambiguous dispatched run; use a unique wait_name_filter');
    matched = candidates[0];
  }
  client.log(`Matched workflow: ${matched.html_url}`);
  while (matched.status !== 'completed') {
    await client.pause(config.interval);
    matched = await client.request(`repos/${repo}/actions/runs/${matched.id}`);
  }
  if (config.goal === 'success' && matched.conclusion !== 'success') {
    throw new Error(`Child workflow concluded ${matched.conclusion}: ${matched.html_url}`);
  }
  return { run_id: matched.id, run_url: matched.html_url };
}

if (require.main === module) {
  (async () => {
    const config = configFromEnv(process.env);
    if (process.argv.includes('--validate')) {
      validateCredentials(process.env);
      const [owner, repository] = config.repo.split('/');
      fs.appendFileSync(process.env.GITHUB_OUTPUT, `owner=${owner}\nrepository=${repository}\n`);
    } else {
      const outputs = await runWorkflow(config);
      for (const [name, value] of Object.entries(outputs)) {
        fs.appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
      }
    }
  })().catch((error) => {
    console.error(`::error::${error.message.replace(/[\r\n]/g, ' ')}`);
    process.exitCode = 1;
  });
}

module.exports = { configFromEnv, validateCredentials, createClient, runWorkflow };
