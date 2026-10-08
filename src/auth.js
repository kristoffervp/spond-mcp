import { randomUUID } from 'node:crypto';
import { readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { PublicError } from './errors.js';
import { apiBase, ensurePrivateDataDir, savePrivateJson, sessionPath } from './paths.js';

const maxTokenResponseBytes = 100_000;
const renewMarginMs = 60_000;
const staleLockMs = 60_000;
const lockAttempts = 400;

let refreshing;

export function tokenExpiry(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    return Number.isFinite(payload.exp) ? payload.exp * 1000 : null;
  } catch { return null; }
}

function safeErrorKey(result) {
  const key = result?.errorKey ?? result?.error;
  return typeof key === 'string' && /^[A-Za-z_]{1,64}$/.test(key) ? key : undefined;
}

async function postJson(path, body) {
  let response;
  try {
    response = await fetch(`${apiBase}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
      redirect: 'manual',
      signal: AbortSignal.timeout(30_000),
    });
  } catch { throw new PublicError('Could not reach Spond. Check the network and retry.'); }
  if (Number(response.headers.get('content-length')) > maxTokenResponseBytes) {
    throw new PublicError('Spond sent an unexpectedly large sign-in response.');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body || []) {
    size += chunk.byteLength;
    if (size > maxTokenResponseBytes) throw new PublicError('Spond sent an unexpectedly large sign-in response.');
    chunks.push(chunk);
  }
  let result;
  try { result = JSON.parse(Buffer.concat(chunks, size).toString('utf8')); } catch {}
  return { status: response.status, ok: response.ok, result };
}

function sessionFromResponse(result, previous) {
  const accessToken = result?.accessToken?.token;
  if (typeof accessToken !== 'string' || !accessToken) return null;
  const refreshToken = typeof result.refreshToken?.token === 'string' && result.refreshToken.token
    ? result.refreshToken.token : previous?.refreshToken;
  if (!refreshToken) throw new PublicError('Spond did not return a renewable sign-in.');
  return {
    accessToken,
    accessExpiresAt: Date.parse(result.accessToken.expiration) || tokenExpiry(accessToken) ||
      Date.now() + 10 * 60_000,
    refreshToken,
    refreshExpiresAt: Date.parse(result.refreshToken?.expiration) || previous?.refreshExpiresAt || null,
    savedAt: Date.now(),
  };
}

export async function login({ identifier, password }) {
  if (typeof identifier !== 'string' || !identifier.trim() || typeof password !== 'string' || !password) {
    throw new PublicError('Enter both the Spond sign-in and the password.');
  }
  const user = identifier.trim();
  const { status, ok, result } = await postJson('/auth2/login', {
    ...(user.includes('@') ? { email: user } : { phoneNumber: user }), password,
  });
  const session = ok ? sessionFromResponse(result) : null;
  if (!session) {
    if (ok && typeof result?.token === 'string' && result?.phoneNumber) {
      throw new PublicError('This Spond account requires two-factor verification, which is not supported yet. Ignore the SMS code.');
    }
    const key = safeErrorKey(result);
    throw new PublicError(`Spond sign-in failed (HTTP ${status}${key ? `, ${key}` : ''}).`);
  }
  await savePrivateJson(sessionPath, session);
  return session;
}

export async function readSession() {
  let session;
  try { session = JSON.parse(await readFile(sessionPath, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') throw new PublicError('No Spond sign-in found. Run npm run login first.');
    throw new PublicError('The saved Spond sign-in is unreadable. Run npm run login again.');
  }
  if (typeof session?.accessToken !== 'string' || typeof session.refreshToken !== 'string' ||
      !Number.isFinite(session.accessExpiresAt)) {
    throw new PublicError('The saved Spond sign-in is incomplete. Run npm run login again.');
  }
  return session;
}

async function withSessionLock(action) {
  await ensurePrivateDataDir();
  const lockPath = `${sessionPath}.lock`;
  const owner = randomUUID();
  for (let attempt = 0; ; attempt++) {
    try {
      await writeFile(lockPath, owner, { flag: 'wx', mode: 0o600 });
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (attempt >= lockAttempts) throw new PublicError('The Spond sign-in is busy. Retry shortly.');
      try {
        if (Date.now() - (await stat(lockPath)).mtimeMs > staleLockMs) await unlink(lockPath);
      } catch (checkError) {
        if (checkError.code !== 'ENOENT') throw checkError;
      }
      await delay(100);
    }
  }
  try { return await action(); }
  finally {
    try { if (await readFile(lockPath, 'utf8') === owner) await unlink(lockPath); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

async function refreshSession(previous) {
  return withSessionLock(async () => {
    const saved = await readSession();
    // Another process may already have rotated the refresh token while this one waited.
    if (saved.refreshToken !== previous.refreshToken && saved.accessExpiresAt > Date.now() + renewMarginMs) return saved;
    const { status, ok, result } = await postJson('/auth2/login/refresh', { value: saved.refreshToken });
    if (status === 400 || status === 401 || status === 403) {
      throw new PublicError('The Spond sign-in has expired. Run npm run login again.');
    }
    if (!ok) throw new PublicError(`Spond could not renew the sign-in (HTTP ${status}).`);
    const current = sessionFromResponse(result, saved);
    if (!current) throw new PublicError('Spond did not return a new access token. Run npm run login again.');
    await savePrivateJson(sessionPath, current);
    return current;
  });
}

export async function refreshSessionNow(savedSession) {
  const saved = savedSession || await readSession();
  if (!refreshing) refreshing = refreshSession(saved).finally(() => { refreshing = undefined; });
  return refreshing;
}

export async function currentSession() {
  const saved = await readSession();
  if (saved.accessExpiresAt > Date.now() + renewMarginMs) return saved;
  return refreshSessionNow(saved);
}
