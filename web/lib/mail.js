'use strict';

// Email, for confirming a new writer's address and for resetting a password.
// Resend (https://resend.com) over fetch when RESEND_API_KEY is set; otherwise
// a mailer that says it is off, and the server runs with no email at all
// (signup then needs no confirmation, and there is no password reset).
//
// Nothing else knows which provider sits behind `send`: swapping Resend for
// another HTTP mail API is a change to this file alone. The messages are
// plain text on purpose; a writer's mail client renders them, not us.

const RESEND_URL = 'https://api.resend.com/emails';

/**
 * @param {{ resendApiKey?: string, from?: string, fetchImpl?: typeof fetch }} options
 *   `from` is the sender Resend has verified, e.g. "NEO <neo@example.com>".
 *   `fetchImpl` exists for tests; production uses the global fetch.
 * @returns {{ enabled: boolean, send(message: { to: string, subject: string, text: string }): Promise<string> }}
 *   `send` resolves to the provider's message id, or throws with the provider's answer.
 */
function createMailer({ resendApiKey, from, fetchImpl = fetch } = {}) {
  if (!resendApiKey) {
    return { enabled: false, async send() { throw new Error('Email is not configured on this server'); } };
  }
  return {
    enabled: true,
    async send({ to, subject, text }) {
      const res = await fetchImpl(RESEND_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${resendApiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from, to: [to], subject, text })
      });
      if (!res.ok) throw new Error(`Resend answered ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const data = await res.json().catch(() => ({}));
      return data.id || '';
    }
  };
}

// The messages speak the language of the browser that asked for them, through
// the translator `t` the server passes (web/locales/<code>.json); without one
// they are English. Keys are the English text, as everywhere in NEO.
const english = (s) => s;

/** The message a new writer gets; the link signs them in once and marks the address confirmed. */
function confirmationMessage({ link, t = english }) {
  return {
    subject: t('Confirm your email for NEO'),
    text: [
      t('Welcome to NEO.'),
      '',
      t('Open this link to confirm your email address and start writing:'),
      link,
      '',
      t('The link is good for one day. If you did not create an account, you can ignore this message.')
    ].join('\n')
  };
}

/** The message a writer who forgot their password gets; the link opens the sign-in page in reset mode. */
function resetMessage({ link, t = english }) {
  return {
    subject: t('Reset your NEO password'),
    text: [
      t('Someone asked to reset the password for this NEO account.'),
      '',
      t('Open this link to choose a new one:'),
      link,
      '',
      t('The link is good for one hour and works once. If you did not ask for this, nothing changes; you can ignore this message.')
    ].join('\n')
  };
}

/**
 * What a writer typed into Help → Send Feedback…, for the owner's inbox. The
 * message is quoted as written; `honored` marks a guest of honor so the owner
 * knows who is talking. Reply-to is not set: the writer's address is in the text.
 */
function feedbackMessage({ from, honored, version, message }) {
  return {
    subject: `${honored ? 'Feedback from a guest of honor' : 'Feedback'} on NEO, from ${from}`,
    text: [
      `${from} wrote from the hosted edition (${version})${honored ? ', as a guest of honor' : ''}:`,
      '',
      message.trim(),
      '',
      'Sent through Help → Send Feedback… in the writing room.'
    ].join('\n')
  };
}

module.exports = { createMailer, confirmationMessage, resetMessage, feedbackMessage, RESEND_URL };
