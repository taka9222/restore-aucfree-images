// ==UserScript==
// @name         Aucfree Yahoo Auction Image Restorer
// @namespace    https://aucfree.com/
// @version      1.1
// @description  Restore missing Aucfree item images and archive Yahoo auction images and text.
// @match        https://aucfree.com/*
// @match        https://www.aucfree.com/*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @connect      page.auctions.yahoo.co.jp
// @connect      auctions.yahoo.co.jp
// @connect      aucfree.com
// @connect      img.aucfree.com
// @connect      yimg.jp
// @connect      yahoo.co.jp
// @connect      auction-labo.com
// @connect      yafuokugazo1.but.jp
// ==/UserScript==

(() => {
  'use strict';

  const missingText = /画像の登録がありません|画像がありません|no\s*image/i;
  const itemPath = /\/items\/([a-z0-9]+)(?:\/|$)/i;
  const cachePrefix = 'aucfree-yahoo-image:';
  const dbName = 'aucfree-yahoo-image-bytes';
  const dbStore = 'images';
  const textStore = 'auction-text';
  const imageData = new Map();
  const imageRequests = new Map();
  const objectUrls = new Map();
  const pendingAuctions = new Map();
  const auctionQueue = [];
  const restoreQueuedCards = new WeakSet();
  const archiveQueuedCards = new WeakSet();
  const pendingRoots = new Set();
  const meterJobs = new Map();
  const textMeterJobs = new Map();
  const textRequests = new Map();
  const textQueue = [];
  const aucfreeTextRequests = new Map();
  const aucfreeTextQueue = [];
  const auditedTextIds = new Set();
  let activeTextRequests = 0;
  const maxActiveTextRequests = 1;
  let activeAucfreeTextRequest = false;
  let aucfreeTextPumpTimer = null;
  let lastAucfreeTextRequestAt = 0;
  const minAucfreeTextRequestInterval = 1000;
  let meterElement;
  let meterContainer;
  let cacheInspectorDialog;
  const cacheInspectorObjectUrls = [];
  let dbPromise;
  let activeAuctions = 0;
  let frameScheduled = false;
  let detailWarmScheduled = false;
  let pendingDetailWarm = null;

  const idFrom = url => {
    try { return new URL(url, location.href).pathname.match(itemPath)?.[1] || null; }
    catch { return null; }
  };
  const isMissing = img => {
    if (img.dataset.aucfreeLoading === '1') return true;
    const src = `${img.getAttribute('src') || ''} ${img.getAttribute('data-src') || ''}`;
    const text = `${img.alt || ''} ${img.title || ''}`;
    return missingText.test(src) || missingText.test(text) || /no[_-]?image|noimage|placeholder/i.test(src);
  };

  function openDb() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(dbName, 2);
        request.onupgradeneeded = () => {
          if (!request.result.objectStoreNames.contains(dbStore)) request.result.createObjectStore(dbStore, { keyPath: 'key' });
          if (!request.result.objectStoreNames.contains(textStore)) request.result.createObjectStore(textStore, { keyPath: 'id' });
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      navigator.storage?.persist?.().catch(() => {});
    }
    return dbPromise;
  }
  async function readBlob(key) {
    try {
      const db = await openDb();
      return await new Promise((resolve, reject) => {
        const request = db.transaction(dbStore, 'readonly').objectStore(dbStore).get(key);
        request.onsuccess = () => resolve(request.result?.blob || null);
        request.onerror = () => reject(request.error);
      });
    } catch { return null; }
  }
  async function readItemImageKeys(id) {
    try {
      const db = await openDb();
      const prefix = `${id}:`;
      return await new Promise((resolve, reject) => {
        const range = IDBKeyRange.bound(prefix, `${prefix}\uffff`);
        const request = db.transaction(dbStore, 'readonly').objectStore(dbStore).getAllKeys(range);
        request.onsuccess = () => resolve(new Set(request.result || []));
        request.onerror = () => reject(request.error);
      });
    } catch { return new Set(); }
  }
  async function readImageManifest(id) {
    try {
      const db = await openDb();
      return await new Promise((resolve, reject) => {
        const request = db.transaction(dbStore, 'readonly').objectStore(dbStore).get(`${id}:manifest`);
        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () => reject(request.error);
      });
    } catch { return null; }
  }
  async function writeImageManifest(id, fullSizeCount, descriptionCount) {
    try {
      const db = await openDb();
      await new Promise((resolve, reject) => {
        const request = db.transaction(dbStore, 'readwrite').objectStore(dbStore).put({
          key: `${id}:manifest`,
          formatVersion: 6,
          expectedFullSizeCount: fullSizeCount,
          expectedDescriptionCount: descriptionCount,
          updatedAt: new Date().toISOString()
        });
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
      });
      return true;
    } catch (error) {
      console.warn(`[Aucfree image cache] ${id}: expected image counts were not saved.`, error);
      return false;
    }
  }
  async function readCompleteCachedThumbnail(id) {
    const [text, keys, manifest] = await Promise.all([
      readAuctionText(id), readItemImageKeys(id), readImageManifest(id)
    ]);
    const thumbnailKey = cacheKey(id, 'thumbnail');
    if (!text || !manifest) return null;
    const { expectedFullSizeCount, expectedDescriptionCount } = manifest;
    // Old caches and malformed manifests cannot prove completeness, so they
    // must take the normal discovery path instead of being treated as complete.
    if (manifest.formatVersion !== 6 ||
        !Number.isInteger(expectedFullSizeCount) || expectedFullSizeCount < 0 ||
        !Number.isInteger(expectedDescriptionCount) || expectedDescriptionCount < 0) return null;
    if (expectedFullSizeCount === 0 && expectedDescriptionCount === 0) {
      return { noImages: true, expectedFullSizeCount, expectedDescriptionCount };
    }
    if (!keys.has(thumbnailKey)) return null;
    const fullSizesComplete = Array.from(
      { length: expectedFullSizeCount }, (_, index) => keys.has(cacheKey(id, 'full-size', index))
    ).every(Boolean);
    const descriptionsComplete = Array.from(
      { length: expectedDescriptionCount }, (_, index) => keys.has(cacheKey(id, 'item-description', index))
    ).every(Boolean);
    if (!fullSizesComplete || !descriptionsComplete) return null;
    const thumbnail = await readBlob(thumbnailKey);
    return thumbnail ? { thumbnail, expectedFullSizeCount, expectedDescriptionCount } : null;
  }
  async function writeBlob(key, blob) {
    try {
      const db = await openDb();
      await new Promise((resolve, reject) => {
        const request = db.transaction(dbStore, 'readwrite').objectStore(dbStore).put({ key, blob });
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
      });
      return true;
    } catch { return false; /* display continues from the original image URL if storage is unavailable */ }
  }
  function extractAuctionText(html, id) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const descriptionParts = [];
    for (const root of doc.querySelectorAll('#description, [id*="description" i], [class*="description" i]')) {
      const visibleText = root.innerText || root.textContent || '';
      if (visibleText.trim()) descriptionParts.push(visibleText);
      root.querySelectorAll('template').forEach(template => {
        const templateText = template.content.textContent || '';
        if (templateText.trim()) descriptionParts.push(templateText);
      });
    }
    const clean = value => value.replace(/\r/g, '').replace(/[\t\f\v ]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    const details = [...doc.querySelectorAll('dl')].map(dl => ({
      label: clean(dl.querySelector('dt')?.textContent || ''),
      value: clean(dl.querySelector('dd')?.textContent || '')
    }));
    const auctionDate = details.find(item => /終了日時|落札日時|取引日時/.test(item.label))?.value || '';
    const price = clean(doc.querySelector('.bid_price')?.textContent ||
      details.find(item => /落札価格|落札額/.test(item.label))?.value || '');
    return {
      id,
      sourceUrl: `https://auctions.yahoo.co.jp/jp/auction/${encodeURIComponent(id)}`,
      capturedAt: new Date().toISOString(),
      title: clean(doc.title || ''),
      auctionDate,
      price,
      text: clean(doc.body?.innerText || doc.body?.textContent || ''),
      descriptionText: clean(descriptionParts.join('\n\n'))
    };
  }
  async function writeAuctionText(record) {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const request = db.transaction(textStore, 'readwrite').objectStore(textStore).put(record);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }
  async function readAuctionText(id) {
    try {
      const db = await openDb();
      return await new Promise((resolve, reject) => {
        const request = db.transaction(textStore, 'readonly').objectStore(textStore).get(id);
        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () => reject(request.error);
      });
    } catch { return null; }
  }
  function pumpAucfreeTextQueue() {
    if (activeAucfreeTextRequest || aucfreeTextPumpTimer || !aucfreeTextQueue.length) return;
    const wait = Math.max(0, lastAucfreeTextRequestAt + minAucfreeTextRequestInterval - Date.now());
    aucfreeTextPumpTimer = setTimeout(() => {
      aucfreeTextPumpTimer = null;
      if (activeAucfreeTextRequest || !aucfreeTextQueue.length) return;
      const { id, resolve } = aucfreeTextQueue.shift();
      activeAucfreeTextRequest = true;
      lastAucfreeTextRequestAt = Date.now();
      let settled = false;
      const finish = saved => {
        if (settled) return;
        settled = true;
        activeAucfreeTextRequest = false;
        resolve(saved);
        pumpAucfreeTextQueue();
      };
      console.info(`[Aucfree text archive] ${id}: fetching Aucfree fallback (one request at a time; minimum ${minAucfreeTextRequestInterval} ms interval).`);
      GM_xmlhttpRequest({
        method: 'GET',
        url: `https://aucfree.com/items/${encodeURIComponent(id)}`,
        timeout: 10000,
        onload: async response => {
          if (response.status < 200 || response.status >= 400) {
            console.warn(`[Aucfree text archive] ${id}: Aucfree fallback returned HTTP ${response.status}.`);
            finish(false);
            return;
          }
          try {
            const html = response.responseText || '';
            let textSaved = false;
            if (!await readAuctionText(id)) {
              const record = extractAuctionText(html, id);
              record.sourceUrl = `https://aucfree.com/items/${encodeURIComponent(id)}`;
              await writeAuctionText(record);
              textSaved = true;
              console.info(`[Aucfree text archive] ${id}: saved text from Aucfree fallback.`);
            }
            let images = extractAucfreeImages(html, id);
            if (images.gallery.length || images.description.length) {
              storeImages(id, images);
              createCacheMeter();
              images = await warmImageCache(id, images, false, true);
              storeImages(id, images);
              if (images.gallery[0]) {
                const firstImage = await readBlob(cacheKey(id, 'full-size', 0));
                if (firstImage) await writeBlob(cacheKey(id, 'thumbnail'), firstImage);
              }
              console.info(`[Aucfree image restorer] ${id}: confirmed ${images.gallery.length} sequential gallery images and ${images.description.length} description images on Aucfree.`);
            } else {
              await writeImageManifest(id, 0, 0);
              console.info(`[Aucfree image restorer] ${id}: no item images found on Aucfree.`);
            }
            finish({ ok: true, textSaved, images });
          } catch (error) {
            console.warn(`[Aucfree text archive] ${id}: Aucfree fallback text was not saved.`, error);
            finish(false);
          }
        },
        onerror: () => finish({ ok: false, textSaved: false, images: null }),
        ontimeout: () => finish({ ok: false, textSaved: false, images: null })
      });
    }, wait);
  }
  function enqueueAucfreeText(id) {
    if (aucfreeTextRequests.has(id)) return aucfreeTextRequests.get(id);
    const promise = new Promise(resolve => {
      aucfreeTextQueue.push({ id, resolve });
      pumpAucfreeTextQueue();
    }).finally(() => aucfreeTextRequests.delete(id));
    aucfreeTextRequests.set(id, promise);
    return promise;
  }
  function pumpTextQueue() {
    while (activeTextRequests < maxActiveTextRequests && textQueue.length) {
      const task = textQueue.shift();
      const { id, resolve } = task;
      activeTextRequests++;
      let settled = false;
      const finish = result => {
        if (settled) return;
        settled = true;
        activeTextRequests--;
        resolve(result);
        pumpTextQueue();
      };
      const fallbackToAucfree = reason => {
        console.info(`[Aucfree text archive] ${id}: Yahoo text unavailable (${reason}); using Aucfree fallback.`);
        void enqueueAucfreeText(id).then(result => finish(Boolean(result?.textSaved)), () => finish(false));
      };
      const requestText = () => GM_xmlhttpRequest({
          method: 'GET',
          url: `https://auctions.yahoo.co.jp/jp/auction/${encodeURIComponent(id)}`,
          timeout: 6000,
          onload: async response => {
            if (response.status < 200 || response.status >= 400) { fallbackToAucfree(`HTTP ${response.status}`); return; }
            try {
              await writeAuctionText(extractAuctionText(response.responseText || '', id));
              finish(true);
            } catch (error) {
              console.warn(`[Aucfree text archive] ${id} was not saved.`, error);
              finish(false);
            }
          },
          onerror: () => fallbackToAucfree('network error'),
          ontimeout: () => fallbackToAucfree('timeout after 6000 ms')
        });
      // Recheck at dequeue time: another path may have filled the cache while
      // this item waited in the text queue. If present, skip the network fetch.
      void readAuctionText(id).then(cached => {
        if (cached) {
          console.info(`[Aucfree text archive] ${id}: auction-text cache hit before request; skipping Yahoo fetch.`);
          finish(true);
        } else {
          console.info(`[Aucfree text archive] ${id}: auction-text cache miss; fetching Yahoo (6000 ms timeout).`);
          requestText();
        }
      }).catch(requestText);
    }
  }
  function ensureAuctionText(id, fallbackOnly = false) {
    if (textRequests.has(id)) return textRequests.get(id);
    setTextJobStatus(id, 'pending');
    const promise = (async () => {
      if (await readAuctionText(id)) {
        console.info(`[Aucfree text archive] ${id}: auction-text cache hit; skipping Yahoo fetch.`);
        setTextJobStatus(id, 'saved');
        return true;
      }
      let saved;
      if (fallbackOnly) {
        const result = await enqueueAucfreeText(id);
        saved = Boolean(result?.textSaved || await readAuctionText(id));
      } else {
        saved = await new Promise(resolve => {
          textQueue.push({ id, resolve });
          pumpTextQueue();
        });
      }
      setTextJobStatus(id, saved ? 'saved' : 'failed');
      return saved;
    })().catch(error => {
      setTextJobStatus(id, 'failed');
      console.warn(`[Aucfree text archive] ${id} could not be checked.`, error);
      return false;
    }).finally(() => {
      if (textRequests.get(id) === promise) textRequests.delete(id);
    });
    textRequests.set(id, promise);
    return promise;
  }
  function auditAuctionTextCache(id) {
    if (auditedTextIds.has(id)) return;
    auditedTextIds.add(id);
    void readAuctionText(id).then(record => {
      if (record) {
        console.info(`[Aucfree text archive] ${id}: auction-text cache hit (listing audit).`);
      } else {
        console.info(`[Aucfree text archive] ${id}: auction-text cache miss (listing audit); Yahoo lookup waits until this item is processed.`);
      }
    });
  }
  function saveAuctionTextFromHtml(html, id) {
    const promise = writeAuctionText(extractAuctionText(html, id)).catch(error => {
      console.warn(`[Aucfree text archive] ${id} was not saved.`, error);
      return false;
    }).finally(() => {
      if (textRequests.get(id) === promise) textRequests.delete(id);
    });
    textRequests.set(id, promise);
    return promise;
  }
  function downloadBlob(url, id) {
    const imageHost = new URL(url).hostname.toLowerCase();
    const headers = imageHost === 'img.aucfree.com'
      ? { Referer: `https://aucfree.com/items/${encodeURIComponent(id)}` }
      : undefined;
    return new Promise((resolve, reject) => GM_xmlhttpRequest({
      method: 'GET', url, responseType: 'blob', timeout: 20000,
      ...(headers ? { headers } : {}),
      onload: async response => {
        const data = response.response;
        let blob = null;
        if (data && typeof data.slice === 'function' && typeof data.size === 'number') {
          blob = data;
        } else if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
          const mime = /content-type:\s*([^\r\n]+)/i.exec(response.responseHeaders || '')?.[1] || 'application/octet-stream';
          blob = new Blob([data], { type: mime });
        }
        if (!blob) { reject(new Error('Image response was not a Blob or byte buffer')); return; }
        // The Aucfree CDN may answer a missing image with an XML AccessDenied
        // document, including on a successful HTTP response. Treat that as an
        // explicit negative image result rather than caching/counting the XML.
        const contentType = `${blob.type} ${response.responseHeaders || ''}`;
        const prefix = await blob.slice(0, 2048).text();
        if ((/xml|text\//i.test(contentType) || /^\s*<\?xml|^\s*<Error[>\s]/i.test(prefix)) &&
            (/<Code>\s*AccessDenied\s*<\/Code>/i.test(prefix) || /<Error>[^]*<\/Error>/i.test(prefix))) {
          const error = new Error('Image URL returned an AccessDenied XML error');
          error.status = response.status;
          error.missingImage = true;
          reject(error);
          return;
        }
        if (response.status < 200 || response.status >= 300) {
          const error = new Error(`Image request failed: ${response.status}`);
          error.status = response.status;
          reject(error);
          return;
        }
        resolve(blob);
      },
      onerror: reject,
      ontimeout: reject
    }));
  }
  function cacheKey(id, kind, index = 0) {
    if (kind === 'item-description') return `${id}:item-description:${index}`;
    if (kind === 'thumbnail') return `${id}:thumbnail`;
    return `${id}:full-size:${index}`;
  }
  function thumbnailUrl(url) {
    const image = new URL(url);
    if (!image.hostname.endsWith('.yimg.jp') && !image.hostname.endsWith('.yahoo.co.jp')) return image.href;
    return `https://auc-pctr.c.yimg.jp/i/${image.host}${image.pathname}?pri=l&w=214&h=214&up=0&nf_src=sy&nf_path=images/auc/pc/top/image/1.0.3/na_170x170.png&nf_st=200`;
  }
  function getBlob(id, url, kind, index = 0) {
    const key = cacheKey(id, kind, index);
    if (!imageRequests.has(key)) {
      const requestUrl = kind === 'thumbnail' ? thumbnailUrl(url) : url;
      const promise = (async () => {
        let blob = await readBlob(key);
        if (!blob) {
          blob = await downloadBlob(requestUrl, id);
          if (!await writeBlob(key, blob)) throw new Error('IndexedDB write failed');
        }
        return blob;
      })().finally(() => imageRequests.delete(key));
      imageRequests.set(key, promise);
    }
    return imageRequests.get(key);
  }
  function pageDescriptionImageUrls() {
    const roots = [...document.querySelectorAll('#description, [id*="description" i], [class*="description" i]')];
    const elements = new Set();
    for (const root of roots) {
      root.querySelectorAll('img,source').forEach(img => elements.add(img));
      root.querySelectorAll('template').forEach(template => template.content.querySelectorAll('img,source').forEach(img => elements.add(img)));
    }
    // Aucfree may render seller images outside a named description wrapper.
    if (!elements.size) {
      for (const img of document.images) {
        const src = img.currentSrc || img.src || '';
        try {
          const host = new URL(src, location.href).hostname.toLowerCase();
          if (host === 'yafuokugazo1.but.jp' || host.endsWith('.auction-labo.com') || host === 'auction-labo.com') elements.add(img);
        } catch { /* Ignore invalid image URLs. */ }
      }
    }
    const urls = [];
    for (const img of elements) {
      const value = img.getAttribute('src') || img.getAttribute('data-src') || img.getAttribute('data-original') || img.currentSrc || img.src;
      try {
        const url = new URL(value, location.href);
        if (!['http:', 'https:'].includes(url.protocol) || !/\.(?:jpe?g|png|webp|gif|avif)(?:$|\?)/i.test(url.pathname + url.search)) continue;
        if (url.hostname.toLowerCase() === 's.yimg.jp') continue;
        url.protocol = 'https:';
        if (!urls.includes(url.href)) urls.push(url.href);
      } catch { /* Ignore non-network image sources. */ }
    }
    return urls;
  }
  function updateCacheMeter() {
    if (!meterElement) return;
    const count = jobs => {
      let saved = 0, pending = 0, failed = 0;
      for (const job of jobs.values()) {
        if (job.status === 'saved') saved++;
        else if (job.status === 'pending') pending++;
        else if (job.status === 'failed') failed++;
      }
      return { saved, pending, failed, total: jobs.size };
    };
    const images = count(meterJobs);
    const texts = count(textMeterJobs);
    for (const [kind, stats] of [['image', images], ['text', texts]]) {
      const fill = meterElement.querySelector(`[data-meter-${kind}-fill]`);
      const summary = meterElement.querySelector(`[data-meter-${kind}-summary]`);
      const detail = meterElement.querySelector(`[data-meter-${kind}-detail]`);
      fill.style.width = `${stats.total ? Math.round(stats.saved / stats.total * 100) : 0}%`;
      summary.textContent = `${stats.saved} / ${stats.total} 保存済み`;
      detail.textContent = `処理中 ${stats.pending}　失敗 ${stats.failed}`;
    }
    meterElement.setAttribute('aria-label', `画像 保存済み ${images.saved}/${images.total}、処理中 ${images.pending}、失敗 ${images.failed}。テキスト 保存済み ${texts.saved}/${texts.total}、処理中 ${texts.pending}、失敗 ${texts.failed}`);
  }
  function setTextJobStatus(id, status) {
    if (status === 'failed') {
      // A failed request/write is not proof that the text is absent. Reconcile
      // the meter with the durable store before showing a failure.
      void readAuctionText(id).then(record => {
        if (record) {
          setTextJobStatus(id, 'saved');
          return;
        }
        const job = textMeterJobs.get(id) || { status: 'pending' };
        if (job.status !== 'saved') {
          job.status = 'failed';
          textMeterJobs.set(id, job);
          updateCacheMeter();
        }
      });
      return;
    }
    const job = textMeterJobs.get(id) || { status: 'pending' };
    // Several paths can check or save the same auction concurrently. Once any
    // path confirms a stored record, a late failure from another path must not
    // downgrade the page meter to "failed".
    if (job.status === 'saved' && status !== 'saved') return;
    job.status = status;
    textMeterJobs.set(id, job);
    updateCacheMeter();
  }
  function createCacheMeter() {
    if (meterElement || !document.body) return;
    meterContainer = document.createElement('div');
    meterContainer.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:2147483647;width:250px;display:flex;flex-direction:column;gap:7px;';
    const inspectButton = document.createElement('button');
    inspectButton.type = 'button';
    inspectButton.textContent = 'キャッシュデータを確認';
    inspectButton.style.cssText = 'align-self:flex-end;padding:6px 10px;border:1px solid #777;border-radius:6px;background:#fff;color:#222;font:12px sans-serif;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.18);';
    inspectButton.addEventListener('click', openCacheInspector);
    meterElement = document.createElement('section');
    meterElement.style.cssText = 'box-sizing:border-box;width:100%;padding:10px 12px;border:1px solid #888;border-radius:8px;background:rgba(255,255,255,.96);box-shadow:0 2px 10px rgba(0,0,0,.2);color:#222;font:12px/1.4 sans-serif;';
    meterElement.innerHTML = '<div style="font-weight:700;margin-bottom:7px">このページのキャッシュ進捗</div><div>画像 <span data-meter-image-summary>0 / 0 保存済み</span></div><div style="height:6px;margin:4px 0;background:#e5e5e5;border-radius:5px;overflow:hidden"><div data-meter-image-fill style="height:100%;width:0;background:#238636;transition:width .2s"></div></div><div data-meter-image-detail style="color:#555;margin-bottom:7px">処理中 0　失敗 0</div><div>テキスト <span data-meter-text-summary>0 / 0 保存済み</span></div><div style="height:6px;margin:4px 0;background:#e5e5e5;border-radius:5px;overflow:hidden"><div data-meter-text-fill style="height:100%;width:0;background:#0969da;transition:width .2s"></div></div><div data-meter-text-detail style="color:#555">処理中 0　失敗 0</div>';
    meterContainer.append(inspectButton, meterElement);
    document.body.append(meterContainer);
    updateCacheMeter();
  }
  function revokeCacheInspectorUrls() {
    while (cacheInspectorObjectUrls.length) URL.revokeObjectURL(cacheInspectorObjectUrls.pop());
  }
  function createCacheInspectorDialog() {
    if (cacheInspectorDialog) return cacheInspectorDialog;
    const dialog = document.createElement('dialog');
    dialog.style.cssText = 'width:min(760px,calc(100vw - 32px));max-width:760px;max-height:88vh;padding:0;border:1px solid #777;border-radius:10px;color:#222;box-shadow:0 8px 36px rgba(0,0,0,.35);font:14px/1.5 sans-serif;';
    dialog.innerHTML = '<div style="position:sticky;top:0;z-index:1;display:flex;align-items:center;justify-content:space-between;padding:12px 16px;background:#f5f5f5;border-bottom:1px solid #ddd"><strong>商品キャッシュの確認</strong><button type="button" data-inspector-close aria-label="閉じる" style="font-size:20px;border:0;background:transparent;cursor:pointer">×</button></div><form data-inspector-form style="display:flex;gap:8px;padding:12px 16px"><input data-inspector-id type="text" required autocomplete="off" placeholder="商品ID または https://aucfree.com/items/商品ID" style="flex:1;min-width:0;padding:8px;border:1px solid #999;border-radius:5px"><button type="submit" style="padding:8px 14px;border:1px solid #555;border-radius:5px;background:#fff;cursor:pointer">表示</button></form><div data-inspector-status role="status" style="padding:0 16px;color:#555"></div><div data-inspector-result style="padding:0 16px 16px;overflow-wrap:anywhere"></div>';
    dialog.addEventListener('close', revokeCacheInspectorUrls);
    dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
    dialog.querySelector('[data-inspector-close]').addEventListener('click', () => dialog.close());
    dialog.querySelector('[data-inspector-form]').addEventListener('submit', event => {
      event.preventDefault();
      void showCachedAuction(dialog, dialog.querySelector('[data-inspector-id]').value);
    });
    document.body.append(dialog);
    cacheInspectorDialog = dialog;
    return dialog;
  }
  function normalizeInspectorId(input) {
    const value = input.trim();
    if (/^https?:\/\//i.test(value)) {
      try {
        const url = new URL(value);
        if (!/(^|\.)aucfree\.com$/i.test(url.hostname)) return null;
        return url.pathname.match(itemPath)?.[1] || null;
      } catch { return null; }
    }
    const id = value.replace(/^\/+|\/+$/g, '');
    return /^[a-z0-9]+$/i.test(id) ? id : null;
  }
  function appendInspectorField(parent, label, value) {
    const row = document.createElement('div');
    row.style.cssText = 'margin:4px 0;';
    const strong = document.createElement('strong');
    strong.textContent = `${label}：`;
    row.append(strong, document.createTextNode(value || '（キャッシュなし）'));
    parent.append(row);
  }
  async function showCachedAuction(dialog, input) {
    const id = normalizeInspectorId(input);
    const status = dialog.querySelector('[data-inspector-status]');
    const result = dialog.querySelector('[data-inspector-result]');
    revokeCacheInspectorUrls();
    result.replaceChildren();
    if (!id) {
      status.textContent = '商品IDまたはaucfree.com/items/商品ID形式で入力してください。';
      return;
    }
    status.textContent = `${id} のキャッシュを読み込み中…`;
    try {
      const [record, manifest, keys] = await Promise.all([
        readAuctionText(id), readImageManifest(id), readItemImageKeys(id)
      ]);
      const heading = document.createElement('h2');
      heading.style.cssText = 'font-size:17px;margin:4px 0 10px;';
      heading.textContent = record?.title || `商品 ${id}`;
      result.append(heading);
      const source = document.createElement('div');
      source.style.cssText = 'font-size:12px;color:#666;margin-bottom:10px;';
      source.textContent = record?.sourceUrl || `https://aucfree.com/items/${id}`;
      result.append(source);
      const text = record?.text || '';
      const dateFromText = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean).find(line => /^(終了日時|落札日時|取引日時)\s*[:：]?/.test(line));
      const priceFromText = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean).find(line => /^(落札価格|落札額)\s*[:：]?/.test(line));
      appendInspectorField(result, '取引日時', record?.auctionDate || (dateFromText ? dateFromText.replace(/^(終了日時|落札日時|取引日時)\s*[:：]?\s*/, '') : ''));
      appendInspectorField(result, '価格', record?.price || (priceFromText ? priceFromText.replace(/^(落札価格|落札額)\s*[:：]?\s*/, '') : ''));
      const imageSection = document.createElement('section');
      imageSection.style.cssText = 'margin-top:14px;';
      const imageTitle = document.createElement('h3');
      imageTitle.style.cssText = 'font-size:15px;margin:8px 0;';
      const fullSizeKeys = [...keys].map(String).map(key => ({ key, match: key.match(new RegExp(`^${id}:full-size:(\\d+)$`)) })).filter(item => item.match).sort((a,b) => Number(a.match[1]) - Number(b.match[1]));
      const expected = Number.isInteger(manifest?.expectedFullSizeCount) ? manifest.expectedFullSizeCount : null;
      imageTitle.textContent = `Full-size 画像（保存済み ${fullSizeKeys.length}${expected === null ? '' : ` / 想定 ${expected}`}）`;
      imageSection.append(imageTitle);
      if (!fullSizeKeys.length) {
        const empty = document.createElement('div');
        empty.textContent = 'Full-size画像のキャッシュはありません。';
        imageSection.append(empty);
      }
      for (const entry of fullSizeKeys) {
        const blob = await readBlob(entry.key);
        if (!blob) continue;
        const index = Number(entry.match[1]);
        const figure = document.createElement('figure');
        figure.style.cssText = 'display:inline-flex;flex-direction:column;vertical-align:top;width:min(220px,45%);margin:4px 8px 8px 0;';
        const image = document.createElement('img');
        const objectUrl = URL.createObjectURL(blob);
        cacheInspectorObjectUrls.push(objectUrl);
        image.src = objectUrl;
        image.alt = `${id} full-size ${index + 1}`;
        image.style.cssText = 'width:100%;max-height:260px;object-fit:contain;border:1px solid #ddd;background:#fafafa;';
        const caption = document.createElement('figcaption');
        caption.textContent = `画像 ${index + 1}`;
        figure.append(image, caption);
        imageSection.append(figure);
      }
      result.append(imageSection);
      const descriptionTitle = document.createElement('h3');
      descriptionTitle.style.cssText = 'font-size:15px;margin:14px 0 6px;';
      descriptionTitle.textContent = '商品紹介文';
      result.append(descriptionTitle);
      const description = document.createElement('pre');
      description.style.cssText = 'white-space:pre-wrap;overflow-wrap:anywhere;margin:0;padding:10px;border:1px solid #ddd;border-radius:5px;background:#fafafa;font:13px/1.5 sans-serif;max-height:260px;overflow:auto;';
      description.textContent = record?.descriptionText || '商品紹介文のキャッシュはありません。';
      result.append(description);
      status.textContent = record ? 'キャッシュ内容を表示しています。' : 'auction-textのキャッシュはありません。画像キャッシュがあれば続けて表示します。';
    } catch (error) {
      status.textContent = `キャッシュの読み込みに失敗しました: ${error?.message || error}`;
    }
  }
  function openCacheInspector() {
    const dialog = createCacheInspectorDialog();
    const input = dialog.querySelector('[data-inspector-id]');
    if (!dialog.open) dialog.showModal();
    input.focus();
  }
  function trackCacheJob(id, job) {
    const key = cacheKey(id, job.kind, job.index);
    let record = meterJobs.get(key);
    if (record?.status === 'saved') return Promise.resolve({ saved: true, missing: false, accessDenied: false });
    if (record?.promise) return record.promise;
    record = record || { status: 'pending', promise: null };
    record.status = 'pending';
    record.promise = getBlob(id, job.url, job.kind, job.index).then(() => {
      record.status = 'saved';
      return { saved: true, missing: false };
    }).catch(error => {
      record.status = 'failed';
      console.warn(`[Aucfree image cache] ${key} (${job.url}) was not saved.`, error);
      return { saved: false, missing: error?.status === 404 || error?.status === 410, accessDenied: error?.missingImage === true };
    }).finally(() => {
      record.promise = null;
      updateCacheMeter();
    });
    meterJobs.set(key, record);
    updateCacheMeter();
    return record.promise;
  }

  async function warmImageCache(id, images, usePageDescription = false, confirmMissingAsNoImages = false) {
    const pageDescription = usePageDescription ? pageDescriptionImageUrls() : [];
    const descriptionUrls = pageDescription.length ? pageDescription : (images.description || []);
    const galleryUrls = images.gallery || [];
    const jobs = [
      ...galleryUrls.map((url, index) => ({ url, kind: 'full-size', index })),
      ...descriptionUrls.map((url, index) => ({ url, kind: 'item-description', index }))
    ];
    // Serialize per item so long galleries do not create a burst of requests.
    createCacheMeter();
    await writeImageManifest(id, galleryUrls.length, descriptionUrls.length);
    let confirmedGalleryCount = null;
    for (const job of jobs) {
      if (job.kind === 'full-size' && confirmedGalleryCount !== null) continue;
      const result = await trackCacheJob(id, job);
      if (confirmMissingAsNoImages && job.kind === 'full-size' &&
          (result?.missing || result?.accessDenied)) {
        // Aucfree's gallery URLs are predictable and contiguous: .1.jpg, .2.jpg,
        // .3.jpg. A real image response is cached by trackCacheJob; the first
        // 404/410 or AccessDenied XML ends the sequence.
        confirmedGalleryCount = job.index;
      }
    }
    if (confirmMissingAsNoImages && confirmedGalleryCount !== null) {
      const confirmedGallery = galleryUrls.slice(0, confirmedGalleryCount);
      await writeImageManifest(id, confirmedGallery.length, descriptionUrls.length);
      console.info(`[Aucfree image restorer] ${id}: confirmed ${confirmedGallery.length} gallery images before the first missing image URL.`);
      return {
        gallery: confirmedGallery,
        description: descriptionUrls,
        confirmedNoImages: confirmedGallery.length === 0 && descriptionUrls.length === 0
      };
    }
    return { ...images, gallery: galleryUrls, description: descriptionUrls, confirmedNoImages: false };
  }
  function displayImage(img, id, url, kind, index = 0) {
    if (!url) { hideLoading(img); return; }
    const originalUrl = kind === 'thumbnail' ? thumbnailUrl(url) : url;
    img.removeAttribute('srcset');
    img.removeAttribute('data-src');
    if (!img.alt || missingText.test(img.alt)) img.alt = `Yahoo!オークション ${id} の商品画像`;
    // Preserve the proven URL-based display path; cache lookup runs separately.
    img.src = originalUrl;
    img.classList.add('aucfree-yahoo-image-restored');
    hideLoading(img);
    const key = cacheKey(id, kind, index);
    if (objectUrls.has(key)) { img.src = objectUrls.get(key); return; }
    getBlob(id, url, kind, index).then(blob => {
      if (!objectUrls.has(key)) objectUrls.set(key, URL.createObjectURL(blob));
      if (img.isConnected) img.src = objectUrls.get(key);
    }).catch(() => {});
  }
  function displayCachedThumbnail(img, id, blob) {
    if (!blob) return;
    img.removeAttribute('srcset');
    img.removeAttribute('data-src');
    if (!img.alt || missingText.test(img.alt)) img.alt = `Yahoo!オークション ${id} の商品画像`;
    const key = cacheKey(id, 'thumbnail');
    if (!objectUrls.has(key)) objectUrls.set(key, URL.createObjectURL(blob));
    img.src = objectUrls.get(key);
    img.classList.add('aucfree-yahoo-image-restored');
    hideLoading(img);
  }

  function extractImages(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const gallery = new Set();
    const description = new Set();
    const isYahooHost = host => host.endsWith('.yimg.jp') || host.endsWith('.yahoo.co.jp');
    function addUrl(raw, allowExternal, destination) {
      if (!raw) return;
      const value = raw.trim().replace(/[)\]},;]+$/, '').replace(/^\/\//, 'https://');
      try {
        const url = new URL(value, 'https://page.auctions.yahoo.co.jp');
        if (!['http:', 'https:'].includes(url.protocol)) return;
        if (!allowExternal && !isYahooHost(url.hostname.toLowerCase())) return;
        if (!/(?:\/image\/|\/images?\/|\.(?:jpe?g|png|webp|gif|avif)(?:$|\?))/i.test(url.pathname + url.search)) return;
        url.protocol = 'https:';
        destination.add(url.href);
      } catch { /* Ignore malformed image references. */ }
    }
    function addImageElement(element, allowExternal, destination) {
      for (const attribute of ['src', 'data-src', 'data-original', 'srcset']) {
        const value = element.getAttribute(attribute);
        if (!value) continue;
        value.split(',').forEach(part => addUrl(part.trim().split(/\s+/)[0], allowExternal, destination));
      }
    }
    function imagesIncludingTemplates(root) {
      const elements = [...root.querySelectorAll('img,source')];
      root.querySelectorAll('template').forEach(template => elements.push(...template.content.querySelectorAll('img,source')));
      return elements;
    }

    // Use only the item's non-cloned gallery slides, in data-index order.
    const slides = [...doc.querySelectorAll('.slick-track .slick-slide:not(.slick-cloned)')]
      .map((slide, order) => ({ slide, order, index: Number(slide.getAttribute('data-index')) }))
      .filter(entry => entry.slide.querySelector('[class*="image-gallery-original-size"] img, img[alt*="画像"]'))
      .sort((a, b) => (Number.isFinite(a.index) ? a.index : a.order) - (Number.isFinite(b.index) ? b.index : b.order));
    for (const { slide } of slides) {
      const img = slide.querySelector('[class*="image-gallery-original-size"] img, img[alt*="画像"]');
      if (img) addImageElement(img, false, gallery);
    }

    // Description images are kept in their own list, including template content.
    const descriptionRoot = doc.querySelector('#description');
    if (descriptionRoot) imagesIncludingTemplates(descriptionRoot).forEach(img => addImageElement(img, true, description));
    // Some saved/live Yahoo pages keep seller markup inside a template that DOMParser
    // does not expose through querySelectorAll. Read image attributes from that block too.
    if (!description.size) {
      const marker = html.search(/id=["']description["']/i);
      const templateStart = marker >= 0 ? html.indexOf('<template', marker) : -1;
      const templateEnd = templateStart >= 0 ? html.indexOf('</template>', templateStart) : -1;
      if (templateStart >= 0 && templateEnd > templateStart) {
        const sellerMarkup = html.slice(templateStart, templateEnd);
        const attrPattern = /(?:src|data-src|data-original|srcset)=["']([^"']+)["']/gi;
        for (const match of sellerMarkup.matchAll(attrPattern)) {
          match[1].split(',').forEach(part => addUrl(part.trim().split(/\s+/)[0], true, description));
        }
      }
    }

    // Safe fallback if Yahoo changes its gallery markup.
    if (!gallery.size) addUrl(doc.querySelector('meta[property="og:image"]')?.content, false, gallery);
    return { gallery: [...gallery], description: [...description] };
  }

  function extractAucfreeImages(html, id) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const gallery = new Set();
    const description = new Set();
    const isDescriptionRoot = root => root.matches('#description, [id*="description" i], [class*="description" i]');
    const isLikelyImagePath = path => /(?:\/image\/|\/images?\/|\.(?:jpe?g|png|webp|gif|avif)(?:$|\?))/i.test(path) &&
      !/(?:no[_-]?image|noimage|placeholder|logo|avatar|icon)/i.test(path);
    const addUrl = (raw, allowExternal, destination) => {
      if (!raw) return;
      const value = raw.trim().replace(/[)\]},;]+$/, '').split(/\s+/)[0];
      try {
        const url = new URL(value, 'https://aucfree.com');
        if (!['http:', 'https:'].includes(url.protocol) || !isLikelyImagePath(url.pathname)) return;
        const host = url.hostname.toLowerCase();
        if (host === 's.yimg.jp') return;
        const knownImageHost = host === 'yafuokugazo1.but.jp' || host.endsWith('.auction-labo.com') ||
          host === 'auction-labo.com' || host.endsWith('.yimg.jp') || host.endsWith('.yahoo.co.jp');
        if (!allowExternal && host !== 'aucfree.com' && !knownImageHost) return;
        url.protocol = 'https:';
        destination.add(url.href);
      } catch { /* Ignore malformed image URLs. */ }
    };
    const addElements = (root, allowExternal, destination) => {
      const elements = root.matches?.('img,source') ? [root] : [];
      elements.push(...root.querySelectorAll('img,source'));
      root.querySelectorAll('template').forEach(template => elements.push(...template.content.querySelectorAll('img,source')));
      for (const element of elements) {
        // Ignore images the restorer itself inserted on a saved/live page.
        if (element.classList.contains('aucfree-yahoo-image-restored') || element.hasAttribute('data-aucfree-gallery-index') || element.hasAttribute('data-aucfree-description-index')) continue;
        for (const attribute of ['src', 'data-src', 'data-src-original', 'data-original', 'srcset']) {
          const value = element.getAttribute(attribute);
          if (value) value.split(',').forEach(part => addUrl(part, allowExternal, destination));
        }
      }
    };

    const descriptionRoots = [...doc.querySelectorAll('#description, [id*="description" i], [class*="description" i]')];
    descriptionRoots.forEach(root => addElements(root, true, description));
    const galleryRoots = [...doc.querySelectorAll(
      '#item_imgs > li.itemimage > img.item_img, .slick-track .slick-slide:not(.slick-cloned), img.item_img, [class*="image-gallery"], [class*="item-image"], [class*="auction-image"], [class*="product-image"]'
    )].filter(root => !descriptionRoots.some(descriptionRoot => descriptionRoot.contains(root)) && !isDescriptionRoot(root));
    galleryRoots.forEach(root => addElements(root, root.matches('img.item_img'), gallery));

    // Aucfree templates and older pages may not use gallery wrappers. Fall back
    // only to recognized auction-image hosts to avoid collecting site chrome.
    if (!gallery.size) {
      for (const element of doc.querySelectorAll('img,source')) {
        if (element.classList.contains('aucfree-yahoo-image-restored') || element.hasAttribute('data-aucfree-gallery-index') || element.hasAttribute('data-aucfree-description-index')) continue;
        for (const attribute of ['src', 'data-src', 'data-src-original', 'data-original', 'srcset']) {
          const value = element.getAttribute(attribute);
          if (value) value.split(',').forEach(part => addUrl(part, false, gallery));
        }
      }
    }
    // Aucfree item photos use a contiguous, predictable URL sequence. Probe
    // the actual responses in order instead of counting DOM nodes, which may
    // include images inserted by this userscript or generic placeholder markup.
    const itemId = String(id || '').trim();
    const aucfreeGallery = /^[a-z0-9]+$/i.test(itemId)
      ? [1, 2, 3].map(index => `https://img.aucfree.com/${encodeURIComponent(itemId)}.${index}.jpg`)
      : [...gallery];
    return { gallery: aucfreeGallery, description: [...description] };
  }

  function readStoredImages(id) {
    try {
      const value = JSON.parse(localStorage.getItem(cachePrefix + id) || 'null');
      if (Array.isArray(value?.gallery) && Array.isArray(value?.description)) {
        const hasNoImages = value.gallery.length === 0 && value.description.length === 0;
        if (!hasNoImages || value.imageCacheFormatVersion === 1) return value;
        // Older negative entries were based on unreliable DOM/AccessDenied
        // checks. Recheck the predictable .1-.3 URLs once with the current logic.
        console.info(`[Aucfree image restorer] ${id}: discarding an outdated no-image cache entry and rechecking Aucfree.`);
        localStorage.removeItem(cachePrefix + id);
        return null;
      }
      if (value) localStorage.removeItem(cachePrefix + id);
    } catch { /* Storage may be disabled or contain invalid data. */ }
    return null;
  }
  function storeImages(id, images) {
    const cached = {
      ...images,
      imageCacheFormatVersion: 1,
      noImages: images.gallery.length === 0 && images.description.length === 0,
      checkedAt: new Date().toISOString()
    };
    try { localStorage.setItem(cachePrefix + id, JSON.stringify(cached)); }
    catch { /* IndexedDB remains the image-data store. */ }
  }
  function finishAuction(id, resolve, images, cacheSuccessfulResponse = false) {
    const result = images && Array.isArray(images.gallery) && Array.isArray(images.description)
      ? images : { gallery: [], description: [] };
    imageData.set(id, result);
    if (cacheSuccessfulResponse) {
      storeImages(id, result);
      if (!result.gallery.length && !result.description.length) void writeImageManifest(id, 0, 0);
    }
    pendingAuctions.delete(id);
    resolve(result);
    activeAuctions--;
    pumpAuctions();
  }
  function pumpAuctions() {
    while (activeAuctions < 16 && auctionQueue.length) {
      const { id, resolve } = auctionQueue.shift();
      activeAuctions++;
      setTextJobStatus(id, 'pending');
      void readAuctionText(id).then(cachedText => {
        if (cachedText) {
          console.info(`[Aucfree text archive] ${id}: auction-text cache hit; requesting Yahoo only for image metadata.`);
          setTextJobStatus(id, 'saved');
        } else {
          console.info(`[Aucfree text archive] ${id}: auction-text cache miss; fetching Yahoo auction page for images and text.`);
        }
        GM_xmlhttpRequest({
          method: 'GET',
          url: `https://auctions.yahoo.co.jp/jp/auction/${encodeURIComponent(id)}`,
          timeout: 8000,
          onload: async response => {
            let images = { gallery: [], description: [] };
            let cacheSuccessfulResponse = false;
            try {
              if (response.status >= 200 && response.status < 400) {
                const html = response.responseText || '';
                images = extractImages(html);
                cacheSuccessfulResponse = true;
                if (!cachedText) {
                  const saved = await saveAuctionTextFromHtml(html, id);
                  setTextJobStatus(id, saved ? 'saved' : 'failed');
                }
                if (!images.gallery.length && !images.description.length) {
                  console.info(`[Aucfree image restorer] ${id}: Yahoo page has no images; checking Aucfree fallback.`);
                  const fallback = await enqueueAucfreeText(id);
                  cacheSuccessfulResponse = Boolean(fallback?.ok);
                  if (fallback?.ok && fallback.images) {
                    images = fallback.images;
                  }
                  if (!cachedText) setTextJobStatus(id, fallback?.textSaved || await readAuctionText(id) ? 'saved' : 'failed');
                }
              }
              else {
                console.warn(`[Aucfree image restorer] Yahoo page request failed: ${response.status}`, id);
                const fallback = await enqueueAucfreeText(id);
                cacheSuccessfulResponse = Boolean(fallback?.ok);
                if (fallback?.ok && fallback.images) {
                  images = fallback.images;
                }
                if (!cachedText) setTextJobStatus(id, fallback?.textSaved || await readAuctionText(id) ? 'saved' : 'failed');
              }
            } catch (error) {
              cacheSuccessfulResponse = false;
              console.warn('[Aucfree image restorer] Yahoo image parsing failed.', error);
              const fallback = await enqueueAucfreeText(id);
              cacheSuccessfulResponse = Boolean(fallback?.ok);
              if (fallback?.ok && fallback.images) {
                images = fallback.images;
              }
              if (!cachedText) setTextJobStatus(id, fallback?.textSaved || await readAuctionText(id) ? 'saved' : 'failed');
            }
            finishAuction(id, resolve, images, cacheSuccessfulResponse);
          },
          onerror: async () => {
            const fallback = await enqueueAucfreeText(id);
            if (!cachedText) setTextJobStatus(id, fallback?.textSaved || await readAuctionText(id) ? 'saved' : 'failed');
            finishAuction(id, resolve, fallback?.ok && fallback.images ? fallback.images : { gallery: [], description: [] }, Boolean(fallback?.ok));
          },
          ontimeout: async () => {
            const fallback = await enqueueAucfreeText(id);
            if (!cachedText) setTextJobStatus(id, fallback?.textSaved || await readAuctionText(id) ? 'saved' : 'failed');
            finishAuction(id, resolve, fallback?.ok && fallback.images ? fallback.images : { gallery: [], description: [] }, Boolean(fallback?.ok));
          }
        });
      });
    }
  }
  function imagesFor(id) {
    if (imageData.has(id)) {
      void ensureAuctionText(id);
      return Promise.resolve(imageData.get(id));
    }
    const stored = readStoredImages(id);
    if (stored) {
      if (stored.noImages) {
        console.info(`[Aucfree image restorer] ${id}: confirmed no images are cached; skipping Yahoo fetch.`);
      }
      imageData.set(id, stored);
      void ensureAuctionText(id);
      return Promise.resolve(stored);
    }
    if (pendingAuctions.has(id)) return pendingAuctions.get(id);
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    pendingAuctions.set(id, promise);
    auctionQueue.push({ id, resolve });
    pumpAuctions();
    return promise;
  }

  function showLoading(img) {
    if (img.dataset.aucfreeLoading === '1' || !img.parentNode) return;
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
  }
  function hideLoading(img) {
    delete img.dataset.aucfreeLoading;
    const wrapper = img.parentElement;
    if (wrapper?.dataset.aucfreeLoadingWrapper === '1') {
      wrapper.parentNode.insertBefore(img, wrapper);
      wrapper.remove();
    }
  }
  function cardFor(node) {
    let current = node;
    for (let i = 0; current && i < 7; i++, current = current.parentElement) {
      if (current.matches?.('article,li,[class*="item"],[class*="result"],[class*="auction"],[class*="product"]')) return current;
    }
    return node.closest?.('a[href*="/items/"]')?.parentElement || node.parentElement;
  }
  function isDescriptionImage(img) {
    return Boolean(img.closest('#description, [id*="description" i], [class*="description" i]'));
  }
  function collectImages(root) {
    const images = [];
    if (root instanceof HTMLImageElement) images.push(root);
    root.querySelectorAll?.('img').forEach(img => images.push(img));
    return images;
  }
  function restoreListCard(card, id, knownMissing) {
    if (!card.isConnected) return;
    const missing = knownMissing || [...card.querySelectorAll('img')].filter(isMissing);
    missing.forEach(showLoading);
    void readCompleteCachedThumbnail(id).then(cache => {
      if (!cache) {
        imagesFor(id).then(images => {
          const thumb = images.gallery[0];
          if (thumb) missing.forEach(img => displayImage(img, id, thumb, 'thumbnail'));
          else missing.forEach(hideLoading);
          warmImageCache(id, images);
        });
        return;
      }
      if (cache.noImages) {
        console.info(`[Aucfree image restorer] ${id}: manifest expects 0 full-size and 0 description images; auction-text exists, skipping Yahoo fetch.`);
        setTextJobStatus(id, 'saved');
        missing.forEach(hideLoading);
        return;
      }
      console.info(`[Aucfree image restorer] ${id}: thumbnail, all ${cache.expectedFullSizeCount} full-size images, all ${cache.expectedDescriptionCount} description images, and auction-text are cached; skipping Yahoo fetch.`);
      setTextJobStatus(id, 'saved');
      missing.forEach(img => displayCachedThumbnail(img, id, cache.thumbnail));
    }).catch(error => {
      console.warn(`[Aucfree image restorer] ${id}: cache check failed; falling back to Yahoo fetch.`, error);
      imagesFor(id).then(images => {
        const thumb = images.gallery[0];
        if (thumb) missing.forEach(img => displayImage(img, id, thumb, 'thumbnail'));
        else missing.forEach(hideLoading);
        warmImageCache(id, images);
      });
    });
  }
  function restoreDetail(root, id, images) {
    if (!root.isConnected) return;
    const all = [...document.images].filter(img => isMissing(img) || img.classList.contains('aucfree-yahoo-image-restored'));
    const galleryTargets = all.filter(img => !isDescriptionImage(img));
    const descriptionTargets = all.filter(isDescriptionImage);
    galleryTargets.forEach((img, index) => {
      if (!/^\d+$/.test(img.dataset.aucfreeGalleryIndex || '')) img.dataset.aucfreeGalleryIndex = String(index);
    });
    descriptionTargets.forEach((img, index) => {
      if (!/^\d+$/.test(img.dataset.aucfreeDescriptionIndex || '')) img.dataset.aucfreeDescriptionIndex = String(index);
    });
    const scoped = collectImages(root);
    for (const img of scoped) {
      if (!isMissing(img)) continue;
      if (isDescriptionImage(img)) {
        const index = Number(img.dataset.aucfreeDescriptionIndex);
        displayImage(img, id, images.description[index], 'item-description', index);
      } else {
        const index = Number(img.dataset.aucfreeGalleryIndex);
        if (index < images.gallery.length) displayImage(img, id, images.gallery[index], 'full-size', index);
        else {
          const descriptionIndex = index - images.gallery.length;
          displayImage(img, id, images.description[descriptionIndex], 'item-description', descriptionIndex);
        }
      }
    }
  }

  function scheduleDetailWarm(id, images) {
    pendingDetailWarm = { id, images };
    if (detailWarmScheduled) return;
    detailWarmScheduled = true;
    requestAnimationFrame(() => {
      detailWarmScheduled = false;
      const pending = pendingDetailWarm;
      pendingDetailWarm = null;
      if (pending) warmImageCache(pending.id, pending.images, true);
    });
  }

  function scheduleRoot(root) {
    if (root instanceof Element) pendingRoots.add(root);
    if (frameScheduled) return;
    frameScheduled = true;
    requestAnimationFrame(() => {
      frameScheduled = false;
      const roots = [...pendingRoots];
      pendingRoots.clear();
      roots.forEach(scanRoot);
    });
  }
  function queueCard(card) {
    if (!card?.isConnected) return;
    const link = card.querySelector('a[href*="/items/"]');
    const id = link && idFrom(link.href);
    if (!id) return;
    const missing = [...card.querySelectorAll('img')].filter(isMissing);
    auditAuctionTextCache(id);
    const needsRestore = missing.length > 0 && !restoreQueuedCards.has(card);
    const needsArchive = !archiveQueuedCards.has(card);
    if (!needsRestore && !needsArchive) return;
    if (needsRestore) restoreQueuedCards.add(card);
    if (needsArchive) archiveQueuedCards.add(card);
    restoreListCard(card, id, missing);
  }

  function scanRoot(root) {
    if (!(root instanceof Element || root instanceof Document)) return;
    const detailId = location.pathname.match(itemPath)?.[1];
    if (detailId) {
      const missing = collectImages(root).filter(isMissing);
      missing.forEach(showLoading);
      imagesFor(detailId).then(images => {
        if (missing.length) restoreDetail(root, detailId, images);
        scheduleDetailWarm(detailId, images);
      });
      return;
    }
    const links = [];
    if (root.matches?.('a[href*="/items/"]')) links.push(root);
    root.querySelectorAll?.('a[href*="/items/"]').forEach(link => links.push(link));
    const cards = new Set(links.map(cardFor).filter(Boolean));
    cards.forEach(queueCard);
  }

  const style = document.createElement('style');
  style.textContent = '@keyframes aucfree-image-spin{to{transform:rotate(360deg)}}';
  document.head.appendChild(style);
  createCacheMeter();
  let lastUrl = location.href;
  function runForCurrentUrl(force = false) {
    if (!force && location.href === lastUrl) return;
    lastUrl = location.href;
    const detailId = location.pathname.match(itemPath)?.[1];
    if (detailId) imagesFor(detailId).then(images => {
      restoreDetail(document, detailId, images);
      scheduleDetailWarm(detailId, images);
    });
    scanRoot(document);
  }
  runForCurrentUrl(true);
  for (const method of ['pushState', 'replaceState']) {
    const original = history[method];
    history[method] = function (...args) {
      const result = original.apply(this, args);
      queueMicrotask(() => runForCurrentUrl());
      return result;
    };
  }
  window.addEventListener('popstate', () => runForCurrentUrl());
  window.addEventListener('pageshow', () => runForCurrentUrl(true));
  setInterval(() => runForCurrentUrl(), 500);

  const observer = new MutationObserver(records => {
    for (const record of records) {
      if (record.type === 'childList') {
        record.addedNodes.forEach(node => {
          if (node instanceof Element && node.dataset.aucfreeLoadingWrapper === '1') return;
          if (node instanceof Element) scheduleRoot(node);
        });
        if (record.target instanceof Element) {
          const card = cardFor(record.target);
          if (card) scheduleRoot(card);
        }
      } else if (record.type === 'attributes' && record.target instanceof HTMLImageElement) {
        if (record.target.dataset.aucfreeLoading === '1') continue;
        const card = cardFor(record.target);
        if (card) scheduleRoot(card);
      }
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'data-src', 'alt'] });
})();









