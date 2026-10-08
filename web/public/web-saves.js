/* ===================== NEO, HOSTED: DURABLE SAVES ===================== */
/* A chapter write that survives a lost answer.                            */
/*                                                                         */
/* The editor (app.js) writes a chapter and, when the write rejects, books  */
/* the words as unsaved again so the next flush tries once more. Over IPC   */
/* a rejected write never reached the disk. Over HTTP it may have: a phone  */
/* that goes to the background mid-request, a signal that drops after the   */
/* request went out, a proxy that closes the connection, all leave the     */
/* server holding the new words while the page believes it holds the old.  */
/* The next look at the server (refreshFromDisk) then finds a copy that is  */
/* neither what the page last saved nor what it has now, takes it for an   */
/* edit from another device, and lands it in a twin chapter headed "from   */
/* other device". The twin is the writer's own words, twice.               */
/*                                                                         */
/* So a chapter write here is a lane per chapter that keeps the newest     */
/* words wanted and does not give up on a transport failure: before each   */
/* retry it reads the chapter back, and words already on the server count  */
/* as saved. A newer write for the same chapter supersedes an older one    */
/* still on its way (the older words are inside the newer). Only an error  */
/* the server meant (a bad name, a refused request) rejects. While a lane  */
/* retries, the editor's own `writing` count keeps it from adopting the    */
/* server's copy, so nothing moves on the page until the words are safe.  */
/*                                                                         */
/* Pure: the transport comes in as functions, so web/test/saves.test.js    */
/* runs it in Node. web-bridge.js wires it to POST /api/chapter:write.     */

(function (root) {
  'use strict';

  /**
   * Makes a saver. `options`:
   *   wait      first pause before a retry, ms (default 2000)
   *   maxWait   the pause stops growing here, ms (default 30000)
   *   sleep     (ms) => Promise, for tests
   *   onStall   (key, attempt, error) called on every failed attempt, for a toast
 * The saver also answers `pending()` (lanes on their way) and `stalled()`
 * (lanes that failed at least once).
   *
   * `save(key, html, { send, readBack })`:
   *   send(html)  → Promise of the server's answer; rejects with err.transient
   *               === true when a retry could succeed (no connection, 5xx, 401)
   *   readBack()  → Promise of the html the server holds now
   * Resolves once the server holds `html` or a newer version of the same key.
   *
   * Gotcha: a lane never times out on its own. Words left on the page are
   * the point; the editor shows them as unsaved and keeps them there.
   */
  function createSaver(options = {}) {
    const wait = options.wait ?? 2000;
    const maxWait = options.maxWait ?? 30000;
    const sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    const onStall = options.onStall || (() => {});
    const lanes = new Map(); // key -> { wanted, send, readBack, waiters: [{ resolve, reject }], running, stalls }

    function save(key, html, transport) {
      let lane = lanes.get(key);
      if (!lane) {
        lane = { wanted: html, waiters: [], running: false, stalls: 0, ...transport };
        lanes.set(key, lane);
      } else {
        lane.wanted = html;
        lane.send = transport.send;
        lane.readBack = transport.readBack;
      }
      const promise = new Promise((resolve, reject) => lane.waiters.push({ resolve, reject }));
      if (!lane.running) run(key, lane);
      return promise;
    }

    async function run(key, lane) {
      lane.running = true;
      let pause = wait;
      let attempt = 0;
      try {
        for (;;) {
          const html = lane.wanted;
          let landed = false;
          let failure = null;
          try {
            await lane.send(html);
            landed = true;
          } catch (err) {
            failure = err;
          }
          if (!landed && failure && failure.transient) {
            // the answer was lost, or never came: the words may be there all the same
            if (lane.wanted === html) {
              try { landed = (await lane.readBack()) === html; } catch { landed = false; }
            }
          }
          if (landed) {
            if (lane.wanted !== html) continue; // newer words arrived meanwhile: send those
            settle(key, lane, (w) => w.resolve(true));
            return;
          }
          if (lane.wanted !== html) continue; // the failed version is already old news
          if (!(failure && failure.transient)) {
            settle(key, lane, (w) => w.reject(failure));
            return;
          }
          attempt++;
          lane.stalls = attempt;
          onStall(key, attempt, failure);
          await sleep(pause);
          pause = Math.min(pause * 2, maxWait);
        }
      } finally {
        lane.running = false;
      }
    }

    function settle(key, lane, each) {
      lanes.delete(key);
      for (const waiter of lane.waiters) each(waiter);
    }

    /** Chapters still on their way; `stalled` counts only those that have already failed once, the ones a closed page would lose. */
    const pending = () => lanes.size;
    const stalled = () => [...lanes.values()].filter((lane) => lane.stalls > 0).length;
    return { save, pending, stalled };
  }

  const api = { createSaver };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.neoHostedSaves = api;
})(typeof window !== 'undefined' ? window : globalThis);
