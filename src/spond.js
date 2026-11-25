import { currentSession, refreshSessionNow } from './auth.js';
import { PublicError } from './errors.js';
import { apiBase } from './paths.js';

const apiOrigin = new URL(apiBase).origin;
const maxJsonBytes = 2_000_000;
const maxItems = 50;
const maxComments = 50;
const maxTextChars = 20_000;
const maxSpondEvents = 100;
const maxExcerptChars = 200;
const chatIdPattern = /^[0-9A-Za-z_-]{1,64}$/;
const cacheMs = 5 * 60_000;
const dayMs = 86_400_000;
const defaultTimeZone = 'Europe/Oslo';
const responseLists = [
  ['acceptedIds', 'accepted'], ['declinedIds', 'declined'], ['unansweredIds', 'unanswered'],
  ['waitinglistIds', 'waiting_list'], ['unconfirmedIds', 'unconfirmed'],
];

function list(value) {
  return Array.isArray(value) ? value : [];
}

// Format and control characters (direction overrides, zero-width and Unicode tag characters) can hide text
// from the parent while an AI client still reads it. toWellFormed repairs an emoji cut in half by slice.
const invisibleCharacters = /(?![\n\t])[\p{Cf}\p{Cc}]/gu;
const clean = (text) => text.toWellFormed().replace(invisibleCharacters, '');

function str(value, max = 1_024) {
  return typeof value === 'string' && value ? clean(value.slice(0, max)) || undefined : undefined;
}

function longText(target, key, value) {
  if (typeof value !== 'string' || !value) return;
  target[key] = clean(value.slice(0, maxTextChars));
  if (value.length > maxTextChars) target[`${key}Truncated`] = true;
}

// Image links only on request (include_images), and only to Spond's own https hosts.
function imageUrls(value) {
  return list(value).map((image) => str(image?.url, 2_048)).filter((url) => {
    try {
      const { protocol, hostname } = new URL(url);
      return protocol === 'https:' && (hostname === 'spond.com' || hostname.endsWith('.spond.com'));
    } catch { return false; }
  }).slice(0, 10);
}

function includeImages(value) {
  if (typeof value !== 'boolean') throw new PublicError('include_images must be true or false.');
  return value;
}

function fullName(person) {
  return str([person?.firstName, person?.lastName].filter((part) => typeof part === 'string' && part).join(' '));
}

function spondId(value, name) {
  if (typeof value !== 'string' || !/^[0-9A-Fa-f]{32}$/.test(value)) throw new PublicError(`Invalid ${name}.`);
  return value.toUpperCase();
}

function dateValue(value, name) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new PublicError(`${name} must use the format YYYY-MM-DD.`);
  }
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new PublicError(`${name} must be a valid date.`);
  }
  return value;
}

function addDays(date, days) {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * dayMs).toISOString().slice(0, 10);
}

function chatId(value) {
  if (typeof value !== 'string' || !chatIdPattern.test(value)) throw new PublicError('Invalid chat_id.');
  return value;
}

function limitValue(value) {
  if (!Number.isInteger(value) || value < 1 || value > maxItems) throw new PublicError(`limit must be an integer from 1 to ${maxItems}.`);
  return value;
}

// Spond sends UTC timestamps; agents get local wall-clock time with its offset, e.g. 2026-10-09T19:30+02:00.
// The chat host may send epoch milliseconds instead of ISO strings.
// One formatter per time zone: building one per timestamp is slow on a Raspberry Pi.
const formatters = new Map();
function localTime(value, timeZone) {
  const time = typeof value === 'string' ? Date.parse(value) : typeof value === 'number' ? value : NaN;
  if (!Number.isFinite(time)) return undefined;
  if (!formatters.has(timeZone)) formatters.set(timeZone, new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', timeZoneName: 'longOffset',
  }));
  const parts = Object.fromEntries(formatters.get(timeZone).formatToParts(time).map(({ type, value: part }) => [type, part]));
  const offset = parts.timeZoneName === 'GMT' ? '+00:00' : parts.timeZoneName.slice(3);
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}${offset}`;
}

function validTimeZone(value) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return typeof value === 'string' ? value : defaultTimeZone;
  } catch { return defaultTimeZone; }
}

async function limitedJson(response) {
  if (Number(response.headers.get('content-length')) > maxJsonBytes) {
    throw new PublicError('The Spond response is too large. Narrow the request.');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body || []) {
    size += chunk.byteLength;
    if (size > maxJsonBytes) throw new PublicError('The Spond response is too large. Narrow the request.');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks, size).toString('utf8')); }
  catch { throw new PublicError('Spond sent an unexpected response.'); }
}

function comments(value, people, timeZone, nested = false) {
  return list(value).slice(-maxComments).map((comment) => {
    const result = { author: people.get(comment?.fromProfileId) || 'Unknown', time: localTime(comment?.timestamp, timeZone) };
    longText(result, 'text', comment?.text);
    if (!nested && list(comment?.children).length > 0) result.replies = comments(comment.children, people, timeZone, true);
    return result;
  });
}

export class Spond {
  #sessionProvider;
  #refresh;
  #fetcher;
  #cache = new Map();
  #chat;

  constructor({ sessionProvider = currentSession, refresh = refreshSessionNow, fetcher = fetch } = {}) {
    this.#sessionProvider = sessionProvider;
    this.#refresh = refresh;
    this.#fetcher = fetcher;
  }

  async #request(path, query, { method = 'GET' } = {}) {
    let session = await this.#sessionProvider();
    const url = new URL(`${apiBase}${path}`);
    if (url.origin !== apiOrigin || !url.pathname.startsWith('/core/v1/')) throw new PublicError('Invalid Spond address.');
    for (const [key, value] of Object.entries(query || {})) url.searchParams.set(key, value);
    const send = async () => {
      try {
        return await this.#fetcher(url, {
          method, headers: { Authorization: `Bearer ${session.accessToken}`, Accept: 'application/json',
            ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}) },
          ...(method === 'POST' ? { body: '{}' } : {}),
          redirect: 'manual', signal: AbortSignal.timeout(30_000),
        });
      } catch { throw new PublicError('Could not reach Spond. Check the network and retry.'); }
    };
    let response = await send();
    if (response.status === 401) {
      session = await this.#refresh(session);
      response = await send();
    }
    return this.#checked(response);
  }

  // Chat lives on a separate host. POST /chat gives its address and a chat token, kept in memory only.
  #chatSession(renew = false) {
    if (!this.#chat || renew) {
      const pending = (async () => {
        const data = await this.#request('/chat', undefined, { method: 'POST' });
        let base;
        try { base = new URL(data?.url); } catch { throw new PublicError('Spond sent an unexpected chat response.'); }
        if (typeof data?.auth !== 'string' || !data.auth) throw new PublicError('Spond sent an unexpected chat response.');
        if (base.protocol !== 'https:' || !(base.hostname === 'spond.com' || base.hostname.endsWith('.spond.com'))) {
          throw new PublicError(`Spond chat is on an unexpected host (${base.hostname}).`);
        }
        return { url: base.href.replace(/\/+$/, ''), origin: base.origin, auth: data.auth };
      })();
      this.#chat = pending;
      pending.catch(() => { if (this.#chat === pending) this.#chat = undefined; });
    }
    return this.#chat;
  }

  async #chatRequest(path, query) {
    for (let attempt = 0; ; attempt += 1) {
      const chat = await this.#chatSession(attempt > 0);
      const url = new URL(`${chat.url}${path}`);
      if (url.origin !== chat.origin) throw new PublicError('Invalid Spond chat address.');
      for (const [key, value] of Object.entries(query || {})) url.searchParams.set(key, value);
      let response;
      try {
        response = await this.#fetcher(url, {
          method: 'GET', headers: { Auth: chat.auth, Accept: 'application/json' },
          redirect: 'manual', signal: AbortSignal.timeout(30_000),
        });
      } catch { throw new PublicError('Could not reach Spond chat. Check the network and retry.'); }
      // The chat token can expire before the sign-in does: get a new one once. The sign-in itself worked to get
      // the token, so a second refusal is not a reason to sign in again (Spond blocks IPs that sign in too often).
      if (response.status === 401 || response.status === 403) {
        if (attempt === 0) continue;
        throw new PublicError('Spond chat refused access. Retry later; the sign-in itself still works.');
      }
      return this.#checked(response);
    }
  }

  async #checked(response) {
    if (response.status === 401) throw new PublicError('The Spond sign-in has expired. Run npm run login again.');
    if (response.status === 404) throw new PublicError('Not found in Spond.');
    if (response.status === 429) throw new PublicError('Spond is limiting requests. Wait a few minutes before retrying.');
    if (!response.ok) throw new PublicError(`Spond responded with HTTP ${response.status}.`);
    return limitedJson(response);
  }

  // Profile and groups change rarely; caching them keeps request volume low, which Spond enforces.
  #cached(key, load) {
    const hit = this.#cache.get(key);
    if (hit && hit.expiresAt > Date.now()) return hit.value;
    const value = load();
    this.#cache.set(key, { value, expiresAt: Date.now() + cacheMs });
    value.catch(() => { if (this.#cache.get(key)?.value === value) this.#cache.delete(key); });
    return value;
  }

  async #context() {
    const [profile, groups] = await Promise.all([
      this.#cached('profile', () => this.#request('/profile')),
      this.#cached('groups', () => this.#request('/groups/')),
    ]);
    if (typeof profile?.id !== 'string' || !Array.isArray(groups)) throw new PublicError('Spond sent an unexpected response.');
    const people = new Map([[profile.id, fullName(profile)]]);
    const groupNames = new Map();
    const family = new Map();
    // The user and the other guardians of the user's children, so chat messages from the family can be marked.
    const familyProfiles = new Set([profile.id]);
    for (const group of groups) {
      if (typeof group?.id !== 'string') continue;
      groupNames.set(group.id, str(group.name));
      for (const sub of list(group.subGroups)) if (typeof sub?.id === 'string') groupNames.set(sub.id, str(sub.name));
      for (const member of list(group.members)) {
        if (typeof member?.profile?.id === 'string') people.set(member.profile.id, fullName(member));
        for (const guardian of list(member?.guardians)) {
          if (typeof guardian?.profile?.id === 'string') people.set(guardian.profile.id, fullName(guardian));
        }
        if (member?.profile?.id === profile.id && typeof member.id === 'string') {
          family.set(member.id, { name: fullName(member), relation: 'self', groupId: group.id, subGroupIds: list(member.subGroups) });
        }
      }
      // Memberships the user answers for, typically their children.
      for (const member of list(group.behalfOfMemberships)) {
        if (typeof member?.id === 'string') {
          family.set(member.id, { name: fullName(member), relation: 'child', groupId: group.id, subGroupIds: list(member.subGroups) });
          const listed = list(group.members).find((entry) => entry?.id === member.id);
          for (const guardian of [...list(member.guardians), ...list(listed?.guardians)]) {
            if (typeof guardian?.profile?.id === 'string') familyProfiles.add(guardian.profile.id);
          }
        }
      }
    }
    return { groups, people, groupNames, family, familyProfiles, timeZone: validTimeZone(profile.timezone) };
  }

  #event(event, context, { full = false } = {}) {
    const { family, groupNames, people, timeZone } = context;
    const result = { id: str(event?.id), title: str(event?.heading),
      start: localTime(event?.startTimestamp, timeZone), end: localTime(event?.endTimestamp, timeZone) };
    const meetup = localTime(event?.meetupTimestamp, timeZone);
    if (meetup) result.meetup = meetup;
    const group = event?.recipients?.group;
    if (typeof group?.id === 'string') result.group = groupNames.get(group.id) || str(group.name);
    const subGroups = list(group?.subGroups).map((sub) => groupNames.get(sub?.id) || str(sub?.name)).filter(Boolean);
    if (subGroups.length > 0) result.subGroups = subGroups;
    const location = { name: str(event?.location?.feature), address: str(event?.location?.address) };
    if (location.name || location.address) result.location = location;
    if (event?.matchInfo) {
      result.match = { team: str(event.matchInfo.teamName), opponent: str(event.matchInfo.opponentName),
        homeAway: str(event.matchInfo.type)?.toLowerCase() };
    }
    if (event?.cancelled === true) result.cancelled = true;
    const deadline = localTime(event?.rsvpDate, timeZone);
    if (deadline) result.responseDeadline = deadline;
    if (Number.isInteger(event?.maxAccepted) && event.maxAccepted > 0) result.maxAccepted = event.maxAccepted;

    const statusById = new Map();
    result.responseCounts = {};
    for (const [key, status] of responseLists) {
      const ids = list(event?.responses?.[key]).filter((id) => typeof id === 'string');
      result.responseCounts[status] = ids.length;
      for (const id of ids) statusById.set(id, status);
    }
    const familyIds = new Set(list(event?.behalfOfIds).filter((id) => typeof id === 'string'));
    for (const id of family.keys()) if (statusById.has(id)) familyIds.add(id);
    result.family = [...familyIds].map((id) => ({
      name: family.get(id)?.name || 'Unknown', response: statusById.get(id) || 'unknown',
    }));

    if (full) {
      longText(result, 'description', event?.description);
      const organizers = [...new Set(list(event?.owners).map((owner) => people.get(owner?.id)).filter(Boolean))];
      if (organizers.length > 0) result.organizers = organizers;
      const creator = people.get(event?.creatorId);
      if (creator) result.createdBy = creator;
      if (list(event?.attachments).length > 0) result.attachmentCount = event.attachments.length;
      result.comments = comments(event?.comments, people, timeZone);
      result.commentCount = list(event?.comments).length;
    }
    return result;
  }

  async listFamily() {
    const { family, groupNames } = await this.#context();
    const people = new Map();
    for (const entry of family.values()) {
      const key = `${entry.relation}:${entry.name}`;
      const person = people.get(key) || { name: entry.name || 'Unknown', relation: entry.relation, groups: [] };
      person.groups.push({ id: entry.groupId, name: groupNames.get(entry.groupId),
        subGroups: entry.subGroupIds.map((id) => groupNames.get(id)).filter(Boolean) });
      people.set(key, person);
    }
    return [...people.values()];
  }

  async listGroups() {
    const { groups, family } = await this.#context();
    const items = groups.filter((group) => typeof group?.id === 'string').map((group) => ({
      id: group.id, name: str(group.name), activity: str(group.activity), club: str(group.clubName),
      contactPerson: fullName(group.contactPerson),
      subGroups: list(group.subGroups).filter((sub) => typeof sub?.id === 'string')
        .slice(0, maxItems).map((sub) => ({ id: sub.id, name: str(sub.name) })),
      family: [...new Set([...family.values()].filter((entry) => entry.groupId === group.id).map((entry) => entry.name))],
      memberCount: list(group.members).length,
    }));
    return { items: items.slice(0, maxItems), total: items.length, truncated: items.length > maxItems };
  }

  async listEvents({ from_date, to_date, group_id, only_unanswered = false } = {}) {
    const fromDate = dateValue(from_date, 'from_date');
    const toDate = dateValue(to_date, 'to_date');
    const groupId = group_id === undefined ? undefined : spondId(group_id, 'group_id');
    if (typeof only_unanswered !== 'boolean') throw new PublicError('only_unanswered must be true or false.');
    const context = await this.#context();
    const from = fromDate || localTime(new Date().toISOString(), context.timeZone).slice(0, 10);
    const to = toDate || addDays(from, 14);
    if (to < from) throw new PublicError('from_date must not be after to_date.');
    if (Date.parse(to) - Date.parse(from) > 366 * dayMs) throw new PublicError('The date range cannot be longer than 366 days.');
    // Widen the UTC window by a day on each side, then filter on local dates.
    const data = await this.#request('/sponds/', {
      max: String(maxSpondEvents), scheduled: 'false', ...(groupId ? { groupId } : {}),
      minEndTimestamp: `${addDays(from, -1)}T00:00:00.000Z`, maxStartTimestamp: `${addDays(to, 2)}T00:00:00.000Z`,
    });
    if (!Array.isArray(data)) throw new PublicError('Spond sent an unexpected response.');
    let items = data
      .filter((event) => Number.isFinite(Date.parse(event?.startTimestamp)) && Number.isFinite(Date.parse(event?.endTimestamp)))
      .sort((a, b) => Date.parse(a.startTimestamp) - Date.parse(b.startTimestamp))
      .map((event) => this.#event(event, context))
      .filter((event) => event.end.slice(0, 10) >= from && event.start.slice(0, 10) <= to);
    if (only_unanswered) items = items.filter((event) => event.family.some((member) => member.response === 'unanswered'));
    return { from, to, timeZone: context.timeZone, items: items.slice(0, maxItems), total: items.length,
      truncated: items.length > maxItems || data.length >= maxSpondEvents };
  }

  async getEvent({ event_id } = {}) {
    const eventId = spondId(event_id, 'event_id');
    const context = await this.#context();
    const event = await this.#request(`/sponds/${eventId}`, { includeComments: 'true' });
    if (!event || typeof event !== 'object' || Array.isArray(event)) throw new PublicError('Spond sent an unexpected response.');
    return { timeZone: context.timeZone, ...this.#event(event, context, { full: true }) };
  }

  async listPosts({ group_id, limit = 20, include_images = false } = {}) {
    includeImages(include_images);
    const groupId = group_id === undefined ? undefined : spondId(group_id, 'group_id');
    limitValue(limit);
    const context = await this.#context();
    const { groupNames, people, timeZone } = context;
    const data = await this.#request('/posts/', {
      type: 'PLAIN', max: String(limit), includeComments: 'true', ...(groupId ? { groupId } : {}),
    });
    if (!Array.isArray(data)) throw new PublicError('Spond sent an unexpected response.');
    const items = data.slice(0, limit).map((post) => {
      const result = { id: str(post?.id), group: groupNames.get(post?.groupId), title: str(post?.title),
        author: people.get(post?.ownerId) || 'Unknown', time: localTime(post?.timestamp, timeZone) };
      const subGroups = list(post?.subGroupIds).map((id) => groupNames.get(id)).filter(Boolean);
      if (subGroups.length > 0) result.subGroups = subGroups;
      longText(result, 'text', post?.body);
      if (post?.unread === true) result.unread = true;
      if (list(post?.media).length > 0) result.imageCount = post.media.length;
      const images = include_images ? imageUrls(post?.media) : [];
      if (images.length > 0) result.images = images;
      if (list(post?.attachments).length > 0) result.attachmentCount = post.attachments.length;
      result.comments = comments(post?.comments, people, timeZone);
      result.commentCount = list(post?.comments).length;
      return result;
    });
    return { timeZone, items, total: items.length };
  }

  #message(message, context, { excerpt = false, images = false } = {}) {
    const { people, familyProfiles, timeZone } = context;
    const result = {};
    if (Number.isInteger(message?.msgNum)) result.num = message.msgNum;
    result.author = people.get(message?.user) || 'Unknown';
    if (familyProfiles.has(message?.user)) result.fromFamily = true;
    const time = localTime(message?.timestamp, timeZone);
    if (time) result.time = time;
    const type = str(message?.type, 40)?.toLowerCase();
    if (type && type !== 'text') result.type = type;
    if (type === 'deleted') return result;
    if (excerpt) {
      const text = str(message?.text, maxExcerptChars + 1);
      if (text) result.text = text.length > maxExcerptChars ? `${clean(text.slice(0, maxExcerptChars))}…` : text;
    } else {
      longText(result, 'text', message?.text);
    }
    if (message?.image || list(message?.images).length > 0) result.hasImage = true;
    const imageLinks = images ? imageUrls(message?.images) : [];
    if (imageLinks.length > 0) result.images = imageLinks;
    if (message?.file) result.hasFile = true;
    if (typeof message?.spond?.id === 'string') result.event = { id: str(message.spond.id, 64), title: str(message.spond.heading) };
    if (typeof message?.post?.id === 'string') result.post = { id: str(message.post.id, 64), title: str(message.post.title) };
    return result;
  }

  async listChats({ limit = 20 } = {}) {
    limitValue(limit);
    const context = await this.#context();
    const { groupNames, timeZone } = context;
    // Chats the user takes part in themselves, and chats they follow as a guardian (often the parents' group chats).
    const [own, guardian] = await Promise.all([
      this.#chatRequest('/chats', { max: String(limit) }),
      this.#chatRequest('/chats', { max: String(limit), guardianChats: 'true' }),
    ]);
    if (!Array.isArray(own) || !Array.isArray(guardian)) throw new PublicError('Spond sent an unexpected response.');
    const chats = new Map();
    for (const [chat, asGuardian] of [...own.map((c) => [c, false]), ...guardian.map((c) => [c, true])]) {
      if (typeof chat?.id !== 'string' || !chatIdPattern.test(chat.id) || chats.has(chat.id)) continue;
      const result = { id: chat.id, type: str(chat.type, 40)?.toLowerCase() };
      const group = groupNames.get(chat.groupId);
      const name = str(chat.name) || group;
      if (name) result.name = name;
      if (group) result.group = group;
      if (asGuardian) result.asGuardian = true;
      const newest = localTime(chat.newestTimestamp, timeZone);
      if (newest) result.newest = newest;
      if (Number.isInteger(chat.message?.msgNum)) result.newestNum = chat.message.msgNum;
      if (chat.unread === true) result.unread = true;
      result.participantCount = list(chat.participants).length;
      if (chat.message) result.lastMessage = this.#message(chat.message, context, { excerpt: true });
      chats.set(chat.id, result);
    }
    const items = [...chats.values()].sort((a, b) => (Date.parse(b.newest) || 0) - (Date.parse(a.newest) || 0));
    return { timeZone, items: items.slice(0, limit), total: items.length, truncated: items.length > limit };
  }

  async getChat({ chat_id, limit = 20, max_num, include_images = false } = {}) {
    const id = chatId(chat_id);
    includeImages(include_images);
    limitValue(limit);
    if (max_num !== undefined && (!Number.isInteger(max_num) || max_num < 1)) throw new PublicError('max_num must be a positive integer.');
    const context = await this.#context();
    const query = { count: String(limit), ...(max_num ? { maxNum: String(max_num) } : {}) };
    const data = await this.#chatRequest(`/chats/${id}/messages`, query);
    if (!Array.isArray(data)) throw new PublicError('Spond sent an unexpected response.');
    const messages = data.filter((message) => message && typeof message === 'object').slice(0, limit)
      .map((message) => this.#message(message, context, { images: include_images }))
      .sort((a, b) => (a.num ?? 0) - (b.num ?? 0));
    const result = { timeZone: context.timeZone, chatId: id, messages };
    // Spond numbers messages from 0, so a first message numbered 1 still has an older one.
    if (messages.length > 0 && messages[0].num > 0 && data.length >= limit) result.olderBefore = messages[0].num;
    return result;
  }
}
