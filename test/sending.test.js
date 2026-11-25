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

// By default the client can show the confirmation dialog and the parent says yes.
function setup(routes, { now = Date.now, confirm = async () => true, canAsk = () => true } = {}) {
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
  return { spond, calls, sender: (log) => new Sender({ spond, log, now, confirm, canAsk }) };
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
    assert.equal(prepared.summary, `event_response · Kim Parent · no · «Sick today» · Team · Training · ${prepared.start}`);
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

const PEER = id('peer'), PEER2 = id('peer2'), STRANGER = id('stranger');
const chatRoute = { 'POST /core/v1/chat': { url: `${CHAT_HOST}/`, auth: 'CHAT-AUTH-TOKEN' }, 'GET /chats/chat-1/messages': [], 'GET /chats/chat-2/messages': [] };
const chat = (over = {}) => ({ id: 'chat-1', type: 'GROUP', groupId: G1, name: 'Team parents', participants: [ME, PEER, PEER2], ...over });
const coreWrites = (calls) => writes(calls).filter((call) => call.url.pathname !== '/core/v1/chat');

test('a chat message shows the chat, its size and the exact text, and is sent once to that chat', async () => {
  const log = scratchLog();
  let sent = [];
  const questions = [];
  const { calls, sender } = setup({ ...base, ...chatRoute, 'GET /chats/chat-1': chat(),
    'POST /messages': (_url, options) => { sent.push(JSON.parse(options.body)); return { chatId: 'chat-1', msgNum: 9 }; },
    'GET /chats/chat-1/messages': () => sent.map((body, n) => ({ msgNum: 9 + n, user: ME, text: body.text })) },
  { confirm: async (text) => { questions.push(text); return true; } });
  const s = sender(log);
  const prepared = await s.prepareChatMessage({ chat_id: 'chat-1', text: ' See you​ at 18!\n\n\n\nBring water  ' });
  assert.equal(coreWrites(calls).length, 0);
  assert.deepEqual([prepared.chat, prepared.group, prepared.groupChat, prepared.recipients, prepared.text],
    ['Team parents', 'Team', true, 2, 'See you at 18!\n\nBring water']);
  assert.equal(prepared.summary, 'chat_message · to 2 people · «See you at 18! Bring water» · Team parents · Team');
  await assert.rejects(s.sendPrepared({ confirmation_code: prepared.confirmationCode, summary: prepared.summary.replace('2 people', '1 person') }), /summary does not match/);
  assert.equal(sent.length, 0);
  const result = await s.sendPrepared({ confirmation_code: prepared.confirmationCode, summary: prepared.summary });
  assert.deepEqual([result.sent, result.verified], [true, true]);
  assert.deepEqual(sent, [{ chatId: 'chat-1', text: 'See you at 18!\n\nBring water', type: 'TEXT' }]);
  assert.ok(calls.some((call) => call.url.origin === CHAT_HOST && call.url.pathname === '/messages'));
  assert.match(questions[0], /recipients: 2\ntext, exactly as sent \(27 characters\):\n│ See you at 18!\n│ \n│ Bring water$/);
  await assert.rejects(s.sendPrepared({ confirmation_code: prepared.confirmationCode, summary: prepared.summary }), /Unknown or expired/);
  assert.equal(sent.length, 1);
  const logged = await readFile(log, 'utf8');
  assert.match(logged, /"action":"chat_message"/);
  assert.equal(logged.includes(TOKEN) || logged.includes('CHAT-AUTH-TOKEN') || logged.includes(prepared.confirmationCode), false);
  const coachGroups = [{ ...groups[0], members: [...groups[0].members, { id: id('coach-m'), firstName: 'Cora', lastName: 'Coach', profile: { id: PEER } }] }];
  const dm = setup({ ...base, '/core/v1/groups/': coachGroups, ...chatRoute, 'GET /chats/chat-2': chat({ id: 'chat-2', type: 'DM', name: undefined, participants: [ME, PEER] }) });
  const direct = await dm.sender(scratchLog()).prepareChatMessage({ chat_id: 'chat-2', text: 'Hi' });
  assert.deepEqual([direct.chat, direct.recipient, direct.groupChat, direct.recipients], ['Cora Coach', 'Cora Coach', false, 1]);
  // A child in the chat: their guardians can read it too, and the preview says so.
  const kidGroups = [{ ...groups[0], members: [...groups[0].members, { id: id('kid2'), firstName: 'Kai', profile: { id: PEER2 }, guardians: [{ profile: { id: STRANGER } }] }] }];
  const kids = setup({ ...base, '/core/v1/groups/': kidGroups, ...chatRoute, 'GET /chats/chat-1': chat() });
  const kidChat = await kids.sender(scratchLog()).prepareChatMessage({ chat_id: 'chat-1', text: 'Hi' });
  assert.equal(kidChat.summary, 'chat_message · to 2 people · also 1 guardians · «Hi» · Team parents · Team');
  assert.equal(direct.summary, 'chat_message · to 1 person · «Hi» · Cora Coach · Team');
});

test('chat messages go only to chats the parent is in, with someone to read them', async () => {
  const refused = async (over, text, pattern) => {
    const { calls, sender } = setup({ ...base, ...chatRoute, 'GET /chats/chat-1': chat(over) });
    await assert.rejects(sender(scratchLog()).prepareChatMessage({ chat_id: 'chat-1', text }), pattern);
    assert.equal(coreWrites(calls).length, 0);
  };
  await refused({ participants: [KID, PEER] }, 'Hi', /not a participant/);  // a chat followed only as a guardian
  await refused({ formerParticipants: [ME] }, 'Hi', /not a participant/);
  await refused({ type: 'CAMPAIGN' }, 'Hi', /Only group chats/);
  await refused({ groupId: id('gone') }, 'Hi', /no longer have access/);
  await refused({ participants: [ME] }, 'Hi', /No one else/);
  await refused({ id: 'chat-9' }, 'Hi', /unexpected/);
  await refused({}, '​‮ \n', /non-empty/);
  await refused({}, 'x'.repeat(2_001), /at most 2000/);
});

test('a chat that changed after the preview, or that the parent left, gets nothing', async () => {
  for (const later of [chat({ participants: [ME, PEER, PEER2, STRANGER] }), chat({ name: 'Whole club' }), chat({ formerParticipants: [ME] })]) {
    let current = chat();
    const { calls, sender } = setup({ ...base, ...chatRoute, 'GET /chats/chat-1': () => current, 'POST /messages': {} });
    const s = sender(scratchLog());
    const prepared = await s.prepareChatMessage({ chat_id: 'chat-1', text: 'Hi' });
    current = later;
    await assert.rejects(s.sendPrepared({ confirmation_code: prepared.confirmationCode, summary: prepared.summary }), /changed since the preview|not a participant/);
    assert.equal(coreWrites(calls).length, 0);
  }
});

const commented = (over = {}) => event({ comments: [{ id: 'c1', fromProfileId: ME, text: 'Who drives?', children: [{ id: 'c2', fromProfileId: ME, text: 'Me' }] }],
  responses: responses({ acceptedIds: [OTHER, PEER], declinedIds: [PEER2] }), ...over });

test('a comment or reply shows the event, its audience and the parent comment, and is posted once', async () => {
  let current = commented();
  const { calls, sender } = setup({ ...base, [`GET /core/v1/sponds/${EVENT}`]: () => current,
    [`POST /core/v1/sponds/${EVENT}/comments/c1`]: (_url, options) => {
      current = commented({ comments: [{ ...current.comments[0], children: [...current.comments[0].children, { id: 'c3', fromProfileId: ME, text: JSON.parse(options.body).text }] }] });
      return {};
    } });
  const s = sender(scratchLog());
  const prepared = await s.prepareComment({ event_id: EVENT, comment_id: 'c1', text: 'I can drive' });
  assert.deepEqual([prepared.event, prepared.group, prepared.audience, prepared.replyTo, prepared.text],
    ['Training', 'Team', '4 invited', 'Pat Parent: Who drives?', 'I can drive']);
  assert.equal(prepared.summary, `comment · seen by 4 invited · reply · «I can drive» · Team · Training · ${prepared.start}`);
  assert.equal(calls.at(-1).url.searchParams.get('includeComments'), 'true');
  const sent = await s.sendPrepared({ confirmation_code: prepared.confirmationCode, summary: prepared.summary });
  assert.equal(sent.verified, true);
  assert.deepEqual(writes(calls).map((call) => [call.method, call.url.pathname, call.body]),
    [['POST', `/core/v1/sponds/${EVENT}/comments/c1`, { text: 'I can drive' }]]);
});

test('a wall post comment counts the members who can read it', async () => {
  const S1 = id('s1');
  const wide = [{ ...groups[0], members: groups[0].members.map((member, n) => ({ ...member, subGroups: n === 0 ? [S1] : [] })) }];
  const post = { id: POST, groupId: G1, title: 'Kit day', subGroupIds: [S1], comments: [] };
  const { calls, sender } = setup({ ...base, '/core/v1/groups/': wide, [`GET /core/v1/posts/${POST}`]: post });
  const prepared = await sender(scratchLog()).prepareComment({ post_id: POST, text: 'Thanks' });
  assert.deepEqual([prepared.post, prepared.audience], ['Kit day', '1 group members and their guardians']);
  assert.equal(writes(calls).length, 0);
  const all = setup({ ...base, [`GET /core/v1/posts/${POST}`]: { ...post, subGroupIds: [] } });
  assert.equal((await all.sender(scratchLog()).prepareComment({ post_id: POST, text: 'Thanks' })).audience, '3 group members and their guardians');
});

test('comments Spond would refuse, or with no clear target, are refused before anything is sent', async () => {
  const refused = async (over, args, pattern) => {
    const { calls, sender } = setup({ ...base, [`GET /core/v1/sponds/${EVENT}`]: commented(over), [`GET /core/v1/posts/${POST}`]: { id: POST, groupId: G1 } });
    await assert.rejects(sender(scratchLog()).prepareComment({ text: 'Hi', ...args }), pattern);
    assert.equal(writes(calls).length, 0);
  };
  await refused({}, {}, /either event_id or post_id/);
  await refused({}, { event_id: EVENT, post_id: POST }, /either event_id or post_id/);
  await refused({ commentsDisabled: true }, { event_id: EVENT }, /turned off/);
  await refused({ cancelled: true }, { event_id: EVENT }, /cancelled/);
  await refused({}, { event_id: EVENT, comment_id: 'c2' }, /first comment of that thread/);
  await refused({}, { event_id: EVENT, comment_id: 'nope' }, /No comment/);
  await refused({}, { event_id: EVENT, comment_id: '../x' }, /Invalid comment_id/);
  await refused({}, { event_id: EVENT, text: '   ' }, /non-empty/);
});

const GUARD = id('guard'), TASK = 'task-1';
const taskGroups = [{ ...groups[0], members: groups[0].members.map((member) => member.id === KID ? { ...member, guardians: [{ id: GUARD, profile: { id: ME } }] } : member) }];
const withTask = (task = {}, over = {}) => event({ tasks: { openTasks: [{ id: TASK, name: 'Cake', description: 'Bake one cake', limit: 2, remaining: 1, accepted: [OTHER], declined: [], unanswered: [], ...task }],
  assignedTasks: [{ id: 'task-2', name: 'Driving', accepted: [], declined: [], unanswered: [KID] }] }, ...over });
const taskBase = { ...base, '/core/v1/groups/': taskGroups };

test('get_event shows tasks with the family by name and others counted', async () => {
  const { spond } = setup({ ...taskBase, [`GET /core/v1/sponds/${EVENT}`]: withTask({ accepted: [OTHER, GUARD] }) });
  const { tasks } = await spond.getEvent({ event_id: EVENT });
  assert.deepEqual(tasks, [
    { id: TASK, name: 'Cake', type: 'open', taken: 2, description: 'Bake one cake', needed: 2, remaining: 1, family: [{ name: 'Pat Parent', status: 'taken' }] },
    { id: 'task-2', name: 'Driving', type: 'assigned', taken: 0, family: [{ name: 'Kim Parent', status: 'asked' }] }]);
  assert.equal(JSON.stringify(tasks).includes('Olga'), false);
});

test('a task is taken for a child or for the parent, and given up, once', async () => {
  let current = withTask();
  const { calls, sender } = setup({ ...taskBase, [`GET /core/v1/sponds/${EVENT}`]: () => current,
    [`PUT /core/v1/sponds/${EVENT}/tasks/${TASK}/assignments/${KID}`]: () => { current = withTask({ accepted: [OTHER, KID], remaining: 0 }); return {}; },
    [`POST /core/v1/sponds/${EVENT}/tasks/${TASK}/assignments`]: () => { current = withTask({ accepted: [OTHER, GUARD], remaining: 0 }); return {}; },
    [`PUT /core/v1/sponds/${EVENT}/tasks/task-2/assignments/${KID}`]: {} });
  const s = sender(scratchLog());
  await assert.rejects(s.prepareTaskResponse({ event_id: EVENT, task_id: TASK, accepted: true }), /Name the family member to answer for: Kim Parent, Pat Parent/);
  const kid = await s.prepareTaskResponse({ event_id: EVENT, task_id: TASK, accepted: true, member: 'Kim' });
  assert.deepEqual([kid.member, kid.task, kid.answer, kid.taken, kid.previousStatus], ['Kim Parent', 'Cake', 'take', '1 of 2', 'not_taken']);
  assert.equal(kid.summary, `task_response · Kim Parent · Cake · take · Team · Training · ${kid.start}`);
  assert.deepEqual((await s.sendPrepared({ confirmation_code: kid.confirmationCode, summary: kid.summary })).verified, true);
  current = withTask();
  const me = await s.prepareTaskResponse({ event_id: EVENT, task_id: TASK, accepted: true, member: 'Pat Parent' });
  assert.equal((await s.sendPrepared({ confirmation_code: me.confirmationCode, summary: me.summary })).verified, true);
  const decline = await s.prepareTaskResponse({ event_id: EVENT, task_id: 'task-2', accepted: false });
  await s.sendPrepared({ confirmation_code: decline.confirmationCode, summary: decline.summary });
  assert.deepEqual(writes(calls).map((call) => [call.method, call.url.pathname, call.body]), [
    ['PUT', `/core/v1/sponds/${EVENT}/tasks/${TASK}/assignments/${KID}`, { accepted: true }],
    ['POST', `/core/v1/sponds/${EVENT}/tasks/${TASK}/assignments`, {}],
    ['PUT', `/core/v1/sponds/${EVENT}/tasks/task-2/assignments/${KID}`, { accepted: false }]]);
  // Given up by the ID Spond lists the parent with.
  current = withTask({ accepted: [GUARD] });
  const off = await s.prepareTaskResponse({ event_id: EVENT, task_id: TASK, accepted: false, member: 'pat' });
  assert.equal(off.answer, 'give up');
});

test('task answers Spond would refuse are refused, also when the task fills up before sending', async () => {
  const refused = async (task, over, args, pattern) => {
    const { calls, sender } = setup({ ...taskBase, [`GET /core/v1/sponds/${EVENT}`]: withTask(task, over) });
    await assert.rejects(sender(scratchLog()).prepareTaskResponse({ event_id: EVENT, task_id: TASK, accepted: true, member: 'Kim', ...args }), pattern);
    assert.equal(writes(calls).length, 0);
  };
  await refused({ remaining: 0 }, {}, {}, /full/);
  await refused({ accepted: [KID] }, {}, {}, /already taken/);
  await refused({}, {}, { accepted: false }, /has not taken/);
  await refused({ adultsOnly: true }, {}, {}, /Only adults/);
  await refused({}, { cancelled: true }, {}, /cancelled/);
  await refused({}, { startTimestamp: soon(-0.1) }, {}, /started/);
  await refused({}, { rsvpDate: soon(-1) }, {}, /deadline/);
  await refused({}, {}, { task_id: 'nope' }, /No task/);
  await refused({}, {}, { task_id: 'task-2', member: 'Pat' }, /No single family member/);  // not assigned to the parent

  let current = withTask();
  const { calls, sender } = setup({ ...taskBase, [`GET /core/v1/sponds/${EVENT}`]: () => current });
  const s = sender(scratchLog());
  const prepared = await s.prepareTaskResponse({ event_id: EVENT, task_id: TASK, accepted: true, member: 'Kim' });
  current = withTask({ accepted: [OTHER, PEER], remaining: 0 });
  await assert.rejects(s.sendPrepared({ confirmation_code: prepared.confirmationCode, summary: prepared.summary }), /full/);
  assert.equal(writes(calls).length, 0);
});

test('send only takes the exact write shapes of the new tools', async () => {
  const { spond, calls } = setup(base);
  for (const request of [
    { method: 'PUT', path: `/sponds/${EVENT}/comments/c1` }, { method: 'POST', path: `/sponds/${EVENT}/comments/c1/x` },
    { method: 'POST', path: `/sponds/${EVENT}/comments/../../profile` }, { method: 'POST', path: `/sponds/${EVENT}/messages` },
    { method: 'PUT', path: `/sponds/${EVENT}/tasks/${TASK}/assignments/remove` }, { method: 'PUT', path: `/sponds/${EVENT}/tasks/remove` },
    { method: 'DELETE', path: `/sponds/${EVENT}/tasks/${TASK}/assignments/${KID}` }, { method: 'POST', path: '/messages' },
    { host: 'chat', method: 'POST', path: '/messages/bulk' }, { host: 'chat', method: 'POST', path: '/chats/find/x' },
    { host: 'chat', method: 'PUT', path: '/messages' }, { host: 'chat', method: 'POST', path: `/posts/${POST}/comments` },
    { host: 'chat', method: 'POST', path: '/messages', body: { chatId: 'chat-1', text: 'Hi', type: 'TEXT', recipients: [PEER] } },
    { host: 'chat', method: 'POST', path: '/messages', body: { chatId: '../x', text: 'Hi', type: 'TEXT' } },
    { host: 'chat', method: 'POST', path: '/messages', body: { chatId: 'chat-1', text: 'Hi', type: 'IMAGE' } },
  ]) await assert.rejects(spond.send(request), /Invalid Spond request/, JSON.stringify(request));
  assert.equal(calls.length, 0);
});

test('the summary always has who gets it and the whole text, with names last and short', async () => {
  const many = Array.from({ length: 85 }, (_, n) => id(`p${n}`));
  const longGroups = [{ ...groups[0], name: 'G'.repeat(300) }];
  const text = 'w'.repeat(1_990);
  const { sender } = setup({ ...base, '/core/v1/groups/': longGroups, ...chatRoute, 'GET /chats/chat-1': chat({ name: 'N'.repeat(500), participants: [ME, ...many] }) });
  const prepared = await sender(scratchLog()).prepareChatMessage({ chat_id: 'chat-1', text });
  assert.ok(prepared.summary.startsWith(`chat_message · to 85 people · «${text}» · ${'N'.repeat(39)}… · ${'G'.repeat(39)}…`), prepared.summary.slice(0, 80));
});

test('line breaks in names set by others cannot fake lines in the dialog', async () => {
  const questions = [];
  const fake = 'Kim + Pat\ngroupChat: false\nrecipients: 1';
  const { sender } = setup({ ...base, ...chatRoute, 'GET /chats/chat-1': chat({ name: fake }), 'POST /messages': {},
    [`GET /core/v1/sponds/${EVENT}`]: commented({ heading: 'Cup\nrecipients: 1', comments: [{ id: 'c1', fromProfileId: ME, text: 'Line one\nanswer: yes' }] }) },
  { confirm: async (question) => { questions.push(question); return false; } });
  const s = sender(scratchLog());
  const message = await s.prepareChatMessage({ chat_id: 'chat-1', text: 'Hi\nrecipients: 1' });
  assert.equal(message.chat, 'Kim + Pat groupChat: false recipients: 1');
  assert.equal(message.text, 'Hi\nrecipients: 1');
  const comment = await s.prepareComment({ event_id: EVENT, comment_id: 'c1', text: 'Ok' });
  assert.deepEqual([comment.event, comment.replyTo], ['Cup recipients: 1', 'Pat Parent: Line one answer: yes']);
  for (const prepared of [message, comment]) await assert.rejects(s.sendPrepared({ confirmation_code: prepared.confirmationCode, summary: prepared.summary }), /not confirmed/);
  const lines = questions[0].split('\n');
  assert.deepEqual(lines.filter((line) => /^(recipients|groupChat):/.test(line)), ['groupChat: true', 'recipients: 2']);
  assert.deepEqual(lines.slice(-2), ['│ Hi', '│ recipients: 1']);
  assert.equal(questions[1].split('\n').filter((line) => /^(recipients|answer):/.test(line)).length, 0);
});

test('giving up a task Spond lists the parent for by profile ID sends a give-up, not a take', async () => {
  let current = withTask({ accepted: [ME] });
  const { spond, calls, sender } = setup({ ...taskBase, [`GET /core/v1/sponds/${EVENT}`]: () => current,
    [`PUT /core/v1/sponds/${EVENT}/tasks/${TASK}/assignments/${ME}`]: () => { current = withTask({ accepted: [] }); return {}; } });
  assert.deepEqual((await spond.getEvent({ event_id: EVENT })).tasks[0].family, [{ name: 'Pat Parent', status: 'taken' }]);
  const s = sender(scratchLog());
  const prepared = await s.prepareTaskResponse({ event_id: EVENT, task_id: TASK, accepted: false, member: 'Pat' });
  assert.equal((await s.sendPrepared({ confirmation_code: prepared.confirmationCode, summary: prepared.summary })).verified, true);
  assert.deepEqual(writes(calls).map((call) => [call.method, call.url.pathname, call.body]),
    [['PUT', `/core/v1/sponds/${EVENT}/tasks/${TASK}/assignments/${ME}`, { accepted: false }]]);
});

test('a large audience is warned about, and an unknown one is said to be unknown', async () => {
  const many = Array.from({ length: 31 }, (_, n) => id(`p${n}`));
  const big = setup({ ...base, ...chatRoute, 'GET /chats/chat-1': chat({ participants: [ME, ...many] }) });
  assert.deepEqual((await big.sender(scratchLog()).prepareChatMessage({ chat_id: 'chat-1', text: 'Hi' })).warnings, ['31 people get or can read this.']);
  const small = setup({ ...base, ...chatRoute, 'GET /chats/chat-1': chat() });
  assert.equal('warnings' in await small.sender(scratchLog()).prepareChatMessage({ chat_id: 'chat-1', text: 'Hi' }), false);
  const invited = setup({ ...base, [`GET /core/v1/sponds/${EVENT}`]: commented({ responses: responses({ acceptedIds: many }) }) });
  assert.deepEqual((await invited.sender(scratchLog()).prepareComment({ event_id: EVENT, text: 'Hi' })).warnings, ['32 people get or can read this.']);
  const elsewhere = setup({ ...base, [`GET /core/v1/posts/${POST}`]: { id: POST, groupId: id('gone'), title: 'Kit day', comments: [] } });
  assert.equal((await elsewhere.sender(scratchLog()).prepareComment({ post_id: POST, text: 'Hi' })).audience, 'unknown');
});

test('the same request cannot be prepared twice, and an older identical message or comment does not count as sent', async () => {
  const { calls, sender } = setup({ ...base, ...chatRoute, 'GET /chats/chat-1': chat(), 'POST /messages': {},
    'GET /chats/chat-1/messages': [{ msgNum: 4, user: ME, text: 'See you' }],
    [`GET /core/v1/sponds/${EVENT}`]: commented({ comments: [{ id: 'c1', fromProfileId: ME, text: 'See you', children: [] }] }),
    [`POST /core/v1/sponds/${EVENT}/comments`]: {} });
  const s = sender(scratchLog());
  const message = await s.prepareChatMessage({ chat_id: 'chat-1', text: 'See you' });
  await assert.rejects(s.prepareChatMessage({ chat_id: 'chat-1', text: 'See you' }), /already prepared/);
  const sent = await s.sendPrepared({ confirmation_code: message.confirmationCode, summary: message.summary });
  assert.deepEqual([sent.sent, sent.verified], [true, false]);
  assert.match(sent.note, /does not show it yet/);
  const comment = await s.prepareComment({ event_id: EVENT, text: 'See you' });
  assert.equal((await s.sendPrepared({ confirmation_code: comment.confirmationCode, summary: comment.summary })).verified, false);
  assert.equal(coreWrites(calls).length, 2);
});

test('without the confirmation dialog, chat messages and comments are refused unless SPOND_ALLOW_SEND_NO_DIALOG=1', async () => {
  const routes = { ...base, ...chatRoute, 'GET /chats/chat-1': chat(), 'POST /messages': {}, [`GET /core/v1/sponds/${EVENT}`]: commented(),
    [`POST /core/v1/sponds/${EVENT}/comments`]: {}, [`PUT /core/v1/sponds/${EVENT}/responses/${KID}`]: null };
  const previous = process.env.SPOND_ALLOW_SEND_NO_DIALOG;
  try {
    delete process.env.SPOND_ALLOW_SEND_NO_DIALOG;
    // Refused at prepare time, before Spond is asked anything.
    const none = setup(routes, { confirm: async () => null, canAsk: () => false });
    const s = none.sender(scratchLog());
    await assert.rejects(s.prepareChatMessage({ chat_id: 'chat-1', text: 'Hi' }), /can't show the confirmation dialog.*SPOND_ALLOW_SEND_NO_DIALOG=1/);
    await assert.rejects(s.prepareComment({ event_id: EVENT, text: 'Hi' }), /can't show the confirmation dialog/);
    assert.equal(none.calls.length, 0);
    // Other actions are unchanged: the client's tool approval is the check.
    const answer = await s.prepareEventResponse({ event_id: EVENT, accepted: true });
    assert.equal((await s.sendPrepared({ confirmation_code: answer.confirmationCode, summary: answer.summary })).sent, true);

    // Refused at send time too, when the client could ask at prepare time but its answer says it can't (null); nothing is written.
    let ask = true;
    const later = setup(routes, { confirm: async () => null, canAsk: () => ask });
    const l = later.sender(scratchLog());
    const message = await l.prepareChatMessage({ chat_id: 'chat-1', text: 'Hi' });
    ask = false;
    await assert.rejects(l.sendPrepared({ confirmation_code: message.confirmationCode, summary: message.summary }), /can't show the confirmation dialog/);
    assert.equal(coreWrites(later.calls).length, 0);

    // A no in the dialog is still a no.
    const declined = setup(routes, { confirm: async () => false });
    const d = declined.sender(scratchLog());
    const comment = await d.prepareComment({ event_id: EVENT, text: 'Hi' });
    await assert.rejects(d.sendPrepared({ confirmation_code: comment.confirmationCode, summary: comment.summary }), /not confirmed/);
    assert.equal(coreWrites(declined.calls).length, 0);

    // The opt-in restores sending with only the client's tool approval.
    process.env.SPOND_ALLOW_SEND_NO_DIALOG = '1';
    const optIn = setup(routes, { confirm: async () => null, canAsk: () => false });
    const o = optIn.sender(scratchLog());
    for (const prepared of [await o.prepareChatMessage({ chat_id: 'chat-1', text: 'Hi' }), await o.prepareComment({ event_id: EVENT, text: 'Hi' })]) {
      assert.equal((await o.sendPrepared({ confirmation_code: prepared.confirmationCode, summary: prepared.summary })).sent, true);
    }
    assert.deepEqual(coreWrites(optIn.calls).map((call) => call.url.pathname), ['/messages', `/core/v1/sponds/${EVENT}/comments`]);
  } finally {
    if (previous === undefined) delete process.env.SPOND_ALLOW_SEND_NO_DIALOG; else process.env.SPOND_ALLOW_SEND_NO_DIALOG = previous;
  }
});
