/* ======================= NEO, HOSTED: PRINT ======================== */
/* Export → PDF, with the printer behind the server (config.print): the  */
/* dialog that takes the book's trim size and how scene breaks are set,  */
/* remembers the choice for the writer (print:settings) and hands it to */
/* web-bridge.js's printBook. Nothing here is in the desktop app; the    */
/* choices offered are the server's (config.print.trims / .scenes), so   */
/* the page and the printer never disagree on a name.                   */

(function () {
  'use strict';

  const { t } = window.NeoI18n;
  const hosted = window.neoHosted;
  const config = hosted.config || {};
  const offered = config.print && typeof config.print === 'object' ? config.print : null;

  let open = null;

  const option = (o, chosen) => `<option value="${o.value}"${o.value === chosen ? ' selected' : ''}>${t(o.label)}</option>`;

  /**
   * Ask for the trim size and the scene-break style, remembering the
   * answer. Resolves { trim, scene }, or null when the writer closed the
   * dialog. With no choices offered (no printer) resolves the defaults at
   * once, so a caller never waits on a dialog that cannot open.
   */
  async function choose() {
    if (!offered) return null;
    if (open) { open.focus(); return null; }
    // the writer's last choice first, so a quick hand is never overwritten by a late answer
    const saved = await window.neo.printSettings().catch(() => null);
    return new Promise((resolve) => {
      const bd = document.createElement('div');
      bd.className = 'modal-backdrop hosted-print';
      bd.tabIndex = -1;
      bd.innerHTML = `
        <div class="modal hosted-print-modal" role="dialog" aria-labelledby="hosted-print-title">
          <h2 id="hosted-print-title" style="font-size:16px">${t('Print the book')}</h2>
          <p>${t('The book is laid out as pages: mirrored margins, running heads, page numbers, a numbered contents page, each chapter opening on a right-hand page.')}</p>
          <label>${t('Trim size')}<select class="hp-trim"></select></label>
          <label>${t('Scene breaks')}<select class="hp-scene"></select></label>
          <div class="hh-actions">
            <span class="hh-note"></span>
            <button class="hp-cancel btn-quiet">${t('Cancel')}</button>
            <button class="hp-print btn-gold">${t('Make the PDF')}</button>
          </div>
        </div>`;
      document.body.appendChild(bd);
      open = bd;
      const trimSelect = bd.querySelector('.hp-trim');
      const sceneSelect = bd.querySelector('.hp-scene');
      const fill = (saved) => {
        trimSelect.innerHTML = offered.trims.map((o) => option(o, saved.trim)).join('');
        sceneSelect.innerHTML = offered.scenes.map((o) => option(o, saved.scene)).join('');
      };
      fill(saved || offered.defaults);
      const finish = (choice) => { bd.remove(); open = null; resolve(choice); };
      bd.querySelector('.hp-cancel').onclick = () => finish(null);
      bd.addEventListener('click', (e) => { if (e.target === bd) finish(null); });
      bd.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); finish(null); } });
      bd.querySelector('.hp-print').onclick = async () => {
        const choice = { trim: trimSelect.value, scene: sceneSelect.value };
        try { await window.neo.printSettings(choice); } catch { /* the choice still prints; it is only not remembered */ }
        finish(choice);
      };
      bd.focus();
      trimSelect.focus();
    });
  }

  hosted.print = { choose, offered };
})();
