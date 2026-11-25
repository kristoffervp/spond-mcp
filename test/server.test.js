import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function startServer(env = {}) {
  const child = spawn(process.execPath, ['src/server.js'], { cwd: new URL('..', import.meta.url).pathname,
    env: { ...process.env, SPOND_ALLOW_SEND: '', SPOND_ALLOW_SEND_NO_DIALOG: '', ...env } });
  const lines = createInterface({ input: child.stdout });
  const replies = [];
  const waiters = [];
  lines.on('line', (line) => {
    replies.push(JSON.parse(line));
    waiters.splice(0).forEach((wake) => wake());
  });
  const waitFor = async (count) => {
    while (replies.length < count) await new Promise((resolve) => waiters.push(resolve));
    return replies;
  };
  return { child, waitFor, write: (value) => child.stdin.write(`${typeof value === 'string' ? value : JSON.stringify(value)}\n`) };
}

test('MCP server negotiates a protocol version and lists tools', async () => {
  const { child, waitFor, write } = startServer();
  try {
    write({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } });
    write({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } });
    write({ jsonrpc: '2.0', method: 'notifications/initialized' });
    write({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
    const replies = await waitFor(3);
    assert.equal(replies[0].result.protocolVersion, '2024-11-05');
    assert.equal(replies[0].result.serverInfo.name, 'spond-local-mcp');
    assert.equal(replies[1].result.protocolVersion, '2025-11-25');
    assert.deepEqual(replies[2].result.tools.map((tool) => tool.name),
      ['list_family', 'list_groups', 'list_events', 'get_event', 'list_posts', 'list_chats', 'get_chat', 'list_polls']);
    assert.ok(replies[2].result.tools.every((tool) => tool.annotations.readOnlyHint && !tool.run &&
      tool.inputSchema.additionalProperties === false));
  } finally { child.kill(); }
});

test('answering and voting tools exist only with SPOND_ALLOW_SEND=1, and the writing ones are destructive', async () => {
  const { child, waitFor, write } = startServer({ SPOND_ALLOW_SEND: '1' });
  try {
    write({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const [{ result }] = await waitFor(1);
    const byName = Object.fromEntries(result.tools.map((tool) => [tool.name, tool]));
    for (const name of ['prepare_event_response', 'prepare_poll_vote', 'prepare_task_response', 'prepare_comment', 'prepare_chat_message',
      'send_prepared', 'mark_chat_read', 'mark_posts_read']) assert.ok(byName[name], name);
    for (const name of ['prepare_event_response', 'prepare_task_response', 'prepare_comment', 'prepare_chat_message']) assert.equal(byName[name].annotations.readOnlyHint, true);
    assert.equal(byName.prepare_chat_message.inputSchema.properties.text.maxLength, 2000);
    assert.deepEqual(result.tools.filter((tool) => tool.annotations.destructiveHint).map((tool) => tool.name), ['send_prepared', 'mark_chat_read', 'mark_posts_read']);
    assert.deepEqual(byName.send_prepared.inputSchema.required, ['confirmation_code', 'summary']);
  } finally { child.kill(); }
});

test('a client without elicitation is told at once that chat messages and comments need the dialog', async () => {
  const { child, waitFor, write } = startServer({ SPOND_ALLOW_SEND: '1' });
  try {
    write({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {} } });
    write({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'prepare_chat_message', arguments: { chat_id: 'chat-1', text: 'Hi' } } });
    write({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'prepare_comment', arguments: { event_id: 'A'.repeat(32), text: 'Hi' } } });
    const replies = await waitFor(3);
    for (const id of [2, 3]) {
      const reply = replies.find((item) => item.id === id);
      assert.equal(reply.result.isError, true);
      assert.match(reply.result.content[0].text, /SPOND_ALLOW_SEND_NO_DIALOG=1/);
    }
  } finally { child.kill(); }
});

test('MCP server rejects oversized, malformed, and unknown requests', async () => {
  const { child, waitFor, write } = startServer();
  try {
    write('x'.repeat(70_000));
    write('{not json');
    write({ jsonrpc: '2.0', id: 3, method: 'ping' });
    write({ jsonrpc: '2.0', id: 4, method: 'resources/list' });
    write({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'send_message', arguments: {} } });
    const replies = await waitFor(5);
    assert.equal(replies[0].error.message, 'Request too large');
    assert.equal(replies[1].error.code, -32700);
    assert.deepEqual(replies[2].result, {});
    assert.equal(replies[3].error.code, -32601);
    assert.equal(replies[4].error.code, -32602);
  } finally { child.kill(); }
});

test('with elicitation, the parent and not the AI confirms mark_chat_read in the client dialog', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spond-mcp-server-'));
  await writeFile(join(dir, 'session.json'), JSON.stringify({ accessToken: 'access', refreshToken: 'refresh', accessExpiresAt: Date.now() + 3_600_000 }), { mode: 0o600 });
  const network = `
globalThis.fetch = async (url, options = {}) => {
  const { hostname, pathname } = new URL(url);
  const json = (value) => new Response(JSON.stringify(value));
  if (pathname === '/core/v1/profile') return json({ id: 'P', firstName: 'Pat', timezone: 'Europe/Oslo' });
  if (pathname === '/core/v1/groups/') return json([]);
  if (pathname === '/core/v1/chat') return json({ url: 'https://chat.spond.com/', auth: 'chat' });
  if (hostname === 'chat.spond.com' && pathname === '/chats/chat-1/messages') return json([{ msgNum: 3, text: 'Hi' }]);
  if (options.method === 'PUT' && pathname === '/chats/chat-1/3/read') { process.stderr.write('MARKED\\n'); return new Response(''); }
  return new Response('not stubbed', { status: 500 });
};`;
  const child = spawn(process.execPath, [`--import=data:text/javascript,${encodeURIComponent(network)}`, 'src/server.js'], {
    cwd: new URL('..', import.meta.url).pathname, env: { ...process.env, SPOND_DATA_DIR: dir, SPOND_ALLOW_SEND: '1' } });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const lines = [];
  let wake = () => {};
  createInterface({ input: child.stdout }).on('line', (line) => { lines.push(JSON.parse(line)); wake(); });
  const next = async (match) => { for (;;) { const found = lines.find(match); if (found) return found; await new Promise((r) => { wake = r; }); } };
  const write = (message) => child.stdin.write(JSON.stringify(message) + '\n');
  try {
    write({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: { elicitation: {} } } });
    await next((m) => m.id === 1);
    // With elicitation, a chat message gets past the dialog check to Spond (whose chat is not stubbed here).
    write({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'prepare_chat_message', arguments: { chat_id: 'chat-1', text: 'Hi' } } });
    assert.doesNotMatch((await next((m) => m.id === 9)).result.content[0].text, /SPOND_ALLOW_SEND_NO_DIALOG/);
    write({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'mark_chat_read', arguments: { chat_id: 'chat-1' } } });
    const ask = await next((m) => m.method === 'elicitation/create');
    assert.match(ask.params.message, /^Spond: mark_chat_read\nchatId: chat-1\nupToMessage: 3/);
    assert.equal(stderr.includes('MARKED'), false, 'nothing happens before the parent answers');
    write({ jsonrpc: '2.0', id: ask.id, result: { action: 'decline' } });
    assert.match((await next((m) => m.id === 2)).result.content[0].text, /not confirmed/);
    write({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'mark_chat_read', arguments: { chat_id: 'chat-1' } } });
    const cancelled = await next((m) => m.method === 'elicitation/create' && m.id !== ask.id);
    write({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 4 } });
    assert.match((await next((m) => m.id === 4)).result.content[0].text, /not confirmed/);
    write({ jsonrpc: '2.0', id: cancelled.id, result: { action: 'accept', content: { confirm: true } } });
    write({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'mark_chat_read', arguments: { chat_id: 'chat-1' } } });
    const again = await next((m) => m.method === 'elicitation/create' && m.id !== ask.id && m.id !== cancelled.id);
    assert.equal(stderr.includes('MARKED'), false, 'an answer after the client cancelled does nothing');
    write({ jsonrpc: '2.0', id: again.id, result: { action: 'accept', content: { confirm: true } } });
    assert.equal((await next((m) => m.id === 3)).result.structuredContent.data.readUpTo, 3);
    assert.equal(stderr.includes('MARKED'), true);
  } finally {
    child.kill();
    await rm(dir, { recursive: true, force: true });
  }
});
