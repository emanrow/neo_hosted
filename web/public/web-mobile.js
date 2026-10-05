/* ====================== NEO, HOSTED: ON A PHONE ====================== */
/* The desktop reveals everything by hovering an edge: the menu bar at the */
/* top, the chapters on the left, notes on the right, the bottom bar when  */
/* the pointer comes near. A finger cannot hover, so on a touch screen the */
/* menu gets a button and the panes open on edge swipes, as in NEO Pocket  */
/* (pocket/www/index.html). web.css does the rest under (hover: none).     */
/* Nothing here runs with a mouse; a laptop sees the desktop's behavior.   */

(function () {
  'use strict';

  const { t } = window.NeoI18n;
  const hosted = window.neoHosted;
  const touch = !!(window.matchMedia && window.matchMedia('(hover: none)').matches);
  if (!touch) return;
  document.body.classList.add('hosted-touch');

  // ☰ at the top left: the menu bar, which the top edge cannot reveal here
  const button = document.createElement('button');
  button.id = 'hosted-menu-button';
  button.type = 'button';
  button.setAttribute('aria-label', t('Menu'));
  button.textContent = '☰';
  button.addEventListener('click', (e) => { e.stopPropagation(); hosted.menu.toggle(); });
  document.body.appendChild(button);

  // Edge swipes stand in for the desktop's mouse-over: from the left edge
  // for chapters, from the right edge for Notes & Comments. Swiping a pane
  // back toward its edge, or tapping the page, closes it.
  const nav = document.getElementById('nav-pane');
  const side = document.getElementById('side-pane');
  const EDGE = 28;
  const PULL = 40;
  let start = null;
  document.addEventListener('touchstart', (e) => {
    const p = e.touches[0];
    start = { x: p.clientX, y: p.clientY, fromLeft: p.clientX < EDGE, fromRight: p.clientX > window.innerWidth - EDGE };
  }, { passive: true });
  document.addEventListener('touchmove', (e) => {
    if (!start) return;
    const p = e.touches[0];
    const dx = p.clientX - start.x;
    const dy = Math.abs(p.clientY - start.y);
    if (Math.abs(dx) < PULL || dy > Math.abs(dx)) return;
    if (start.fromLeft && dx > 0) nav.classList.add('open');
    else if (start.fromRight && dx < 0) side.classList.add('open');
    else if (dx < 0 && nav.classList.contains('open')) nav.classList.remove('open');
    else if (dx > 0 && side.classList.contains('open')) side.classList.remove('open');
    start = null;
  }, { passive: true });
  document.addEventListener('touchend', () => { start = null; }, { passive: true });
  document.addEventListener('click', (e) => {
    if (nav.classList.contains('open') && !nav.contains(e.target)) nav.classList.remove('open');
    if (side.classList.contains('open') && !side.contains(e.target)) side.classList.remove('open');
  });
})();
