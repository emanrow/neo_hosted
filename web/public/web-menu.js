/* ====================== NEO, HOSTED: THE MENU BAR ====================== */
/* main.js builds native menus in buildMenu(); a browser has none, so this  */
/* draws the same menus, with the same labels and messages, in a bar that   */
/* stays out of sight until the pointer reaches the top edge (or Alt / F10  */
/* for the keyboard). Each item sends the message its desktop twin sends,   */
/* and app.js answers on window.neo.onMenu exactly as before.               */

(function () {
  'use strict';

  const { t } = window.NeoI18n;
  const hosted = window.neoHosted;
  const config = hosted.config || {};
  const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform);
  const MOD = IS_MAC ? '⌘' : 'Ctrl+';
  const send = (msg) => hosted.sendMenu(msg);
  const lib = () => (typeof window.library !== 'undefined' && window.library) || {};
  const focusNow = () => (typeof window.focusLevel !== 'undefined' ? window.focusLevel : hosted.state.view.focus || 'off');

  const sep = { type: 'separator' };
  const item = (label, msg, extra = {}) => ({ label, msg, ...extra });
  const check = (label, checked, msg, extra = {}) => ({ label, type: 'checkbox', checked, msg, ...extra });
  const radio = (label, checked, msg) => ({ label, type: 'radio', checked, msg });
  const sub = (label, items) => ({ label, submenu: items });

  // the bundled faces are on every machine that opens this page (styles.css @font-face)
  const bodyFonts = () => (typeof window.BODY_FONT_CHOICES !== 'undefined' ? window.BODY_FONT_CHOICES
    : ['Georgia', 'Palatino', 'Baskerville', 'Gelasio', 'TeX Gyre Pagella', 'Libre Baskerville', 'Alegreya', 'Source Serif Pro', 'Jost', 'iA Writer Quattro']);

  // The open book's branches (web-branches.js keeps hosted.state.branches current)
  function branchItems() {
    const br = hosted.branches && hosted.state.branches && hosted.state.branches.bookId === hosted.state.bookId ? hosted.state.branches : null;
    const names = br ? br.branches.map((b) => radio(b.name === 'main' ? t('Main draft') : b.name, b.name === br.active, () => hosted.branches.switchBranch(b.name)))
      : [{ label: t('Open a book first'), disabled: true }];
    return [
      ...names,
      sep,
      item(t('New Branch…'), () => hosted.branches && hosted.branches.newBranch()),
      item(t('Compare & Merge…'), () => hosted.branches && hosted.branches.mergeBranch()),
      item(t('Delete Branch…'), () => hosted.branches && hosted.branches.deleteBranch())
    ];
  }

  // The template, read fresh each time a menu opens so its ticks are true.
  function template() {
    const L = lib();
    const st = hosted.state;
    const fonts = L.fonts || {};
    const percent = (z) => new Intl.NumberFormat(config.locale || 'en', { style: 'percent' }).format(z);
    return [
      sub(t('File'), [
        sub(t('Export'), [
          item(t('Plain Text (.txt)'), { type: 'export', format: 'txt' }),
          item('Markdown (.md)', { type: 'export', format: 'md' }),
          item(t('Web Page (.html)'), { type: 'export', format: 'html' }),
          item('PDF (.pdf)', { type: 'export', format: 'pdf' }),
          item('Word (.docx)', { type: 'export', format: 'docx' }),
          item('EPUB (.epub)', { type: 'export', format: 'epub' }),
          sep,
          check(t('Chapter Titles Only'), !!L.exportCustomChapterTitles, () => ({ type: 'exportCustomChapterTitles', checked: !L.exportCustomChapterTitles }))
        ]),
        sep,
        item(t('Email Draft to Myself'), { type: 'emailDraft' }, { accel: MOD + 'E' }),
        item(t('Email Settings…'), { type: 'emailSettings' }),
        item(t('Cover Art…'), { type: 'coverArt' }),
        item(t('Goals…'), { type: 'stats' }, { accel: MOD + ',' }),
        sub(t('New Books Open To'), [
          radio(t('Blank Page'), st.writingStyle !== 'plotter', { type: 'writingStyle', value: 'pantser' }),
          radio(t('Outline First'), st.writingStyle === 'plotter', { type: 'writingStyle', value: 'plotter' })
        ]),
        sep,
        item(t('History…'), () => hosted.openHistory && hosted.openHistory()),
        item(t('Share…'), () => hosted.openShare && hosted.openShare()),
        sub(t('Branches'), branchItems()),
        item(t('Import Manuscripts…'), { type: 'import' }, { accel: MOD + (IS_MAC ? '⇧I' : 'Shift+I') }),
        item(t('Download Library…'), () => hosted.downloadLibrary()),
        item(t('Reshelve a Book…'), { type: 'reshelve' }),
        sep,
        { label: config.email || '', disabled: true },
        item(t('Sign Out'), () => { window.neo.signOut(); })
      ]),
      sub(t('Edit'), [
        item(t('Undo'), () => document.execCommand('undo')),
        item(t('Redo'), () => document.execCommand('redo')),
        sep,
        item(t('Select All'), () => document.execCommand('selectAll')),
        sep,
        item(t('Find & Replace'), { type: 'find' }, { accel: MOD + 'F' }),
        item(t('Spellcheck Pass'), { type: 'spellcheck' }, { accel: MOD + ';' }),
        sub(t('Spellcheck Language'), Object.entries(config.spellLanguages || {}).map(([code, label]) =>
          radio(label, (L.spellLanguage || '') === code, { type: 'spellLanguage', value: code })))
      ]),
      sub(t('Format'), [
        sub(t('Body Font'), bodyFonts().map((f) => ({ label: f, font: f, type: 'radio', checked: fonts.body === f, msg: { type: 'bodyFont', value: f } }))),
        sub(t('Drop Cap Style'), [
          radio(t('Literary'), (fonts.dropcap || 'literary') === 'literary', { type: 'dropCap', value: 'literary' }),
          radio(t('Fantasy'), fonts.dropcap === 'fantasy', { type: 'dropCap', value: 'fantasy' }),
          radio(t('Sci-Fi'), fonts.dropcap === 'scifi', { type: 'dropCap', value: 'scifi' }),
          sep,
          radio(t('Off'), fonts.dropcap === 'none', { type: 'dropCap', value: 'none' })
        ]),
        sub(t('Align Paragraph'), [
          item(t('Left'), { type: 'align', value: 'left' }, { accel: MOD + (IS_MAC ? '⇧L' : 'Shift+L') }),
          item(t('Center'), { type: 'align', value: 'center' }, { accel: MOD + (IS_MAC ? '⇧C' : 'Shift+C') }),
          item(t('Right'), { type: 'align', value: 'right' }, { accel: MOD + (IS_MAC ? '⇧R' : 'Shift+R') }),
          item(t('Justify'), { type: 'align', value: 'justify' }, { accel: MOD + (IS_MAC ? '⇧J' : 'Shift+J') })
        ]),
        sep,
        item(t('Larger Text'), { type: 'fontSize', value: 1 }, { accel: MOD + '+' }),
        item(t('Smaller Text'), { type: 'fontSize', value: -1 }, { accel: MOD + '−' }),
        item(t('Reset Text Size'), { type: 'fontSize', value: 0 }, { accel: MOD + '0' }),
        sep,
        check(t('Typewriter Scrolling'), st.typewriter, { type: 'typewriter' }, { accel: MOD + (IS_MAC ? '⇧T' : 'Shift+T') }),
        sep,
        check(t('Flush Paragraph'), st.flush, { type: 'flush' }, { accel: IS_MAC ? '⇧Enter' : 'Shift+Enter' }),
        check(t('Poetry Paragraph'), st.poetry, { type: 'poetry' }, { accel: IS_MAC ? '⇧⌘Enter' : 'Ctrl+Shift+Enter' }),
        sep,
        check(t('Markdown Emphasis'), !L.markdownOff, () => ({ type: 'markdownEmphasis', checked: !!L.markdownOff }))
      ]),
      sub(t('View'), [
        item(t('Keyboard Shortcuts…'), { type: 'help' }, { accel: MOD + '/' }),
        sep,
        item(t('Full Screen'), () => window.neo.fullscreenToggle(), { accel: MOD + (IS_MAC ? '⇧F' : 'Shift+F') }),
        sub(t('Focus Mode'), [
          item(t('Cycle'), { type: 'focusCycle' }, { accel: MOD + (IS_MAC ? '⇧O' : 'Shift+O') }),
          sep,
          radio(t('Sentence'), focusNow() === 'sentence', { type: 'focus', value: 'sentence' }),
          radio(t('Paragraph'), focusNow() === 'paragraph', { type: 'focus', value: 'paragraph' }),
          radio(t('Off'), focusNow() === 'off', { type: 'focus', value: 'off' })
        ]),
        check(t('Vim Keys'), st.vim, { type: 'vim' }),
        sep,
        item(t('Timeline…'), () => hosted.openTimeline && hosted.openTimeline()),
        item(t('Mind Map…'), () => hosted.openMindMap && hosted.openMindMap()),
        item(t('Map…'), () => hosted.openMap && hosted.openMap()),
        sep,
        sub(t('Page'), [
          radio(t('Night'), L.pageTheme !== 'paper' && L.pageTheme !== 'light', { type: 'pageTheme', value: 'night' }),
          radio(t('Paper'), L.pageTheme === 'paper', { type: 'pageTheme', value: 'paper' }),
          radio(t('Light'), L.pageTheme === 'light', { type: 'pageTheme', value: 'light' })
        ]),
        check(t('Brighter Interface'), !!L.uiBright, { type: 'uiBright' }),
        sub(t('Interface Size'), [1, 1.25, 1.5, 2, 2.5, 3].map((z) => radio(z === 1 ? t('Normal') : percent(z), (L.uiZoom || 1) === z, { type: 'uiZoom', value: z }))),
        sep,
        sub(t('Language'), (config.languages || []).map((lang) => radio(lang.name, config.locale === lang.code, async () => {
          await window.neo.setUiLanguage(lang.code);
          send({ type: 'uiLanguage', value: lang.code });
        })))
      ]),
      sub(t('Help'), [
        item(t('NEO Shortcuts'), { type: 'help' }),
        sep,
        item(t('About NEO'), { type: 'about' }),
        ...(config.feedback ? [item(t('Send Feedback…'), () => hosted.openFeedback && hosted.openFeedback())] : []),
        { label: t('NEO by Hugh Howey — source and credits'), href: config.upstream },
        { label: t('The hosted edition — source'), href: config.source }
      ])
    ];
  }

  // ---------------------------------------------------------------------
  // Drawing
  // ---------------------------------------------------------------------
  const hotzone = document.createElement('div');
  hotzone.id = 'hosted-menu-hotzone';
  const bar = document.createElement('nav');
  bar.id = 'hosted-menubar';
  bar.setAttribute('aria-label', t('Menu'));
  document.body.append(hotzone, bar);

  let openMenu = null;

  function closeAll() {
    bar.querySelectorAll('.hm-open').forEach((el) => el.classList.remove('hm-open'));
    bar.classList.remove('open');
    openMenu = null;
  }
  // a choice may have changed a tick: redraw once the page has acted on it
  const rebuildSoon = () => setTimeout(() => { if (!openMenu) build(); }, 120);

  function activate(entry) {
    closeAll();
    if (entry.href) { window.open(entry.href, '_blank', 'noopener'); return; }
    const msg = typeof entry.msg === 'function' ? entry.msg() : entry.msg;
    if (msg && typeof msg === 'object') send(msg);
    rebuildSoon();
  }

  function renderItems(items, parent) {
    const list = document.createElement('ul');
    list.setAttribute('role', 'menu');
    for (const entry of items) {
      const li = document.createElement('li');
      if (entry.type === 'separator') { li.className = 'hm-sep'; li.setAttribute('role', 'separator'); list.appendChild(li); continue; }
      li.setAttribute('role', 'menuitem');
      if (entry.disabled) li.className = 'hm-disabled';
      const label = document.createElement('span');
      label.className = 'hm-label';
      label.textContent = entry.label;
      if (entry.font) label.style.fontFamily = entry.font;
      const mark = document.createElement('span');
      mark.className = 'hm-mark';
      if (entry.type === 'checkbox' || entry.type === 'radio') {
        li.setAttribute('aria-checked', String(!!entry.checked));
        mark.textContent = entry.checked ? (entry.type === 'radio' ? '●' : '✓') : '';
      }
      li.append(mark, label);
      if (entry.accel) { const a = document.createElement('span'); a.className = 'hm-accel'; a.textContent = entry.accel; li.appendChild(a); }
      if (entry.submenu) {
        li.classList.add('hm-has-sub');
        li.setAttribute('aria-haspopup', 'true');
        const chevron = document.createElement('span'); chevron.className = 'hm-chevron'; chevron.textContent = '▸';
        li.appendChild(chevron);
        renderItems(entry.submenu, li);
        // a finger cannot hover: a tap on the parent opens its flyout (and closes its siblings')
        li.addEventListener('click', (e) => {
          if (e.target.closest('ul') !== list) return; // a tap inside the flyout is the item's
          e.stopPropagation();
          const open = li.classList.contains('hm-sub-open');
          list.querySelectorAll('.hm-sub-open').forEach((el) => el.classList.remove('hm-sub-open'));
          if (!open) li.classList.add('hm-sub-open');
        });
      } else if (!entry.disabled) {
        li.tabIndex = -1;
        li.addEventListener('click', (e) => { e.stopPropagation(); activate(entry); });
      }
      list.appendChild(li);
    }
    parent.appendChild(list);
  }

  function build() {
    bar.textContent = '';
    for (const menu of template()) {
      const top = document.createElement('div');
      top.className = 'hm-top';
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'hm-title';
      button.textContent = menu.label;
      button.setAttribute('aria-haspopup', 'true');
      button.setAttribute('aria-expanded', 'false');
      top.appendChild(button);
      renderItems(menu.submenu, top);
      button.addEventListener('click', (e) => {
        e.stopPropagation();
        const wasOpen = top.classList.contains('hm-open');
        closeAll();
        if (!wasOpen) { top.classList.add('hm-open'); bar.classList.add('open'); openMenu = top; button.setAttribute('aria-expanded', 'true'); }
      });
      // like a native bar: once one menu is open, sliding across opens the others
      top.addEventListener('mouseenter', () => {
        if (openMenu && openMenu !== top) { closeAll(); top.classList.add('hm-open'); bar.classList.add('open'); openMenu = top; }
      });
      bar.appendChild(top);
    }
  }

  // ticks are read fresh each time the pointer comes to the bar (before any
  // click, so the button being pressed is never swapped out from under it)
  // and again after a choice closes the menus
  // (not on a touch screen: a tap's compatibility mouseenter would rebuild the
  // bar under the finger, and the click would land on a button already gone)
  const NO_HOVER = !!(window.matchMedia && window.matchMedia('(hover: none)').matches);
  for (const el of [hotzone, bar]) el.addEventListener('mouseenter', () => { if (!openMenu && !NO_HOVER) build(); });
  document.addEventListener('click', (e) => { if (!bar.contains(e.target)) closeAll(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && openMenu) { e.stopPropagation(); closeAll(); return; }
    // Alt or F10 alone brings the bar for the keyboard, as on Windows and Linux
    if ((e.key === 'F10' || (e.key === 'Alt' && !e.ctrlKey && !e.metaKey)) && !openMenu) {
      if (e.key === 'Alt') return; // the keyup decides, so Alt+something keeps its meaning
      e.preventDefault();
      build();
      bar.classList.add('open');
      bar.querySelector('.hm-title').focus();
    }
  });
  let altAlone = false;
  document.addEventListener('keydown', (e) => { altAlone = e.key === 'Alt'; }, true);
  document.addEventListener('keyup', (e) => {
    if (e.key !== 'Alt' || !altAlone) return;
    altAlone = false;
    if (openMenu || bar.classList.contains('open')) { closeAll(); return; }
    build();
    bar.classList.add('open');
    bar.querySelector('.hm-title').focus();
  });
  bar.addEventListener('focusout', () => { setTimeout(() => { if (!bar.contains(document.activeElement) && !openMenu) bar.classList.remove('open'); }, 0); });

  // for a screen with nothing to hover (web-mobile.js draws the button)
  hosted.menu = {
    isOpen: () => bar.classList.contains('open'),
    open: () => { build(); bar.classList.add('open'); },
    close: closeAll,
    toggle: () => { if (bar.classList.contains('open')) closeAll(); else hosted.menu.open(); }
  };

  // ---------------------------------------------------------------------
  // Accelerators the native menu used to catch. app.js already handles
  // ⌘; ⌘+ ⌘− and ⌘/ inside the editor by character, so those stay out
  // of this table (one press, one action).
  // ---------------------------------------------------------------------
  const ACCELERATORS = [
    { code: 'KeyE', shift: false, msg: { type: 'emailDraft' } },
    { code: 'Comma', shift: false, msg: { type: 'stats' } },
    { code: 'KeyF', shift: false, msg: { type: 'find' } },
    { code: 'Digit0', shift: false, msg: { type: 'fontSize', value: 0 } },
    { code: 'KeyI', shift: true, msg: { type: 'import' } },
    { code: 'KeyL', shift: true, msg: { type: 'align', value: 'left' } },
    { code: 'KeyC', shift: true, msg: { type: 'align', value: 'center' } },
    { code: 'KeyR', shift: true, msg: { type: 'align', value: 'right' } },
    { code: 'KeyJ', shift: true, msg: { type: 'align', value: 'justify' } },
    { code: 'KeyT', shift: true, msg: { type: 'typewriter' } },
    { code: 'KeyO', shift: true, msg: { type: 'focusCycle' } },
    { code: 'KeyF', shift: true, action: () => window.neo.fullscreenToggle() }
  ];
  document.addEventListener('keydown', (e) => {
    if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
    const hit = ACCELERATORS.find((a) => a.code === e.code && a.shift === e.shiftKey);
    if (!hit) return;
    e.preventDefault();
    if (hit.action) hit.action(); else send(hit.msg);
  }, true);

  build();
})();
