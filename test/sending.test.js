import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Sender } from '../src/sending.js';
import { Spond, clean } from '../src/spond.js';

const TOKEN = 'SECRET-SESSION-TOKEN';
const id = (name) => Buffer.from(name).toString('hex').toUpperCase().padEnd(32, '0').slice(0, 32);
const ME = id('me'), G1 = id('g1'), KID = id('kid'), SELF = id('self'), OTHER = id('other'), EVENT = id('event'), POST = id('post');
const CHAT_HOST = 'https://chat.spond.com';
const profile = { id: ME, firstName: 'Pat', lastName: 'Parent', timezone: 'Europe/Oslo' };
const groups = [{ id: G1, name: 'Team', members: [
  { id: KID, firstName: 'Kim', lastName: 'Parent', guardians: [{ profile: { id: ME } }] },
  { id: SELF, firstName: 'Pat', lastName: 'Parent', profile: { id: ME } },
  { id: OTHER, firstName: 'Olga', lastName: 'Other' },
], behalfOfMemberships: [{ id: KID, firstName: 'Kim', lastName: 'Parent' }] }];
const soon = (days) => new Date(Date.now() + days * 86_400_000).toISOString();
const responses = (lists = {}) => ({ acceptedIds: [OTHER], declinedIds: [], unansweredIds: [KID], waitinglistIds: [], unconfirmedIds: [], ...lists });
const event = (over = {}) => ({ id: EVENT, heading: 'Training', startTimestamp: soon(7), endTimestamp: soon(7.05), rsvpDate: soon(5),
  recipients: { group: { id: G1 } }, behalfOfIds: [KID], responses: responses(), ...over });
const poll = (over = {}) => ({ id: POST, type: 'POLL', groupId: G1, title: 'Driving', ownerId: ME, timestamp: soon(-1), poll: {
  question: 'Who can drive?', type: 'TEXT', multipleChoice: false, dueBy: soon(3), behalfOfIds: [KID],
  options: [{ id: 'opt-a', text: 'Saturday', votes: [OTHER] }, { id: 'opt-b', text: 'Sunday', votes: [] }], blankVotes: [], ...over } });

function setup(routes, { now = Date.now, confirm } = {}) {
  const calls = [];
  const fetcher = async (url, options) => {
    calls.push({ url, method: options.method, body: options.body === undefined ? undefined : JSON.parse(options.body), auth: options.headers.Authorization });
    const key = `${options.method} ${url.pathname}`;
    const route = key in routes ? routes[key] : routes[url.pathname];
    if (route === undefined) return new Response('', { status: 404 });
    const value = typeof route === 'function' ? route(url, options) : route;
    return value instanceof Response ? value : new Response(value === null ? '' : JSON.stringify(value));
  };
  const spond = new Spond({ fetcher, sessionProvider: async () => ({ accessToken: TOKEN }), refresh: async () => ({ accessToken: TOKEN }) });
  return { spond, calls, sender: (log) => new Sender({ spond, log, now, ...(confirm ? { confirm } : {}) }) };
}
const base = { '/core/v1/profile': profile, '/core/v1/groups/': groups };
const logs = [];
const scratchLog = () => logs[logs.push(join(tmpdir(), `spond-test-${process.pid}-${logs.length}.jsonl`)) - 1];
test.after(() => Promise.all(logs.map((path) => rm(path, { force: true }))));
const writes = (calls) => calls.filter((call) => call.method !== 'GET');

test('an event answer is sent once, only with the confirmation code, and logged without tokens', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spond-send-'));
  try {
    let current = event();
    const { calls, sender } = setup({ ...base, [`GET /core/v1/sponds/${EVENT}`]: () => current,
      [`PUT /core/v1/sponds/${EVENT}/responses/${KID}`]: () => {
        current = event({ responses: responses({ unansweredIds: [], declinedIds: [KID] }) });
        return current.responses;
      } });
    const log = join(dir, 'sent.jsonl');
    const s = sender(log);
    const prepared = await s.prepareEventResponse({ event_id: EVENT, accepted: false, reason: ' Sick​  today ' });
    assert.equal(writes(calls).length, 0);
    assert.equal(prepared.member, 'Kim Parent');
    assert.equal(prepared.answer, 'no');
    assert.equal(prepared.reason, 'Sick today');
    assert.match(prepared.confirmationCode, /^[0-9a-f]{8}$/);
    assert.equal(prepared.summary, `event_response · Kim Parent · Team · Training · ${prepared.start} · no · «Sick today»`);
    const sent = await s.sendPrepared({ confirmation_code: prepared.confirmationCode, summary: prepared.summary });
    assert.deepEqual([sent.verified, sent.answerNow], [true, 'declined']);
    assert.deepEqual(writes(calls).map((call) => [call.method, call.url.pathname, call.body]),
      [['PUT', `/core/v1/sponds/${EVENT}/responses/${KID}`, { accepted: false, declineMessage: 'Sick today' }]]);
    await assert.rejects(s.sendPrepared({ confirmation_code: prepared.confirmationCode, summary: prepared.summary }), /Unknown or expired/);
    assert.equal(writes(calls).length, 1);
    assert.equal((await stat(log)).mode & 0o777, 0o600);
    const logged = await readFile(log, 'utf8');
    assert.match(logged, /"action":"event_response"/);
    assert.equal(logged.includes(TOKEN), false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a confirmation code expires after ten minutes', async () => {
  let now = Date.now();
  const { calls, sender } = setup({ ...base, [`GET /core/v1/sponds/${EVENT}`]: event() }, { now: () => now });
  const s = sender(join(tmpdir(), `spond-unused-${process.pid}.jsonl`));
  const { confirmationCode, summary } = await s.prepareEventResponse({ event_id: EVENT, accepted: true });
  now += 10 * 60_000 + 1;
  await assert.rejects(s.sendPrepared({ confirmation_code: confirmationCode, summary }), /expired/);
  assert.equal(writes(calls).length, 0);
});

test('answers Spond would refuse, or that are not the family\'s, are refused before anything is sent', async () => {
  const refused = async (over, args, pattern) => {
    const { calls, sender } = setup({ ...base, [`GET /core/v1/sponds/${EVENT}`]: event(over) });
    await assert.rejects(sender(scratchLog()).prepareEventResponse({ event_id: EVENT, ...args }), pattern);
    assert.equal(writes(calls).length, 0);
  };
  await refused({ behalfOfIds: [OTHER] }, { accepted: true }, /No one in your family/);
  await refused({ cancelled: true }, { accepted: true }, /cancelled/);
  await refused({ payment: { total: 100 } }, { accepted: true }, /payment/);
  await refused({ registered: true }, { accepted: false }, /attendance/);
  await refused({ endTimestamp: soon(-1), startTimestamp: soon(-1.1) }, { accepted: true }, /over/);
  await refused({ rsvpDate: soon(-1) }, { accepted: true }, /deadline/);
  await refused({ rsvpDate: soon(-1), responses: responses({ unansweredIds: [], acceptedIds: [KID] }) }, { accepted: false }, /cannot change/);
  await refused({ responses: responses({ unansweredIds: [], acceptedIds: [KID] }) }, { accepted: true }, /already answered yes/);
  await refused({}, { accepted: true, reason: 'x' }, /only used when declining/);
  await refused({}, { accepted: false, reason: 'x'.repeat(101) }, /at most 100/);
  await refused({ behalfOfIds: [KID, SELF] }, { accepted: true }, /Name the family member/);
  await refused({ behalfOfIds: [KID, SELF] }, { accepted: true, member: 'Olga' }, /No single family member/);
});

test('an offered spot can be accepted after the deadline, and waiting-list effects are shown', async () => {
  const { sender } = setup({ ...base, [`GET /core/v1/sponds/${EVENT}`]: event({ rsvpDate: soon(-1), responses: responses({ unansweredIds: [], unconfirmedIds: [KID] }) }) });
  assert.equal((await sender(scratchLog()).prepareEventResponse({ event_id: EVENT, accepted: true })).previousAnswer, 'unconfirmed');
  const full = setup({ ...base, [`GET /core/v1/sponds/${EVENT}`]: event({ maxAccepted: 1 }) });
  assert.match((await full.sender(scratchLog()).prepareEventResponse({ event_id: EVENT, accepted: true })).warnings[0], /waiting list/);
  const spot = setup({ ...base, [`GET /core/v1/sponds/${EVENT}`]: event({ responses: responses({ unansweredIds: [], acceptedIds: [KID], waitinglistIds: [OTHER] }) }) });
  assert.match((await spot.sender(scratchLog()).prepareEventResponse({ event_id: EVENT, accepted: false })).warnings[0], /gives up the spot/);
  const self = setup({ ...base, [`GET /core/v1/sponds/${EVENT}`]: event({ behalfOfIds: [KID, SELF] }) });
  assert.equal((await self.sender(scratchLog()).prepareEventResponse({ event_id: EVENT, accepted: true, member: 'pat' })).member, 'Pat Parent');
});

test('polls list the family\'s votes without naming others, and a vote is prepared and sent once', async () => {
  let current = poll();
  const { spond, calls, sender } = setup({ ...base, '/core/v1/posts/': [current], [`GET /core/v1/posts/${POST}`]: () => current,
    [`PUT /core/v1/posts/${POST}/poll/vote/opt-b/${KID}`]: () => { current = poll({ options: [{ id: 'opt-a', text: 'Saturday', votes: [OTHER] }, { id: 'opt-b', text: 'Sunday', votes: [KID] }] }); return null; } });
  const [item] = (await spond.listPolls()).items;
  assert.deepEqual(item.poll.options, [{ id: 'opt-a', text: 'Saturday', votes: 1 }, { id: 'opt-b', text: 'Sunday', votes: 0 }]);
  assert.deepEqual(item.poll.family, [{ name: 'Kim Parent', votedFor: [] }]);
  assert.equal(JSON.stringify(item).includes('Olga'), false);
  assert.equal(calls[calls.length - 1].url.searchParams.get('type'), 'POLL');
  const s = sender(scratchLog());
  const prepared = await s.preparePollVote({ post_id: POST, option_id: 'opt-b' });
  assert.deepEqual([prepared.option, prepared.position, prepared.allOptions, prepared.group], ['Sunday', '2 of 2', ['Saturday', 'Sunday'], 'Team']);
  assert.equal(writes(calls).length, 0);
  const sent = await s.sendPrepared({ confirmation_code: prepared.confirmationCode, summary: prepared.summary });
  assert.deepEqual([sent.verified, sent.votedForNow], [true, ['Sunday']]);
  assert.deepEqual(writes(calls).map((call) => call.body), [{ value: true }]);
  await assert.rejects(s.preparePollVote({ post_id: POST, option_id: 'opt-b' }), /already voted/);
  const ended = setup({ ...base, [`GET /core/v1/posts/${POST}`]: poll({ dueBy: soon(-1) }) });
  await assert.rejects(ended.sender(scratchLog()).preparePollVote({ post_id: POST, option_id: 'opt-b' }), /ended/);
  const voted = setup({ ...base, [`GET /core/v1/posts/${POST}`]: poll({ options: [{ id: 'opt-a', text: 'Saturday', votes: [KID] }, { id: 'opt-b', text: 'Sunday', votes: [] }] }) });
  assert.match((await voted.sender(scratchLog()).preparePollVote({ post_id: POST, option_id: 'opt-b' })).warnings[0], /replaces/);
});

test('mark read uses the newest chat message and the posts read list, and is logged', async () => {
  const C1 = 'chat-1';
  const log = scratchLog();
  const { calls, sender } = setup({ ...base, 'POST /core/v1/chat': { url: `${CHAT_HOST}/`, auth: 'chat-token' },
    [`GET /chats/${C1}/messages`]: [{ msgNum: 7, text: 'Hi' }], [`PUT /chats/${C1}/7/read`]: null, 'POST /core/v1/posts/markAsRead': null });
  const s = sender(log);
  assert.deepEqual(await s.markChatRead({ chat_id: C1 }), { chatId: C1, readUpTo: 7 });
  assert.deepEqual(await s.markPostsRead({ post_ids: [POST, POST.toLowerCase()] }), { markedRead: 1 });
  assert.match(await readFile(log, 'utf8'), /"action":"mark_chat_read".*\n.*"action":"mark_posts_read"/);
  assert.deepEqual(writes(calls).filter((call) => call.url.origin !== 'https://api.spond.com' || call.url.pathname !== '/core/v1/chat')
    .map((call) => [call.method, call.url.pathname, call.body]),
  [['PUT', `/chats/${C1}/7/read`, {}], ['POST', '/core/v1/posts/markAsRead', [POST]]]);
  await assert.rejects(s.markPostsRead({ post_ids: Array.from({ length: 21 }, () => POST) }), /1 to 20/);
});

test('send only accepts the request shapes the planners build', async () => {
  const { spond, calls } = setup(base);
  for (const request of [{ method: 'DELETE', path: `/sponds/${EVENT}/responses/${KID}` }, { method: 'PUT', path: '/profile' },
    { method: 'PUT', path: `/sponds/${EVENT}/responses/${KID}/../../../profile` }]) {
    await assert.rejects(spond.send(request), /Invalid Spond request/);
  }
  assert.equal(calls.length, 0);
});

test('hidden characters, line separators and variation-selector runs are cleaned', () => {
  assert.equal(clean('AㅤB⠀C\u{E0100}D͏'), 'ABCD');
  assert.equal(clean('❤️️️'), '❤️');
  assert.equal(clean('a b'), 'a\nb');
});

test('the parent confirms in the dialog: a no sends nothing and uses up the code', async () => {
  const questions = [];
  const { calls, sender } = setup({ ...base, [`GET /core/v1/sponds/${EVENT}`]: event(), 'POST /core/v1/chat': { url: `${CHAT_HOST}/`, auth: 'x' },
    'GET /chats/chat-1/messages': [{ msgNum: 3, text: 'Hi' }] }, { confirm: async (text) => { questions.push(text); return false; } });
  const s = sender(scratchLog());
  const prepared = await s.prepareEventResponse({ event_id: EVENT, accepted: true });
  await assert.rejects(s.sendPrepared({ confirmation_code: prepared.confirmationCode, summary: prepared.summary }), /not confirmed/);
  await assert.rejects(s.sendPrepared({ confirmation_code: prepared.confirmationCode, summary: prepared.summary }), /Unknown or expired/);
  await assert.rejects(s.markChatRead({ chat_id: 'chat-1' }), /not confirmed/);
  await assert.rejects(s.markPostsRead({ post_ids: [POST] }), /not confirmed/);
  assert.equal(writes(calls).filter((call) => call.url.pathname !== '/core/v1/chat').length, 0);
  assert.match(questions[0], /^Spond: event_response\nmember: Kim Parent\ngroup: Team\n/);
});

test('send_prepared needs the summary exactly as prepared', async () => {
  const { calls, sender } = setup({ ...base, [`GET /core/v1/sponds/${EVENT}`]: event(), [`PUT /core/v1/sponds/${EVENT}/responses/${KID}`]: null });
  const s = sender(scratchLog());
  const prepared = await s.prepareEventResponse({ event_id: EVENT, accepted: true });
  await assert.rejects(s.sendPrepared({ confirmation_code: prepared.confirmationCode }), /summary does not match/);
  await assert.rejects(s.sendPrepared({ confirmation_code: prepared.confirmationCode, summary: 'event_response' }), /summary does not match/);
  assert.equal(writes(calls).length, 0);
  await s.sendPrepared({ confirmation_code: prepared.confirmationCode, summary: prepared.summary });
  assert.equal(writes(calls).length, 1);
});

test('an event that changed since the preview is not answered', async () => {
  let current = event({ maxAccepted: 2 });
  const { calls, sender } = setup({ ...base, [`GET /core/v1/sponds/${EVENT}`]: () => current });
  const s = sender(scratchLog());
  const prepared = await s.prepareEventResponse({ event_id: EVENT, accepted: true });
  current = event({ maxAccepted: 1 });  // someone else took the last spot: a yes now means the waiting list
  await assert.rejects(s.sendPrepared({ confirmation_code: prepared.confirmationCode, summary: prepared.summary }), /changed since the preview/);
  assert.equal(writes(calls).length, 0);
});

test('a lost or failed answer after sending says it may have been sent, and is logged', async () => {
  for (const reply of [() => new Response('', { status: 503 }), () => { throw new Error('socket hang up'); }, () => new Response('{bad')]) {
    const log = scratchLog();
    const { sender } = setup({ ...base, [`GET /core/v1/sponds/${EVENT}`]: event(), [`PUT /core/v1/sponds/${EVENT}/responses/${KID}`]: reply });
    const s = sender(log);
    const prepared = await s.prepareEventResponse({ event_id: EVENT, accepted: true });
    await assert.rejects(s.sendPrepared({ confirmation_code: prepared.confirmationCode, summary: prepared.summary }),
      (error) => /may have been sent/.test(error.message) && !/retry/i.test(error.message));
    const logged = await readFile(log, 'utf8');
    assert.match(logged, /"failed":"It may have been sent/);
    assert.equal(logged.includes(prepared.confirmationCode) || logged.includes(TOKEN), false);
  }
});

test('a failed log write still reports the answer as sent', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spond-log-'));
  try {
    const { sender } = setup({ ...base, [`GET /core/v1/sponds/${EVENT}`]: event(), [`PUT /core/v1/sponds/${EVENT}/responses/${KID}`]: null });
    const blocked = join(dir, 'file');
    await writeFile(blocked, '');
    const s = sender(join(blocked, 'sent.jsonl'));
    const prepared = await s.prepareEventResponse({ event_id: EVENT, accepted: true });
    const sent = await s.sendPrepared({ confirmation_code: prepared.confirmationCode, summary: prepared.summary });
    assert.equal(sent.sent, true);
    assert.match(sent.note, /could not be written to the local log/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a poll option without text is refused, and a single-choice vote that did not replace the old one is reported', async () => {
  const blank = setup({ ...base, [`GET /core/v1/posts/${POST}`]: poll({ options: [{ id: 'opt-a', text: ' ', votes: [] }] }) });
  await assert.rejects(blank.sender(scratchLog()).preparePollVote({ post_id: POST, option_id: 'opt-a' }), /no text/);
  const both = poll({ options: [{ id: 'opt-a', text: 'Saturday', votes: [KID] }, { id: 'opt-b', text: 'Sunday', votes: [KID] }] });
  let current = poll({ options: [{ id: 'opt-a', text: 'Saturday', votes: [KID] }, { id: 'opt-b', text: 'Sunday', votes: [] }] });
  const { sender } = setup({ ...base, [`GET /core/v1/posts/${POST}`]: () => current,
    [`PUT /core/v1/posts/${POST}/poll/vote/opt-b/${KID}`]: () => { current = both; return null; } });
  const s = sender(scratchLog());
  const prepared = await s.preparePollVote({ post_id: POST, option_id: 'opt-b' });
  const sent = await s.sendPrepared({ confirmation_code: prepared.confirmationCode, summary: prepared.summary });
  assert.deepEqual([sent.verified, sent.votedForNow], [false, ['Saturday', 'Sunday']]);
  assert.match(sent.note, /does not show it yet/);
});
