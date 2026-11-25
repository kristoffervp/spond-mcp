import { randomBytes } from 'node:crypto';
import { appendFile, chmod, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { PublicError } from './errors.js';
import { sentLogPath } from './paths.js';

// Answering, voting and marking as read are off unless SPOND_ALLOW_SEND=1. Answers and votes take two steps: a prepare
// tool checks the request and returns exactly what will be sent with a one-time code, and send_prepared sends only that.
export const sendingEnabled = () => process.env.SPOND_ALLOW_SEND === '1';

const codeTtl = 10 * 60_000;
const maxPending = 20;

export class Sender {
  #spond;
  #log;
  #now;
  #confirm;
  #pending = new Map();

  constructor({ spond, log = sentLogPath, now = Date.now, confirm = async () => null }) {
    this.#spond = spond;
    this.#log = log;
    this.#now = now;
    this.#confirm = confirm;
  }

  #prepare(action, planner, args, { request, preview, outcome }) {
    const now = this.#now();
    for (const [code, entry] of this.#pending) if (entry.expiresAt <= now) this.#pending.delete(code);
    if (this.#pending.size >= maxPending) throw new PublicError('Too many prepared answers waiting. Send or let them expire first.');
    const code = randomBytes(4).toString('hex');
    // send_prepared must repeat this line, so a client's approval prompt shows what is sent, not only a code.
    const summary = [action, preview.member, preview.group, preview.event || preview.poll, preview.start, preview.answer,
      preview.option && `${preview.vote ? 'vote' : 'remove vote'}: ${preview.option}`, preview.reason && `«${preview.reason}»`]
      .filter(Boolean).join(' · ').slice(0, 300);
    this.#pending.set(code, { action, planner, args: { ...args }, request, preview, outcome, summary, expiresAt: now + codeTtl });
    return { action, ...preview, summary, confirmationCode: code, expiresInMinutes: codeTtl / 60_000,
      note: 'Nothing has been sent. Show this to the parent, and call send_prepared with the code and the summary only after they approve it.' };
  }

  async prepareEventResponse(args = {}) {
    return this.#prepare('event_response', 'planEventResponse', args, await this.#spond.planEventResponse(args));
  }

  async preparePollVote(args = {}) {
    return this.#prepare('poll_vote', 'planPollVote', args, await this.#spond.planPollVote(args));
  }

  // Asks the parent in the client's dialog when the client can. null means it cannot ask, and the client's own tool
  // approval is the check; anything but a clear yes stops it.
  async #confirmed(action, preview) {
    const lines = Object.entries(preview).filter(([, value]) => value !== undefined && value !== null).map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(', ') : value}`);
    const answer = await this.#confirm(`Spond: ${action}\n${lines.join('\n')}`.slice(0, 4_000));
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
    // The event or poll may have changed since the preview (an answer elsewhere, a full event): then the parent did not see this.
    const fresh = await this.#spond[entry.planner](entry.args);
    if (!isDeepStrictEqual(fresh.request, entry.request) || !isDeepStrictEqual(fresh.preview.warnings, entry.preview.warnings)) {
      throw new PublicError('It changed since the preview. Prepare it again.');
    }
    await this.#write(entry.action, entry.preview, () => this.#spond.send(entry.request));
    const outcome = await entry.outcome().catch(() => ({ verified: false }));
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
