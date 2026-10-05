/* ===================== NEO, HOSTED: FEEDBACK ====================== */
/* Help → Send Feedback…: a note from the writer to the person who     */
/* runs this site, sent by the server as an email (feedback:send).     */
/* The same panel is the one-time welcome for a guest of honor: when   */
/* the server flags the page (config.welcome), it opens once with a    */
/* thank-you and the form, and welcome:seen makes sure it never opens  */
/* on its own again. Nothing here is in the desktop app.               */

(function () {
  'use strict';

  const { t } = window.NeoI18n;
  const hosted = window.neoHosted;
  const config = hosted.config || {};

  let open = null;

  /** The welcome a guest of honor reads once: what this site is, and thanks for the editor and the books. */
  function welcomeParagraphs() {
    return [
      t('This site is a hosted edition of NEO, the word processor you wrote and gave away. We are more than a little flattered that you are here.'),
      t('Thank you for the books as well, the Silo series above all. Wool, Shift and Dust kept at least one of us up past midnight, and the way you write about people who keep going in the dark is a good part of why anyone bothered to put your editor on a server.'),
      t('NEO here is your code, unchanged; what was added is a door and a place to keep the words. If anything feels off, or you would want it different, say so and it goes straight to the person who runs this site.')
    ];
  }

  /**
   * @param {{ welcome?: boolean }} options  `welcome` opens the panel as the one-time thank-you.
   */
  function openFeedback({ welcome = false } = {}) {
    if (open) { open.focus(); return; }
    const withForm = !!config.feedback;
    const bd = document.createElement('div');
    bd.className = 'modal-backdrop hosted-feedback';
    bd.tabIndex = -1;
    bd.innerHTML = `
      <div class="modal hosted-feedback-modal" role="dialog" aria-labelledby="hosted-feedback-title">
        <h2 id="hosted-feedback-title" style="font-size:16px"></h2>
        <div class="hf-lead"></div>
        <textarea class="hf-text" rows="6" hidden></textarea>
        <div class="hh-actions">
          <span class="hh-note"></span>
          <button class="hf-close btn-quiet">${t('Close')}</button>
          <button class="hf-send btn-gold" hidden>${t('Send')}</button>
        </div>
      </div>`;
    document.body.appendChild(bd);
    open = bd;
    bd.querySelector('h2').textContent = welcome ? t('Welcome, and thank you') : t('Send Feedback');
    const lead = bd.querySelector('.hf-lead');
    const paragraphs = welcome ? welcomeParagraphs() : [t('A note to the person who runs this site: a bug, a wish, a thank-you. Your address goes with it so they can answer.')];
    for (const text of paragraphs) { const p = document.createElement('p'); p.textContent = text; lead.appendChild(p); }
    const note = bd.querySelector('.hh-note');
    const text = bd.querySelector('.hf-text');
    const sendButton = bd.querySelector('.hf-send');
    const close = () => { bd.remove(); open = null; };
    bd.querySelector('.hf-close').onclick = close;
    bd.addEventListener('click', (e) => { if (e.target === bd) close(); });
    bd.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } });

    if (withForm) {
      text.hidden = false;
      sendButton.hidden = false;
      text.placeholder = welcome ? t('Anything at all, or nothing; the page is yours either way.') : t('What would you like to say?');
      sendButton.onclick = async () => {
        const message = text.value.trim();
        if (!message) { note.textContent = t('Write something first'); text.focus(); return; }
        sendButton.disabled = true;
        text.disabled = true;
        note.textContent = t('Sending…');
        try {
          await window.neo.sendFeedback(message);
          note.textContent = t('Sent. Thank you.');
          bd.querySelector('.hf-close').textContent = t('Done');
        } catch (err) {
          note.textContent = String((err && err.message) || err);
          sendButton.disabled = false;
          text.disabled = false;
        }
      };
      text.focus();
    } else {
      bd.focus();
    }
  }

  hosted.openFeedback = () => openFeedback();

  // The one-time welcome: after the room has drawn itself, and never again
  // once the server has been told it was shown.
  if (config.welcome === 'honored') {
    window.addEventListener('load', () => setTimeout(() => {
      openFeedback({ welcome: true });
      window.neo.welcomeSeen().catch(() => { /* then it shows once more next time, which is forgivable */ });
    }, 1200));
  }
})();
