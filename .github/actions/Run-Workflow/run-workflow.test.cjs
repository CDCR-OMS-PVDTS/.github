const test = require('node:test');
const assert = require('node:assert/strict');
const { configFromEnv, validateCredentials, createClient, runWorkflow } = require('./run-workflow.cjs');

const env = {
  INPUT_REPO: 'org/target',
  INPUT_WORKFLOW: 'build.yml',
  INPUT_REF: 'rc.319',
  INPUT_ACCESS_TOKEN: 'explicit-token',
};
const start = Date.parse('2026-11-23T22:50:44.500Z');
const run = {
  id: 123, created_at: '2026-11-23T22:50:44Z', head_branch: 'rc.319',
  display_title: 'Build buildall.91', status: 'completed', conclusion: 'success',
  html_url: 'https://github.com/org/target/actions/runs/123',
};

function harness(responses) {
  let time = start;
  const calls = [];
  const sleeps = [];
  const logs = [];
  return {
    calls, sleeps, logs,
    now: () => time,
    sleep: async (ms) => { sleeps.push(ms); time += ms; },
    log: (message) => logs.push(message),
    fetch: async (url, options) => {
      calls.push({ url, ...options });
      assert.ok(responses.length, 'Unexpected API call');
      const response = responses.shift();
      if (response instanceof Error) throw response;
      const { status = 200, headers = {}, body } = response;
      return new Response(body === undefined ? null : JSON.stringify(body), { status, headers });
    },
  };
}

test('explicit input token is used; goal=start dispatches exactly once without polling', async () => {
  const h = harness([{ status: 204 }]);
  const config = configFromEnv({
    ...env, GH_TOKEN: 'wrong-token',
    INPUT_FIELD1: 'additional_tag="buildall.91"',
    INPUT_FIELD2: 'message=a=b $(not-a-shell-command)',
    INPUT_FIELD6: 'deploy=false',
  });
  assert.deepEqual(await runWorkflow(config, h), {});
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].headers.Authorization, 'Bearer explicit-token');
  assert.deepEqual(JSON.parse(h.calls[0].body), {
    ref: 'rc.319',
    inputs: { additional_tag: 'buildall.91', message: 'a=b $(not-a-shell-command)', deploy: 'false' },
  });
  assert.equal(h.sleeps.length, 0);
});

test('primary exhaustion waits past reset before retrying a rejected dispatch', async () => {
  const reset = Math.floor(start / 1000) + 120;
  const h = harness([
    { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) } },
    { status: 204 },
  ]);
  await runWorkflow(configFromEnv(env), h);
  assert.deepEqual(h.sleeps, [120500]);
  assert.equal(h.calls.length, 2);
});

test('secondary limits honor Retry-After and exponentially back off', async () => {
  const h = harness([
    { status: 429, headers: { 'retry-after': '90' } },
    { status: 403, body: { message: 'secondary rate limit' } },
    { status: 204 },
  ]);
  await runWorkflow(configFromEnv(env), h);
  assert.deepEqual(h.sleeps, [90000, 120000]);
});

test('permission failures, server errors and transport errors never replay dispatch', async () => {
  for (const response of [
    { status: 403, body: { message: 'Resource not accessible by integration' } },
    { status: 401 }, { status: 404 }, { status: 422 }, { status: 500 },
    new Error('connection lost'),
  ]) {
    const h = harness([response]);
    await assert.rejects(runWorkflow(configFromEnv(env), h));
    assert.equal(h.calls.length, 1);
    assert.deepEqual(h.sleeps, []);
  }
});

test('reset beyond deadline fails immediately instead of hammering the API', async () => {
  const h = harness([{ status: 403, headers: {
    'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(start / 1000) + 3600),
  } }]);
  await assert.rejects(runWorkflow(configFromEnv(env), h), /deadline exceeded/);
  assert.equal(h.calls.length, 1);
});

test('rate-limit retries are bounded', async () => {
  const h = harness(Array.from({ length: 4 }, () => ({ status: 429 })));
  await assert.rejects(runWorkflow(configFromEnv(env), h), /HTTP 429/);
  assert.equal(h.calls.length, 4);
  assert.deepEqual(h.sleeps, [60000, 120000, 240000]);
});

test('discovery pages past unrelated runs then polls only the pinned ID with ETags', async () => {
  const unrelated = { ...run, id: 99, display_title: 'different' };
  const h = harness([
    { status: 204 },
    { body: { workflow_runs: Array.from({ length: 100 }, () => unrelated) } },
    { body: { workflow_runs: [{ ...run, status: 'queued' }] } },
    { body: { ...run, status: 'in_progress' }, headers: { etag: '"run-v1"' } },
    { status: 304 },
    { body: run },
  ]);
  const outputs = await runWorkflow(configFromEnv({
    ...env, INPUT_GOAL: 'success', INPUT_WAIT_NAME_FILTER: 'buildall.91',
  }), h);
  assert.deepEqual(outputs, { run_id: 123, run_url: run.html_url });
  assert.match(h.calls[2].url, /page=2/);
  assert.ok(h.calls.slice(3).every((call) => call.url.endsWith('/actions/runs/123')));
  assert.equal(h.calls[4].headers['If-None-Match'], '"run-v1"');
  assert.ok(h.sleeps.every((ms) => ms === 60000));
});

test('failed children fail goal=success, but complete accepts any conclusion', async () => {
  for (const conclusion of ['failure', 'cancelled', 'timed_out', 'skipped']) {
    for (const goal of ['success', 'complete']) {
      const h = harness([{ status: 204 }, { body: { workflow_runs: [{ ...run, conclusion }] } }]);
      const result = runWorkflow(configFromEnv({ ...env, INPUT_GOAL: goal }), h);
      if (goal === 'success') await assert.rejects(result, new RegExp(`concluded ${conclusion}`));
      else assert.equal((await result).run_id, run.id);
    }
  }
});

test('discovery excludes old runs and other refs, and supports a full SHA ref', async () => {
  const sha = 'a'.repeat(40);
  const target = { ...run, head_branch: 'main', head_sha: sha };
  const h = harness([{ status: 204 }, { body: { workflow_runs: [
    { ...target, id: 99, created_at: '2026-11-23T22:50:43Z' },
    { ...target, id: 100, head_sha: 'b'.repeat(40) },
    target,
  ] } }]);
  const outputs = await runWorkflow(configFromEnv({
    ...env, INPUT_REF: sha, INPUT_GOAL: 'success',
  }), h);
  assert.equal(outputs.run_id, run.id);
});

test('missing run times out and ambiguous correlation fails explicitly', async () => {
  const h = harness([{ status: 204 }, { body: { workflow_runs: [] } }]);
  await assert.rejects(runWorkflow(configFromEnv({
    ...env, INPUT_GOAL: 'success', INPUT_TIMEOUT_MINUTES: '2',
  }), h), /deadline exceeded/);
  assert.equal(h.calls.length, 2);
  const ambiguous = harness([{ status: 204 }, { body: { workflow_runs: [run, { ...run, id: 124 }] } }]);
  await assert.rejects(runWorkflow(configFromEnv({ ...env, INPUT_GOAL: 'success' }), ambiguous), /Ambiguous/);
});

test('successful response with exhausted quota defers the next request until reset', async () => {
  const h = harness([
    { body: { ok: true }, headers: {
      'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(start / 1000) + 120),
    } },
    { body: { ok: true } },
  ]);
  const client = createClient(configFromEnv(env), h);
  await client.request('first');
  await client.request('second');
  assert.deepEqual(h.sleeps, [120500]);
});

test('credentials and polling bounds are validated without ambient fallback', () => {
  validateCredentials(env);
  validateCredentials({ INPUT_APP_ID: '123', INPUT_APP_PRIVATE_KEY: 'key' });
  for (const credentials of [{}, { GH_TOKEN: 'ambient' }, { INPUT_APP_ID: '123' },
    { ...env, INPUT_APP_ID: '123', INPUT_APP_PRIVATE_KEY: 'key' }]) {
    assert.throws(() => validateCredentials(credentials));
  }
  for (const invalid of [
    { INPUT_POLL_INTERVAL_SECONDS: '29' }, { INPUT_POLL_INTERVAL_SECONDS: 'NaN' },
    { INPUT_TIMEOUT_MINUTES: '56' }, { INPUT_GOAL: 'invalid' },
    { INPUT_FIELD1: 'bad' }, { INPUT_FIELD1: 'x=1', INPUT_FIELD2: 'x=2' },
  ]) assert.throws(() => configFromEnv({ ...env, ...invalid }));
});
