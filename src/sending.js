import { randomBytes } from 'node:crypto';
import { appendFile, chmod, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { PublicError } from './errors.js';
import { sentLogPath } from './paths.js';

// Answering, voting, tasks, comments, chat messages and marking as read are off unless SPOND_ALLOW_SEND=1. All but marking
// as read take two steps: a prepare tool checks the request and returns exactly what will be sent with a one-time code,
// and send_prepared sends only that.
export const sendingEnabled = () => process.env.SPOND_ALLOW_SEND === '1';

// Chat messages and comments reach many people with the AI's own text, so they need the parent's yes in the client's
// dialog (MCP elicitation), not only the client's tool approval, unless SPOND_ALLOW_SEND_NO_DIALOG=1.
const needsDialog = new Set(['chat_message', 'comment']);
const sendWithoutDialog = () => process.env.SPOND_ALLOW_SEND_NO_DIALOG === '1';
const noDialog = 'This client can\'t show the confirmation dialog, so chat messages and comments are not sent. Set SPOND_ALLOW_SEND_NO_DIALOG=1 to allow it anyway.';

const codeTtl = 10 * 60_000;
const maxPending = 20;
export const maxSummary = 2_400;  // room for a whole 2,000-character message, its audience and short names

// Names and titles come from other people, so a line break in one could fake a line in the confirmation dialog.
// Every preview field is one line, except the parent's own text.
const oneLine = (value) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : Array.isArray(value) ? value.map(oneLine) : value);
const singleLine = (preview) => Object.fromEntries(Object.entries(preview).map(([key, value]) => [key, key === 'text' ? value : oneLine(value)]));
const capped = (value) => (value && value.length > 40 ? `${value.slice(0, 39).toWellFormed()}…` : value);

export class Sender {
  #spond;
  #log;
  #now;
  #confirm;
  #canAsk;
  #pending = new Map();

  constructor({ spond, log = sentLogPath, now = Date.now, confirm = async () => null, canAsk = () => false }) {
    this.#canAsk = canAsk;
    this.#spond = spond;
    this.#log = log;
    this.#now = now;
    this.#confirm = confirm;
  }

  #prepare(action, planner, args, { request, preview: raw }) {
    const preview = singleLine(raw);
    const now = this.#now();
    for (const [code, entry] of this.#pending) if (entry.expiresAt <= now) this.#pending.delete(code);
    if (this.#pending.size >= maxPending) throw new PublicError('Too many prepared answers waiting. Send or let them expire first.');
    // Two codes for one request would let it be sent twice.
    if ([...this.#pending.values()].some((entry) => isDeepStrictEqual(entry.request, request))) {
      throw new PublicError('Exactly this is already prepared. Send that one, or let it expire after 10 minutes.');
    }
    const code = randomBytes(4).toString('hex');
    // send_prepared must repeat this line, so a client's approval prompt shows what is sent, not only a code. Who gets it
    // and the whole text come first; names, set by others, come last and short.
    const text = preview.text && `«${oneLine(preview.text)}»`;
    const summary = [action,
      preview.recipients !== undefined && `to ${preview.recipients} ${preview.recipients === 1 ? 'person' : 'people'}`,
      preview.alsoReadBy && `also ${preview.alsoReadBy}`, preview.audience && `seen by ${preview.audience}`,
      capped(preview.member), capped(preview.task), preview.answer, preview.option && `${preview.vote ? 'vote' : 'remove vote'}: ${capped(preview.option)}`,
      preview.reason && `«${preview.reason}»`, preview.replyTo && 'reply', text,
      capped(preview.chat), capped(preview.group), capped(preview.event || preview.poll || preview.post), preview.start]
      .filter(Boolean).join(' · ').slice(0, maxSummary);
    if (text && !summary.includes(text)) throw new PublicError('The text does not fit in the summary. Shorten it.');
    this.#pending.set(code, { action, planner, args: { ...args }, request, preview, summary, expiresAt: now + codeTtl });
    return { action, ...preview, summary, confirmationCode: code, expiresInMinutes: codeTtl / 60_000,
      note: 'Nothing has been sent. Show this to the parent, and call send_prepared with the code and the summary only after they approve it.' };
  }

  async prepareEventResponse(args = {}) {
    return this.#prepare('event_response', 'planEventResponse', args, await this.#spond.planEventResponse(args));
  }

  async preparePollVote(args = {}) {
    return this.#prepare('poll_vote', 'planPollVote', args, await this.#spond.planPollVote(args));
  }

  async prepareTaskResponse(args = {}) {
    return this.#prepare('task_response', 'planTaskResponse', args, await this.#spond.planTaskResponse(args));
  }

  // Said at prepare time already, before anything is read from Spond, so the parent learns it early.
  #dialogAvailable() {
    if (!this.#canAsk() && !sendWithoutDialog()) throw new PublicError(noDialog);
  }

  async prepareComment(args = {}) {
    this.#dialogAvailable();
    return this.#prepare('comment', 'planComment', args, await this.#spond.planComment(args));
  }

  async prepareChatMessage(args = {}) {
    this.#dialogAvailable();
    return this.#prepare('chat_message', 'planChatMessage', args, await this.#spond.planChatMessage(args));
  }

  // Asks the parent in the client's dialog when the client can. null means it cannot ask, and the client's own tool
  // approval is the check; anything but a clear yes stops it.
  async #confirmed(action, preview) {
    // The parent's own text is shown last and quoted line by line, so it cannot pass for other fields.
    const { text, ...fields } = singleLine(preview);
    const lines = Object.entries(fields).filter(([, value]) => value !== undefined && value !== null).map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(', ') : value}`);
    if (text !== undefined) lines.push(`text, exactly as sent (${text.length} characters):`, ...text.split('\n').map((line) => `│ ${line}`));
    const question = `Spond: ${action}\n${lines.join('\n')}`;
    const answer = await this.#confirm(question.length > 4_000 ? `${question.slice(0, 3_999)}…` : question);
    if (answer === null && needsDialog.has(action) && !sendWithoutDialog()) throw new PublicError(noDialog);
    if (answer === false) throw new PublicError('Not sent: it was not confirmed in the dialog. Prepare it again if the parent still wants it.');
  }

  // A failed log write must not turn a completed action into an error: it was already sent.
  async #logged(entry, result) {
    try {
      await mkdir(dirname(this.#log), { recursive: true, mode: 0o700 });
      await appendFile(this.#log, JSON.stringify({ time: new Date(this.#now()).toISOString(), ...entry }) + '\n', { mode: 0o600 });
      await chmod(this.#log, 0o600);
      return result;
    } catch {
      return { ...result, note: [result.note, 'It was sent, but could not be written to the local log.'].filter(Boolean).join(' ') };
    }
  }

  // Runs a write and logs it, also when it fails or its outcome is unknown. The log never holds codes or tokens.
  async #write(action, preview, run) {
    try { return await run(); }
    catch (error) {
      await this.#logged({ action, ...preview, failed: error instanceof PublicError ? error.message : 'error' }, {});
      throw error;
    }
  }

  async sendPrepared({ confirmation_code: code, summary } = {}) {
    const entry = typeof code === 'string' ? this.#pending.get(code) : undefined;
    if (!entry || entry.expiresAt <= this.#now()) {
      this.#pending.delete(code);
      throw new PublicError('Unknown or expired confirmation code. Prepare it again.');
    }
    if (summary !== entry.summary) throw new PublicError('The summary does not match what was prepared. Pass the summary exactly as prepare returned it.');
    this.#pending.delete(code);  // single use, also when sending fails, so a retry never sends twice
    await this.#confirmed(entry.action, entry.preview);
    // The target may have changed since the preview (a full event or task, new chat participants, a lost membership):
    // then the parent did not see this. The planner checks it all again, and anything shown must be unchanged.
    const fresh = await this.#spond[entry.planner](entry.args);
    if (!isDeepStrictEqual(fresh.request, entry.request) || !isDeepStrictEqual(singleLine(fresh.preview), entry.preview)) {
      throw new PublicError('It changed since the preview. Prepare it again.');
    }
    await this.#write(entry.action, entry.preview, () => this.#spond.send(entry.request));
    // The fresh plan's check compares with what Spond showed just before sending, so an older identical message is not taken as this one.
    const outcome = await fresh.outcome().catch(() => ({ verified: false }));
    const result = { sent: true, action: entry.action, ...entry.preview, ...outcome };
    const shown = outcome.verified ? result : { ...result, note: 'Spond accepted the request, but does not show it yet. Check in the Spond app.' };
    return this.#logged(result, shown);
  }

  // Marking as read has no undo in Spond, so it is confirmed like a send but needs no code.
  async #markRead(action, plan) {
    await this.#confirmed(action, plan.preview);
    const result = await this.#write(action, plan.preview, plan.run);
    return this.#logged({ action, ...plan.preview, ...result }, result);
  }

  async markChatRead(args) {
    return this.#markRead('mark_chat_read', await this.#spond.planChatRead(args));
  }

  async markPostsRead(args) {
    return this.#markRead('mark_posts_read', this.#spond.planPostsRead(args));
  }
}
