// ==UserScript==
// @name         Aucfree Yahoo Auction Image Restorer
// @namespace    https://aucfree.com/
// @version      1.0.0
// @description  Restore missing Aucfree item images from the matching Yahoo! Auctions page.
// @match        https://aucfree.com/*
// @match        https://www.aucfree.com/*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @connect      page.auctions.yahoo.co.jp
// @connect      auctions.yahoo.co.jp
// ==/UserScript==

(() => {
  'use strict';
  const missingText = /画像の登録がありません|画像がありません|no\s*image/i;
  const itemPath = /\/items\/([a-z0-9]+)(?:\/|$)/i;
  const cache = new Map(), pending = new Map(), queue = [];
  let active = 0;

  const idFrom = (url) => { try { return new URL(url, location.href).pathname.match(itemPath)?.[1] || null; } catch { return null; } };
  const isMissing = (img) => {
    if (img.dataset.aucfreeLoading === '1') return true;
    const src = `${img.getAttribute('src') || ''} ${img.getAttribute('data-src') || ''}`;
    const context = `${img.alt || ''} ${img.title || ''} ${img.parentElement?.textContent || ''}`;
    return missingText.test(src) || missingText.test(context) || /no[_-]?image|noimage|placeholder/i.test(src);
  };

  function extractImages(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html'), values = [];
    doc.querySelectorAll('meta[property="og:image"],meta[name="twitter:image"]').forEach(e => { if (e.content) values.push(e.content); });
    doc.querySelectorAll('img,source').forEach(e => ['src','data-src','data-original','srcset'].forEach(a => {
      const v = e.getAttribute(a); if (v) values.push(...v.split(',').map(x => x.trim().split(/\s+/)[0]));
    }));
    const raw = html.replace(/\\u002[fF]/g, '/').replace(/\\\//g, '/').replace(/&amp;/g, '&');
    values.push(...(raw.match(/(?:https?:)?\/\/[^"'\\\s<>]+/g) || []));
    const urls = new Set();
    for (let value of values) {
      try {
        value = value.replace(/[)\]},;]+$/, '').replace(/^\/\//, 'https://');
        const u = new URL(value, 'https://page.auctions.yahoo.co.jp'), host = u.hostname.toLowerCase();
        if (!(host.endsWith('.yimg.jp') || host.endsWith('.yahoo.co.jp'))) continue;
        if (!/(?:\/image\/|\/images?\/|\.jpe?g(?:$|\?)|\.png(?:$|\?)|\.webp(?:$|\?))/i.test(u.pathname + u.search)) continue;
        u.protocol = 'https:'; urls.add(u.href);
      } catch { /* skip malformed data */ }
    }
    return [...urls].slice(0, 1);
  }

  function pump() {
    while (active < 3 && queue.length) {
      const { id, resolve } = queue.shift(); active++;
      GM_xmlhttpRequest({ method: 'GET', url: `https://page.auctions.yahoo.co.jp/jp/auction/${encodeURIComponent(id)}`, timeout: 15000,
        onload: r => finish(id, resolve, r.status >= 200 && r.status < 400 ? extractImages(r.responseText || '') : []),
        onerror: () => finish(id, resolve, []), ontimeout: () => finish(id, resolve, []) });
    }
  }
  function finish(id, resolve, images) { cache.set(id, images); pending.delete(id); resolve(images); active--; pump(); }
  function imagesFor(id) {
    if (cache.has(id)) return Promise.resolve(cache.get(id));
    if (pending.has(id)) return pending.get(id);
    let resolve;
    const promise = new Promise(r => { resolve = r; });
    pending.set(id, promise);
    queue.push({ id, resolve });
    pump();
    return promise;
  }
  function cardFor(a) {
    let n = a;
    for (let i = 0; n && i < 6; i++, n = n.parentElement) {
      if (n.matches('article,li,[class*="item"],[class*="result"],[class*="auction"],[class*="product"]')) return n;
    }
    return a.parentElement;
  }
  function showLoading(scope) {
    [...scope.querySelectorAll('img')].filter(isMissing).forEach(img => {
      if (img.dataset.aucfreeLoading === '1') return;
      const wrapper = document.createElement('span');
      wrapper.dataset.aucfreeLoadingWrapper = '1';
      wrapper.style.cssText = 'position:relative;display:inline-flex;max-width:100%;vertical-align:middle;';
      img.parentNode.insertBefore(wrapper, img);
      wrapper.appendChild(img);
      img.dataset.aucfreeLoading = '1';
      const overlay = document.createElement('span');
      overlay.setAttribute('aria-label', '画像を読み込み中');
      overlay.setAttribute('role', 'status');
      overlay.style.cssText = 'position:absolute;inset:0;display:grid;place-items:center;background:rgba(255,255,255,.48);pointer-events:none;';
      const spinner = document.createElement('span');
      spinner.style.cssText = 'width:24px;height:24px;box-sizing:border-box;border:3px solid rgba(60,60,60,.22);border-top-color:#555;border-radius:50%;animation:aucfree-image-spin .8s linear infinite;';
      overlay.appendChild(spinner);
      wrapper.appendChild(overlay);
    });
  }
  function hideLoading(img) {
    delete img.dataset.aucfreeLoading;
    const wrapper = img.parentElement;
    if (wrapper?.dataset.aucfreeLoadingWrapper === '1') {
      wrapper.parentNode.insertBefore(img, wrapper);
      wrapper.remove();
    }
  }
  function thumbnailUrl(imageUrl) {
    const image = new URL(imageUrl);
    return `https://auc-pctr.c.yimg.jp/i/${image.host}${image.pathname}?pri=l&w=214&h=214&up=0&nf_src=sy&nf_path=images/auc/pc/top/image/1.0.3/na_170x170.png&nf_st=200`;
  }
  function replace(scope, id, images, asThumbnail = false) {
    if (!scope.isConnected) return;
    [...scope.querySelectorAll('img')].filter(img => img.dataset.aucfreeLoading === '1' || isMissing(img)).forEach(img => {
      if (images.length) {
        const index = Number(img.dataset.aucfreeYahooIndex || 0);
        img.dataset.aucfreeYahooIndex = String(index + 1);
        img.src = asThumbnail ? thumbnailUrl(images[0]) : images[index % images.length]; img.removeAttribute('srcset'); img.removeAttribute('data-src');
        if (!img.alt || missingText.test(img.alt)) img.alt = `Yahoo!オークション ${id} の商品画像`;
        img.classList.add('aucfree-yahoo-image-restored');
      }
      hideLoading(img);
    });
  }
  function scan() {
    const detailId = location.pathname.match(itemPath)?.[1];
    if (detailId && [...document.images].some(isMissing)) {
      showLoading(document);
      imagesFor(detailId).then(xs => replace(document, detailId, xs));
    }
    for (const a of document.querySelectorAll('a[href*="/items/"]')) {
      const id = idFrom(a.href), scope = id && cardFor(a);
      if (!detailId && scope && [...scope.querySelectorAll('img')].some(isMissing)) {
        showLoading(scope);
        imagesFor(id).then(xs => replace(scope, id, xs, true));
      }
    }
  }
  let scheduled = false;
  const observer = new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => { scheduled = false; scan(); });
  });
  const spinnerStyle = document.createElement('style');
  spinnerStyle.textContent = '@keyframes aucfree-image-spin{to{transform:rotate(360deg)}}';
  document.head.appendChild(spinnerStyle);
  scan();
  observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['src','data-src','alt'] });
})();







