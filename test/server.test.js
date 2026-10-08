import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

function startServer() {
  const child = spawn(process.execPath, ['src/server.js'], { cwd: new URL('..', import.meta.url).pathname });
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
      ['list_family', 'list_groups', 'list_events', 'get_event', 'list_posts']);
    assert.ok(replies[2].result.tools.every((tool) => tool.annotations.readOnlyHint && !tool.run &&
      tool.inputSchema.additionalProperties === false));
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
