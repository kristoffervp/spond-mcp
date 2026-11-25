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
// Hangul fillers, the braille blank and variation selectors render as nothing too; runs of variation selectors collapse.
const invisibleCharacters = /(?![\n\t])[\p{Cf}\p{Cc}\u034F\u115F\u1160\u3164\uFFA0\u2800\u{E0100}-\u{E01EF}]/gu;
export const clean = (text) => String(text ?? '').toWellFormed().replace(/[\u2028\u2029]/g, '\n').replace(invisibleCharacters, '')
  .replace(/([\uFE00-\uFE0F])[\uFE00-\uFE0F]+/g, '$1');

// Once a write has left, a lost answer does not mean it was not applied, so it is never reported as safe to retry.
const uncertain = 'It may have been sent. Check list_events or list_polls before preparing again.';

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
  if (size === 0) return null;  // write calls may answer with an empty body
  try { return JSON.parse(Buffer.concat(chunks, size).toString('utf8')); }
  catch { throw new PublicError('Spond sent an unexpected response.'); }
}

const optionIdPattern = /^[0-9A-Za-z_-]{1,64}$/;
const maxReason = 100;  // the web client's limit for a decline message

// A member's answer as Spond's web client reads it: unconfirmed (offered a spot from the waiting list) wins.
function responseOf(responses, id) {
  const has = (key) => list(responses?.[key]).includes(id);
  if (has('unconfirmedIds')) return 'unconfirmed';
  if (has('waitinglistIds')) return 'waiting_list';
  if (has('acceptedIds')) return 'accepted';
  if (has('declinedIds')) return 'declined';
  return has('unansweredIds') ? 'unanswered' : 'unknown';
}

// Picks who to answer for among the IDs Spond lets this user answer for, by first or full name.
function familyMember(ids, family, member, what) {
  const candidates = [...new Set(list(ids).filter((id) => typeof id === 'string' && /^[0-9A-Fa-f]{32}$/.test(id) && family.has(id)))];
  const names = candidates.map((id) => family.get(id).name || 'Unknown').join(', ');
  if (candidates.length === 0) throw new PublicError(`No one in your family can answer this ${what}.`);
  if (member === undefined) {
    if (candidates.length > 1) throw new PublicError(`Name the family member to answer for: ${names}.`);
    return candidates[0];
  }
  const query = typeof member === 'string' ? clean(member).trim().toLowerCase() : '';
  if (!query) throw new PublicError('member must be a name.');
  const found = candidates.filter((id) => {
    const name = (family.get(id).name || '').toLowerCase();
    return name === query || name.split(' ')[0] === query;
  });
  if (found.length !== 1) throw new PublicError(`No single family member with that name on this ${what}. Choose from: ${names}.`);
  return found[0];
}

function pollSummary(poll, family, timeZone) {
  const time = poll.type === 'TIME';
  const options = list(poll.options).filter((option) => typeof option?.id === 'string' && optionIdPattern.test(option.id)).slice(0, maxItems);
  const text = (option) => (time ? localTime(option.text, timeZone) : undefined) || str(option.text) || '';
  const result = { question: str(poll.question), type: time ? 'time' : 'text', multipleChoice: poll.multipleChoice === true,
    ends: localTime(poll.dueBy, timeZone), ended: Date.parse(poll.dueBy) <= Date.now() || poll.expired === true,
    options: options.map((option) => ({ id: option.id, text: text(option), votes: list(option.votes).length })),
    blankVotes: list(poll.blankVotes).length };
  const description = str(poll.description);
  if (description) result.description = description;
  // Who voted for what only for the family; other members are counted, never named.
  result.family = list(poll.behalfOfIds).filter((id) => family.has(id)).map((id) => ({
    name: family.get(id).name || 'Unknown',
    votedFor: options.filter((option) => list(option.votes).includes(id)).map(text),
    ...(list(poll.blankVotes).includes(id) ? { blank: true } : {}),
  }));
  return result;
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

  async #request(path, query, { method = 'GET', body, write = false } = {}) {
    let session = await this.#sessionProvider();
    const url = new URL(`${apiBase}${path}`);
    if (url.origin !== apiOrigin || !url.pathname.startsWith('/core/v1/')) throw new PublicError('Invalid Spond address.');
    for (const [key, value] of Object.entries(query || {})) url.searchParams.set(key, value);
    const send = async () => {
      try {
        return await this.#fetcher(url, {
          method, headers: { Authorization: `Bearer ${session.accessToken}`, Accept: 'application/json',
            ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
          redirect: 'manual', signal: AbortSignal.timeout(30_000),
        });
      } catch { throw new PublicError(write ? uncertain : 'Could not reach Spond. Check the network and retry.'); }
    };
    let response = await send();
    if (response.status === 401) {
      session = await this.#refresh(session);
      response = await send();
    }
    return this.#checked(response, write);
  }

  // Chat lives on a separate host. POST /chat gives its address and a chat token, kept in memory only.
  #chatSession(renew = false) {
    if (!this.#chat || renew) {
      const pending = (async () => {
        const data = await this.#request('/chat', undefined, { method: 'POST', body: {} });
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

  async #chatRequest(path, query, { method = 'GET', body, write = false } = {}) {
    for (let attempt = 0; ; attempt += 1) {
      const chat = await this.#chatSession(attempt > 0);
      const url = new URL(`${chat.url}${path}`);
      if (url.origin !== chat.origin) throw new PublicError('Invalid Spond chat address.');
      for (const [key, value] of Object.entries(query || {})) url.searchParams.set(key, value);
      let response;
      try {
        response = await this.#fetcher(url, {
          method, headers: { Auth: chat.auth, Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
          redirect: 'manual', signal: AbortSignal.timeout(30_000),
        });
      } catch { throw new PublicError(write ? uncertain : 'Could not reach Spond chat. Check the network and retry.'); }
      // The chat token can expire before the sign-in does: get a new one once. The sign-in itself worked to get
      // the token, so a second refusal is not a reason to sign in again (Spond blocks IPs that sign in too often).
      if (response.status === 401 || response.status === 403) {
        if (attempt === 0) continue;
        throw new PublicError('Spond chat refused access. Retry later; the sign-in itself still works.');
      }
      return this.#checked(response, write);
    }
  }

  async #checked(response, write = false) {
    if (write && response.status >= 500) throw new PublicError(uncertain);
    if (response.status === 401) throw new PublicError('The Spond sign-in has expired. Run npm run login again.');
    if (response.status === 404) throw new PublicError('Not found in Spond.');
    if (response.status === 429) throw new PublicError('Spond is limiting requests. Wait a few minutes before retrying.');
    if (!response.ok) throw new PublicError(`Spond responded with HTTP ${response.status}.`);
    return write ? limitedJson(response).catch(() => { throw new PublicError(uncertain); }) : limitedJson(response);
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

  async listPolls({ group_id, limit = 20 } = {}) {
    const groupId = group_id === undefined ? undefined : spondId(group_id, 'group_id');
    limitValue(limit);
    const context = await this.#context();
    const { family, groupNames, people, timeZone } = context;
    // Polls are posts of type POLL, which list_posts (type PLAIN) does not include.
    const data = await this.#request('/posts/', { type: 'POLL', max: String(limit), ...(groupId ? { groupId } : {}) });
    if (!Array.isArray(data)) throw new PublicError('Spond sent an unexpected response.');
    const items = data.filter((post) => post?.poll && typeof post.id === 'string').slice(0, limit).map((post) => ({
      id: str(post.id, 64), group: groupNames.get(post.groupId), title: str(post.title),
      author: people.get(post.ownerId) || 'Unknown', time: localTime(post.timestamp, timeZone),
      poll: pollSummary(post.poll, family, timeZone),
    }));
    return { timeZone, items, total: items.length };
  }

  // Checks an answer to an event and returns the request to send, what to show the parent, and how to read the result.
  async planEventResponse({ event_id, accepted, member, reason } = {}) {
    const eventId = spondId(event_id, 'event_id');
    if (typeof accepted !== 'boolean') throw new PublicError('accepted must be true or false.');
    let declineMessage;
    if (reason !== undefined) {
      if (accepted) throw new PublicError('reason is only used when declining.');
      declineMessage = typeof reason === 'string' ? clean(reason).replace(/\s+/g, ' ').trim() : '';
      if (!declineMessage) throw new PublicError('reason must be non-empty text.');
      if (declineMessage.length > maxReason) throw new PublicError(`reason can be at most ${maxReason} characters.`);
    }
    const context = await this.#context();
    const event = await this.#request(`/sponds/${eventId}`);
    if (!event || typeof event !== 'object' || Array.isArray(event)) throw new PublicError('Spond sent an unexpected response.');
    const id = familyMember(event.behalfOfIds, context.family, member, 'event');
    const name = context.family.get(id).name || 'Unknown';
    const status = responseOf(event.responses, id);
    const now = Date.now();
    // The same rules as Spond's web client for someone who is not an organizer.
    if (event.cancelled === true) throw new PublicError('The event is cancelled.');
    if (event.expired === true || Date.parse(event.endTimestamp) <= now) throw new PublicError('The event is over.');
    if (event.registered === true) throw new PublicError('The organizer has registered attendance, so the answer can no longer change.');
    if (event.payment) throw new PublicError('This event has a payment. Answer it in the Spond app.');
    const deadlinePassed = Date.parse(event.rsvpDate) <= now;
    const answered = status !== 'unanswered';
    const warnings = [];
    if (accepted) {
      if (status === 'accepted' || status === 'waiting_list') throw new PublicError(`${name} has already answered yes (${status}).`);
      if (deadlinePassed && status !== 'unconfirmed') {
        throw new PublicError(`The answer deadline has passed${answered ? ', so the answer cannot change' : ''}. Message the organizer instead.`);
      }
      const full = event.maxAccepted > 0 && event.maxAccepted <= list(event.responses?.acceptedIds).length;
      if (full && status !== 'unconfirmed') warnings.push(`The event is full, so this puts ${name} on the waiting list.`);
    } else {
      if (status === 'declined') throw new PublicError(`${name} has already declined.`);
      if (deadlinePassed && answered) throw new PublicError('The answer deadline has passed, so the answer cannot change. Message the organizer instead.');
      if (status === 'accepted' && list(event.responses?.waitinglistIds).length > 0) {
        warnings.push(`${name} gives up the spot to the next on the waiting list, and may not get it back.`);
      }
      if (status === 'waiting_list') warnings.push(`${name} leaves the waiting list.`);
      if (status === 'unconfirmed') warnings.push(`${name} gives up the spot offered from the waiting list.`);
    }
    const preview = { member: name, group: context.groupNames.get(event.recipients?.group?.id), event: str(event.heading),
      start: localTime(event.startTimestamp, context.timeZone), answer: accepted ? 'yes' : 'no', previousAnswer: status,
      ...(declineMessage ? { reason: declineMessage } : {}), ...(warnings.length ? { warnings } : {}) };
    const request = { method: 'PUT', path: `/sponds/${eventId}/responses/${id}`, body: { accepted, ...(declineMessage ? { declineMessage } : {}) } };
    // The answer Spond shows afterwards; waiting_list counts as a yes.
    const outcome = async () => {
      const answerNow = responseOf((await this.#request(`/sponds/${eventId}`))?.responses, id);
      return { verified: accepted ? ['accepted', 'waiting_list'].includes(answerNow) : answerNow === 'declined', answerNow };
    };
    return { request, preview, outcome };
  }

  async planPollVote({ post_id, option_id, member, vote = true } = {}) {
    const postId = spondId(post_id, 'post_id');
    if (typeof option_id !== 'string' || !optionIdPattern.test(option_id)) throw new PublicError('Invalid option_id.');
    if (typeof vote !== 'boolean') throw new PublicError('vote must be true or false.');
    const context = await this.#context();
    const post = await this.#request(`/posts/${postId}`);
    const poll = post?.poll;
    if (!poll || typeof poll !== 'object') throw new PublicError('That post has no poll.');
    if (poll.expired === true || Date.parse(poll.dueBy) <= Date.now()) throw new PublicError('The poll has ended.');
    const raw = list(poll.options).find((item) => item?.id === option_id);
    if (!raw) throw new PublicError('No option with that option_id in the poll.');
    if (poll.type === 'TIME' && Date.parse(raw.text) <= Date.now()) throw new PublicError('That time has passed.');
    const id = familyMember(poll.behalfOfIds, context.family, member, 'poll');
    const name = context.family.get(id).name || 'Unknown';
    if (list(raw.votes).includes(id) === vote) throw new PublicError(vote ? `${name} has already voted for that option.` : `${name} has not voted for that option.`);
    const summary = pollSummary(poll, context.family, context.timeZone);
    const index = summary.options.findIndex((item) => item.id === option_id);
    const optionText = summary.options[index]?.text.trim();
    // A blank option would show nothing in the preview, so the parent could not see what is voted for.
    if (!optionText) throw new PublicError('That option has no text. Vote in the Spond app.');
    // By member ID, not name: two family members can share a name.
    const previous = summary.options.filter((item) => list(list(poll.options).find((o) => o?.id === item.id)?.votes).includes(id)).map((item) => item.text);
    // shortcut: assumes Spond replaces the vote in a single-choice poll, as the web client sends no removal; verify live.
    const warnings = vote && !summary.multipleChoice && previous.length ? [`Single-choice poll: replaces ${name}'s vote for ${previous.join(', ')}.`] : [];
    const preview = { member: name, group: context.groupNames.get(post.groupId), poll: str(post.title), question: summary.question,
      option: optionText, position: `${index + 1} of ${summary.options.length}`, allOptions: summary.options.map((item) => item.text),
      vote, ...(warnings.length ? { warnings } : {}) };
    const request = { method: 'PUT', path: `/posts/${postId}/poll/vote/${option_id}/${id}`, body: { value: vote } };
    // What the member has voted for afterwards. In a single-choice poll an earlier vote must be gone too.
    const outcome = async () => {
      const options = list((await this.#request(`/posts/${postId}`))?.poll?.options);
      const has = (option) => list(option?.votes).includes(id);
      const votedForNow = options.filter(has).map((option) => str(option.text) || '');
      const chosen = has(options.find((option) => option?.id === option_id)) === vote;
      const othersCleared = summary.multipleChoice || !vote || options.every((option) => option?.id === option_id || !has(option));
      return { verified: chosen && othersCleared, votedForNow };
    };
    return { request, preview, outcome };
  }

  // Sends a request planned above. Only PUT on the paths the planners build.
  async send({ method, path, body }) {
    if (method !== 'PUT' || !/^\/(sponds\/[0-9A-F]{32}\/responses|posts\/[0-9A-F]{32}\/poll\/vote\/[0-9A-Za-z_-]{1,64})\/[0-9A-F]{32}$/i.test(path)) {
      throw new PublicError('Invalid Spond request.');
    }
    return this.#request(path, undefined, { method, body, write: true });
  }

  async planChatRead({ chat_id } = {}) {
    const id = chatId(chat_id);
    const context = await this.#context();
    const [newest] = list(await this.#chatRequest(`/chats/${id}/messages`, { count: '1' })).filter((message) => Number.isInteger(message?.msgNum));
    if (!newest) throw new PublicError('The chat has no messages to mark as read.');
    const shown = this.#message(newest, context, { excerpt: true });
    const preview = { chatId: id, upToMessage: newest.msgNum, newest: [shown.author, shown.text].filter(Boolean).join(': ') };
    const run = async () => {
      await this.#chatRequest(`/chats/${id}/${newest.msgNum}/read`, undefined, { method: 'PUT', body: {}, write: true });
      return { chatId: id, readUpTo: newest.msgNum };
    };
    return { preview, run };
  }

  planPostsRead({ post_ids } = {}) {
    if (!Array.isArray(post_ids) || post_ids.length < 1 || post_ids.length > 20) throw new PublicError('post_ids must list 1 to 20 post IDs.');
    const ids = [...new Set(post_ids.map((id) => spondId(id, 'post_id')))];
    const run = async () => {
      await this.#request('/posts/markAsRead', undefined, { method: 'POST', body: ids, write: true });
      return { markedRead: ids.length };
    };
    return { preview: { postIds: ids }, run };
  }
}
