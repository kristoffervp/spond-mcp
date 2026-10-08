import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const dir = await mkdtemp(join(tmpdir(), 'spond-mcp-auth-'));
process.env.SPOND_DATA_DIR = dir;
const { currentSession, login, readSession, refreshSessionNow, tokenExpiry } = await import('../src/auth.js');
const { savePrivateJson, sessionPath } = await import('../src/paths.js');
const previousFetch = globalThis.fetch;

function tokens(access, refresh, { accessExpiration = '2099-01-01T00:00:00Z', refreshExpiration = '2099-03-01T00:00:00Z' } = {}) {
  return { accessToken: { token: access, expiration: accessExpiration },
    ...(refresh ? { refreshToken: { token: refresh, expiration: refreshExpiration } } : {}) };
}

function reply(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

test.after(async () => {
  globalThis.fetch = previousFetch;
  await rm(dir, { recursive: true, force: true });
});

test.afterEach(() => { globalThis.fetch = previousFetch; });

test('login posts email or phone and saves only tokens in a private file', async () => {
  const bodies = [];
  globalThis.fetch = async (url, options) => {
    assert.equal(url, 'https://api.spond.com/core/v1/auth2/login');
    assert.equal(options.method, 'POST');
    bodies.push(JSON.parse(options.body));
    return reply(tokens('access-1', 'refresh-1'));
  };
  const session = await login({ identifier: ' parent@example.test ', password: 'SECRET-PASSWORD' });
  await login({ identifier: '+4700000000', password: 'SECRET-PASSWORD' });
  assert.deepEqual(bodies, [
    { email: 'parent@example.test', password: 'SECRET-PASSWORD' },
    { phoneNumber: '+4700000000', password: 'SECRET-PASSWORD' },
  ]);
  assert.equal(session.accessToken, 'access-1');
  assert.equal(session.accessExpiresAt, Date.parse('2099-01-01T00:00:00Z'));
  assert.equal(session.refreshExpiresAt, Date.parse('2099-03-01T00:00:00Z'));
  const file = await readFile(sessionPath, 'utf8');
  assert.equal(file.includes('SECRET-PASSWORD'), false);
  assert.equal(file.includes('parent@example.test'), false);
  assert.equal((await stat(sessionPath)).mode & 0o777, 0o600);
  assert.equal((await stat(dir)).mode & 0o777, 0o700);
});

test('failed and two-factor logins never echo challenge tokens, phone numbers, or response text', async () => {
  await savePrivateJson(sessionPath, { accessToken: 'kept', refreshToken: 'kept', accessExpiresAt: 1 });
  globalThis.fetch = async () => reply({ token: 'PRIVATE-CHALLENGE', phoneNumber: '****12' });
  await assert.rejects(login({ identifier: 'a@example.test', password: 'x' }), (error) => {
    assert.match(error.message, /two-factor/);
    assert.equal(/PRIVATE-CHALLENGE|\*\*\*\*12/.test(error.message), false);
    return true;
  });
  globalThis.fetch = async () => reply({ errorKey: 'invalidCredentials', message: 'PRIVATE-RESPONSE-TEXT' }, 401);
  await assert.rejects(login({ identifier: 'a@example.test', password: 'x' }), (error) => {
    assert.equal(error.message, 'Spond sign-in failed (HTTP 401, invalidCredentials).');
    return true;
  });
  globalThis.fetch = async () => reply({ errorKey: 'PRIVATE RESPONSE TEXT' }, 400);
  await assert.rejects(login({ identifier: 'a@example.test', password: 'x' }), /^Error: Spond sign-in failed \(HTTP 400\)\.$/);
  await assert.rejects(login({ identifier: ' ', password: 'x' }), /Enter both/);
  assert.equal((await readSession()).accessToken, 'kept');
});

test('a fresh access token is used without contacting Spond', async () => {
  await savePrivateJson(sessionPath, { accessToken: 'fresh', refreshToken: 'r', accessExpiresAt: Date.now() + 3_600_000 });
  globalThis.fetch = async () => assert.fail('Unexpected network call');
  assert.equal((await currentSession()).accessToken, 'fresh');
});

test('parallel callers share one refresh and the rotated refresh token is saved', async () => {
  await savePrivateJson(sessionPath, { accessToken: 'old', refreshToken: 'old-refresh', accessExpiresAt: 0,
    refreshExpiresAt: 123 });
  let calls = 0;
  globalThis.fetch = async (url, options) => {
    calls++;
    assert.equal(url, 'https://api.spond.com/core/v1/auth2/login/refresh');
    assert.deepEqual(JSON.parse(options.body), { value: 'old-refresh' });
    return reply(tokens('new', 'new-refresh'));
  };
  const sessions = await Promise.all(Array.from({ length: 8 }, () => currentSession()));
  assert.equal(calls, 1);
  assert.ok(sessions.every((session) => session.accessToken === 'new' && session.refreshToken === 'new-refresh'));
  assert.equal((await readSession()).refreshToken, 'new-refresh');
  assert.equal((await stat(sessionPath)).mode & 0o777, 0o600);

  globalThis.fetch = async () => reply(tokens('newer'));
  const kept = await refreshSessionNow();
  assert.equal(kept.accessToken, 'newer');
  assert.equal(kept.refreshToken, 'new-refresh');
  assert.equal(kept.refreshExpiresAt, Date.parse('2099-03-01T00:00:00Z'));
});

test('a rejected refresh asks for a new login and keeps the saved session', async () => {
  await savePrivateJson(sessionPath, { accessToken: 'old', refreshToken: 'old-refresh', accessExpiresAt: 0 });
  for (const status of [400, 401, 403]) {
    globalThis.fetch = async () => reply({ message: 'PRIVATE-RESPONSE-TEXT' }, status);
    await assert.rejects(currentSession(), /Run npm run login again/);
  }
  globalThis.fetch = async () => reply({}, 503);
  await assert.rejects(currentSession(), /HTTP 503/);
  globalThis.fetch = async () => { throw new Error('PRIVATE-NETWORK-DETAIL'); };
  await assert.rejects(currentSession(), /^Error: Could not reach Spond/);
  assert.equal((await readSession()).refreshToken, 'old-refresh');
});

test('missing or damaged sessions give safe messages', async () => {
  await rm(sessionPath, { force: true });
  await assert.rejects(currentSession(), /Run npm run login first/);
  await writeFile(sessionPath, '{"accessToken":"SENSITIVE-TEST-TOKEN",');
  await assert.rejects(currentSession(), (error) => {
    assert.match(error.message, /unreadable/);
    assert.equal(error.message.includes('SENSITIVE-TEST-TOKEN'), false);
    return true;
  });
  await writeFile(sessionPath, '{"accessToken":"only"}');
  await assert.rejects(currentSession(), /incomplete/);
});

test('a stale lock left by a crashed process is removed', async () => {
  await savePrivateJson(sessionPath, { accessToken: 'old', refreshToken: 'stale-refresh', accessExpiresAt: 0 });
  const lockPath = `${sessionPath}.lock`;
  await writeFile(lockPath, 'crashed');
  const old = new Date(Date.now() - 120_000);
  await utimes(lockPath, old, old);
  globalThis.fetch = async () => reply(tokens('after-stale', 'after-stale-refresh'));
  assert.equal((await currentSession()).accessToken, 'after-stale');
  await assert.rejects(stat(lockPath), { code: 'ENOENT' });
});

test('two processes refreshing at once use the refresh token only once', async () => {
  await savePrivateJson(sessionPath, { accessToken: 'shared', refreshToken: 'shared-refresh', accessExpiresAt: 0 });
  const script = `
    const { refreshSessionNow } = await import(${JSON.stringify(new URL('../src/auth.js', import.meta.url).href)});
    let calls = 0;
    globalThis.fetch = async (_url, options) => {
      if (JSON.parse(options.body).value !== 'shared-refresh') throw new Error('Refresh token reused');
      calls++;
      await new Promise((resolve) => setTimeout(resolve, 200));
      return new Response(JSON.stringify({ accessToken: { token: 'shared-new', expiration: '2099-01-01T00:00:00Z' },
        refreshToken: { token: 'shared-new-refresh', expiration: '2099-03-01T00:00:00Z' } }));
    };
    const session = await refreshSessionNow({ refreshToken: 'shared-refresh' });
    console.log(JSON.stringify({ calls, refreshToken: session.refreshToken }));
  `;
  const run = promisify(execFile);
  const children = await Promise.all(Array.from({ length: 2 }, () =>
    run(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env } })));
  const results = children.map(({ stdout }) => JSON.parse(stdout));
  assert.equal(results.reduce((total, item) => total + item.calls, 0), 1);
  assert.ok(results.every((item) => item.refreshToken === 'shared-new-refresh'));
  assert.equal((await readSession()).refreshToken, 'shared-new-refresh');
});

test('token expiry falls back to the JWT exp claim', () => {
  const payload = Buffer.from(JSON.stringify({ exp: 2_000_000_000 })).toString('base64url');
  assert.equal(tokenExpiry(`header.${payload}.signature`), 2_000_000_000_000);
  assert.equal(tokenExpiry('opaque'), null);
});
