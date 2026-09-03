// ==UserScript==
// @name         E-Hentai Original Image Downloader
// @namespace    local.ehentai.original-downloader
// @version      2.2.0
// @description  Downloads the original image on each already-opened gallery page, then advances to the next page.
// @match        *://e-hentai.org/s/*
// @match        *://exhentai.org/s/*
// @grant        GM_download
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_addStyle
// @connect       *
// @run-at        document-start
// ==/UserScript==

(() => {
  'use strict';

  const STORAGE_KEY = 'ehentai-original-downloader-state-v1';
  const SESSION_KEY = 'ehentai-original-downloader-tab-state-v1';
  const DEFAULT_STATE = {
    running: false,
    delayMs: 2500,
    count: 0,
    lastPage: '',
    galleryId: null,
    completedPages: {},
    retriesByPage: {},
    retryPending: false,
  };

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  let executionInProgress = false;

  class PageNotReadyError extends Error {}
  class DownloadFailedError extends Error {}

  function readState() {
    try {
      const tabState = sessionStorage.getItem(SESSION_KEY);
      if (tabState) return { ...DEFAULT_STATE, ...JSON.parse(tabState) };
    } catch {
      // Fall through to Tampermonkey storage.
    }
    return { ...DEFAULT_STATE, ...GM_getValue(STORAGE_KEY, {}) };
  }

  function writeState(state) {
    try {
      // sessionStorage is synchronous and survives a same-tab page navigation.
      // It is the authoritative state for a continuous download run.
      sessionStorage.setItem(SESSION_KEY, JSON.stringify(state));
    } catch {
      // Tampermonkey storage below remains a fallback.
    }
    GM_setValue(STORAGE_KEY, state);
  }
  const cleanText = (value) => String(value || '').replace(/\s+/g, ' ').trim();

  function sanitizeSegment(value, fallback) {
    const result = cleanText(value)
      .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
      .replace(/[. ]+$/g, '')
      .slice(0, 120);
    return result || fallback;
  }

  function getOriginalLink() {
    // #i6 holds several unrelated links.  The first one is normally “Show
    // galleries with this image”, so never select it merely by position.
    return [...document.querySelectorAll('#i6 a[href], a[href]')].find((link) =>
      /\bdownload\s+original\b/i.test(cleanText(link.textContent)),
    );
  }

  function getNextLink() {
    const current = parseImagePage(location.href);
    if (current) {
      const expectedPage = current.page + 1;
      const exactNext = [...document.querySelectorAll('a[href]')].find((link) => {
        const target = parseImagePage(link.href);
        return target?.galleryId === current.galleryId && target.page === expectedPage;
      });
      if (exactNext) return exactNext;
    }

    // Fallback for a future page layout that preserves an explicit next id.
    return document.querySelector('a#next[href], #next a[href], #next[href]');
  }

  function parseImagePage(value) {
    try {
      const url = new URL(value, location.href);
      const match = url.pathname.match(/^\/s\/[^/]+\/(\d+)-(\d+)\/?$/);
      if (!match) return null;
      return { galleryId: Number(match[1]), page: Number(match[2]) };
    } catch {
      return null;
    }
  }

  function getPageCounter() {
    const match = document.body?.innerText.match(/\b(\d+)\s*\/\s*(\d+)\b/);
    return match ? { current: Number(match[1]), total: Number(match[2]) } : null;
  }

  function getDisplayedImageName() {
    const image = document.querySelector('#img');
    const possibleNames = [
      image?.getAttribute('title'),
      image?.getAttribute('alt'),
      image?.currentSrc,
      image?.src,
      document.body?.innerText,
    ];

    for (const value of possibleNames) {
      const match = String(value || '').match(/(?:^|[\s/])([^/\\\s]+?\.(?:jpe?g|png|gif|webp|avif|bmp|tiff?))\b/i);
      if (match) return match[1];
    }
    return '';
  }

  function filenameFor(url, sequence) {
    let originalName = getDisplayedImageName();
    if (!originalName) {
      try {
        const fromUrl = decodeURIComponent(new URL(url).pathname.split('/').pop() || '');
        if (/\.(?:jpe?g|png|gif|webp|avif|bmp|tiff?)$/i.test(fromUrl)) originalName = fromUrl;
      } catch {
        // Use the safe fallback below.
      }
    }

    const galleryTitle = sanitizeSegment(
      document.querySelector('#gn')?.textContent
        || document.querySelector('#gj')?.textContent
        || document.title.replace(/\s+-\s+(E-|Ex-)Hentai Galleries.*$/i, ''),
      'E-Hentai',
    );
    const page = String(sequence).padStart(4, '0');
    return `${galleryTitle}/${page} - ${sanitizeSegment(originalName, `image-${page}.jpg`)}`;
  }

  function download(url, name) {
    return new Promise((resolve, reject) => {
      GM_download({
        url,
        name,
        saveAs: false,
        onload: resolve,
        onerror: (details) => reject(new DownloadFailedError(details?.error || 'download failed')),
        ontimeout: () => reject(new DownloadFailedError('download timed out')),
      });
    });
  }

  function start() {
    const state = readState();
    const currentPage = parseImagePage(location.href);
    state.running = true;
    state.count = 0;
    state.lastPage = '';
    state.galleryId = currentPage?.galleryId ?? null;
    state.completedPages = {};
    state.retriesByPage = {};
    state.retryPending = false;
    writeState(state);
    location.reload();
  }

  function stop() {
    const state = readState();
    state.running = false;
    writeState(state);
  }

  async function waitForPageReady(expectedPage, timeoutMs = 60000) {
    const started = Date.now();
    let previousSnapshot = '';
    let stableSince = 0;
    while (Date.now() - started < timeoutMs) {
      const link = getOriginalLink();
      const image = document.querySelector('#img');
      const counter = getPageCounter();
      const isReady = link?.href
        && image?.complete
        && image.naturalWidth > 0
        && counter?.current === expectedPage;

      if (isReady) {
        // The counter, displayed image and original link must remain unchanged
        // briefly. This prevents taking the previous page's original link
        // during E-Hentai's next-page transition.
        const snapshot = `${counter.current}/${counter.total}|${image.currentSrc}|${link.href}`;
        if (snapshot !== previousSnapshot) {
          previousSnapshot = snapshot;
          stableSince = Date.now();
        } else if (Date.now() - stableSince >= 1200) {
          return { link, counter };
        }
      } else {
        previousSnapshot = '';
        stableSince = 0;
      }
      await sleep(250);
    }
    throw new PageNotReadyError(`第 ${expectedPage} 页没有在 60 秒内完成加载（原图链接、页码和显示图片未能同时稳定）。`);
  }

  function addPanel() {
    if (document.querySelector('#eh-original-downloader-panel')) return;
    const panel = document.createElement('section');
    panel.id = 'eh-original-downloader-panel';
    panel.innerHTML = `
      <strong>原图自动下载</strong>
      <span id="eh-original-downloader-status">未运行</span>
      <label>间隔 <input id="eh-original-downloader-delay" type="number" min="1000" step="500"> ms</label>
      <button id="eh-original-downloader-toggle" type="button">开始</button>
      <button id="eh-original-downloader-stop" type="button">停止</button>
    `;
    document.body.append(panel);

    const status = panel.querySelector('#eh-original-downloader-status');
    const delayInput = panel.querySelector('#eh-original-downloader-delay');
    const update = () => {
      const state = readState();
      status.textContent = state.running ? `运行中：已确认 ${state.count} 张` : `未运行：已确认 ${state.count} 张`;
      delayInput.value = state.delayMs;
    };

    delayInput.addEventListener('change', () => {
      const state = readState();
      state.delayMs = Math.max(1000, Number(delayInput.value) || DEFAULT_STATE.delayMs);
      writeState(state);
      update();
    });
    panel.querySelector('#eh-original-downloader-toggle').addEventListener('click', () => {
      start();
    });
    panel.querySelector('#eh-original-downloader-stop').addEventListener('click', () => {
      stop();
      update();
    });
    update();
  }

  async function run() {
    if (executionInProgress) return;
    const state = readState();
    if (!state.running || state.retryPending) return;
    executionInProgress = true;

    const page = parseImagePage(location.href);
    if (!page) {
      state.running = false;
      writeState(state);
      console.warn('[EH original downloader] Not on an image page; stopped.');
      executionInProgress = false;
      return;
    }

    try {
      if (state.galleryId !== null && state.galleryId !== page.galleryId) {
        throw new Error('当前页不属于本次下载的画廊，已停止以避免混入其他画廊。');
      }

      const { link: originalLink, counter } = await waitForPageReady(page.page);
      const current = readState();
      if (!current.running) return;
      if (current.galleryId !== null && current.galleryId !== page.galleryId) {
        throw new Error('画廊状态发生变化，已停止以避免重复或漏页。');
      }

      const pageKey = `${page.galleryId}-${page.page}`;
      if (current.retriesByPage?.[pageKey]) {
        const recovered = { ...current, retriesByPage: { ...current.retriesByPage } };
        delete recovered.retriesByPage[pageKey];
        writeState(recovered);
      }
      const alreadyCompleted = Boolean(current.completedPages?.[pageKey]);

      if (!alreadyCompleted) {
        // The download callback is the commit point: a page is only recorded
        // after Tampermonkey reports a successful save.
        await download(originalLink.href, filenameFor(originalLink.href, page.page));

        const committed = readState();
        if (!committed.running) return;
        committed.galleryId = page.galleryId;
        committed.completedPages = { ...(committed.completedPages || {}), [pageKey]: true };
        committed.count = Object.keys(committed.completedPages).length;
        committed.lastPage = location.href;
        writeState(committed);
      }

      const afterDownload = readState();
      if (!afterDownload.running) return;
      await sleep(Math.max(4000, afterDownload.delayMs));
      const next = getNextLink();
      if (!next?.href || next.href === location.href) {
        if (counter && counter.current < counter.total) {
          throw new Error(`已下载第 ${counter.current} 张，但没有定位到第 ${counter.current + 1} 张的右向三角链接。`);
        }
        afterDownload.running = false;
        writeState(afterDownload);
        console.info('[EH original downloader] Reached the last page; stopped.');
        return;
      }
      // Use the page's own right-triangle link rather than synthesizing a URL,
      // so any site-side navigation behavior is retained.
      next.click();
    } catch (error) {
      const failed = readState();
      const failedPage = parseImagePage(location.href);
      const isRecoverable = error instanceof PageNotReadyError || error instanceof DownloadFailedError;
      if (isRecoverable && failedPage && failed.running) {
        const pageKey = `${failedPage.galleryId}-${failedPage.page}`;
        const retryCount = (failed.retriesByPage?.[pageKey] || 0) + 1;
        failed.retriesByPage = { ...(failed.retriesByPage || {}), [pageKey]: retryCount };
        const reason = error instanceof DownloadFailedError ? '原图下载失败' : '页面未稳定加载';

        if (retryCount <= 10) {
          failed.retryPending = true;
          writeState(failed);
          console.warn(`[EH original downloader] Page ${failedPage.page}: ${reason}; refreshing for retry ${retryCount}/10.`, error.message);
          setTimeout(() => location.reload(), 3000);
          return;
        }

        failed.running = false;
        failed.retryPending = false;
        writeState(failed);
        alert(`原图自动下载已停止：第 ${failedPage.page} 页连续 10 次重试后仍然${reason}（${error.message}）。`);
        return;
      }
      failed.running = false;
      failed.retryPending = false;
      writeState(failed);
      console.error('[EH original downloader] Stopped:', error);
      alert(`原图自动下载已停止：${error.message}`);
    } finally {
      executionInProgress = false;
    }
  }

  GM_addStyle(`
    #eh-original-downloader-panel { position: fixed; right: 12px; bottom: 12px; z-index: 2147483647; display: grid; gap: 6px; padding: 10px; max-width: 210px; color: #eee; background: #242424; border: 1px solid #777; border-radius: 6px; font: 12px/1.35 system-ui, sans-serif; box-shadow: 0 2px 12px #0008; }
    #eh-original-downloader-panel strong { font-size: 13px; }
    #eh-original-downloader-panel label { display: flex; align-items: center; gap: 4px; }
    #eh-original-downloader-panel input { width: 68px; }
    #eh-original-downloader-panel button { cursor: pointer; }
  `);

  // These two entries are intentionally available from Tampermonkey's popup as
  // a fallback when a browser/extension blocks the floating page control.
  GM_registerMenuCommand('开始原图自动下载', start);
  GM_registerMenuCommand('停止原图自动下载', stop);

  const initialize = () => {
    const state = readState();
    if (state.retryPending) {
      state.retryPending = false;
      writeState(state);
    }
    addPanel();
    void run();
    // Some browser/extension combinations inject the user script before the
    // page's image controls settle. Retry once after the page is fully idle.
    setTimeout(() => void run(), 1500);
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initialize, { once: true });
  } else {
    initialize();
  }

  window.addEventListener('pageshow', () => setTimeout(() => void run(), 300));
  // A navigation may complete without firing a fresh userscript lifecycle in
  // some browser-extension combinations. The committed-page ledger prevents
  // this retry from ever downloading the same page twice.
  setInterval(() => {
    const state = readState();
    if (state.running) void run();
  }, 1000);
})();
