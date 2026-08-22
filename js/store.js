/* ============================================================
 * store.js — IndexedDB 持久化 + 全局配置
 *   items  商品库（分类+标准名 → 历史单价）
 *   books  账套（店铺+月份 → 明细行）
 *   photos 照片（blob，可回溯核对）
 *   kv     配置
 * ============================================================ */
(function (g) {
  'use strict';
  const DB_NAME = 'purchase_ocr_db';
  const DB_VER = 1;
  let db = null;

  const DEFAULT_CATS = ['环绿蔬菜', '面包', '粮油', '鲜肉', '裕笙隆', '汁水', '茶粉', '包装品', '创银'];

  const DEFAULT_CFG = {
    api: { preset: '', base: '', model: '', key: '', conc: 2, maxw: 1800, proxy: '', mobileModel: '' },
    cats: DEFAULT_CATS.slice(),
    dailyCats: ['环绿蔬菜'],
    thAuto: 0.92,
    thRev: 0.85,
    tol: 0.01,
    curShop: '',
    curYm: ''
  };

  const PRESETS = {
    qwen: { base: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-vl-ocr-latest' },
    zhipu: { base: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4v-flash' },
    doubao: { base: 'https://ark.cn-beijing.volces.com/api/v3', model: 'doubao-1.5-vision-pro-32k' },
    moonshot: { base: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-32k-vision-preview' },
    stepfun: { base: 'https://api.stepfun.com/v1', model: 'step-1o-turbo-vision' },
    siliconflow: { base: 'https://api.siliconflow.cn/v1', model: 'Qwen/Qwen2.5-VL-72B-Instruct' },
    openai: { base: 'https://api.openai.com/v1', model: 'gpt-4o' },
    openrouter: { base: 'https://openrouter.ai/api/v1', model: 'qwen/qwen2.5-vl-72b-instruct' },
    ollama: { base: 'http://localhost:11434/v1', model: 'qwen2.5vl:7b' }
  };

  function open() {
    return new Promise((res, rej) => {
      if (db) return res(db);
      const rq = indexedDB.open(DB_NAME, DB_VER);
      rq.onupgradeneeded = e => {
        const d = e.target.result;
        if (!d.objectStoreNames.contains('items')) {
          const s = d.createObjectStore('items', { keyPath: 'id' });
          s.createIndex('cat', 'cat', { unique: false });
        }
        if (!d.objectStoreNames.contains('books')) {
          d.createObjectStore('books', { keyPath: 'id' });
        }
        if (!d.objectStoreNames.contains('photos')) {
          const s = d.createObjectStore('photos', { keyPath: 'id' });
          s.createIndex('book', 'book', { unique: false });
        }
        if (!d.objectStoreNames.contains('kv')) {
          d.createObjectStore('kv', { keyPath: 'k' });
        }
      };
      rq.onsuccess = e => { db = e.target.result; res(db); };
      rq.onerror = e => rej(e.target.error);
    });
  }

  function tx(store, mode) {
    return open().then(d => d.transaction(store, mode || 'readonly').objectStore(store));
  }
  function reqP(r) {
    return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  }

  const S = {
    PRESETS, DEFAULT_CATS,
    cfg: JSON.parse(JSON.stringify(DEFAULT_CFG)),

    async init() {
      await open();
      const saved = await this.kvGet('cfg');
      if (saved) this.cfg = Object.assign({}, DEFAULT_CFG, saved, { api: Object.assign({}, DEFAULT_CFG.api, saved.api || {}) });
      return this.cfg;
    },
    async saveCfg() { await this.kvSet('cfg', this.cfg); },

    async kvGet(k) { const s = await tx('kv'); const r = await reqP(s.get(k)); return r ? r.v : null; },
    async kvSet(k, v) { const s = await tx('kv', 'readwrite'); return reqP(s.put({ k, v })); },

    /* ---------- items 商品库 ---------- */
    async allItems() { const s = await tx('items'); return reqP(s.getAll()); },
    async putItem(it) { const s = await tx('items', 'readwrite'); return reqP(s.put(it)); },
    async putItems(list) {
      const d = await open();
      return new Promise((res, rej) => {
        const t = d.transaction('items', 'readwrite'), st = t.objectStore('items');
        list.forEach(x => st.put(x));
        t.oncomplete = res; t.onerror = () => rej(t.error);
      });
    },
    async delItem(id) { const s = await tx('items', 'readwrite'); return reqP(s.delete(id)); },
    async clearItems() { const s = await tx('items', 'readwrite'); return reqP(s.clear()); },

    /* ---------- books 账套 ---------- */
    async allBooks() { const s = await tx('books'); return reqP(s.getAll()); },
    async getBook(id) { const s = await tx('books'); return reqP(s.get(id)); },
    async putBook(b) { b.updatedAt = Date.now(); const s = await tx('books', 'readwrite'); return reqP(s.put(b)); },
    async delBook(id) { const s = await tx('books', 'readwrite'); return reqP(s.delete(id)); },

    bookId(shop, ym) { return shop + '@' + ym; },

    async ensureBook(shop, ym) {
      const id = this.bookId(shop, ym);
      let b = await this.getBook(id);
      if (!b) {
        b = { id, shop, ym, rows: [], createdAt: Date.now(), updatedAt: Date.now() };
        await this.putBook(b);
      }
      return b;
    },

    /* ---------- photos ---------- */
    async putPhoto(p) { const s = await tx('photos', 'readwrite'); return reqP(s.put(p)); },
    async photosOf(book) {
      const s = await tx('photos');
      return reqP(s.index('book').getAll(book));
    },
    async delPhoto(id) { const s = await tx('photos', 'readwrite'); return reqP(s.delete(id)); },

    /* ---------- 备份 ---------- */
    async dump() {
      const [items, books] = await Promise.all([this.allItems(), this.allBooks()]);
      return { v: 1, at: new Date().toISOString(), cfg: this.cfg, items, books };
    },
    async restore(data, merge) {
      if (!data || !data.items) throw new Error('备份文件格式不对');
      if (!merge) { await this.clearItems(); }
      await this.putItems(data.items || []);
      for (const b of (data.books || [])) {
        if (merge) {
          const old = await this.getBook(b.id);
          if (old) { b.rows = old.rows.concat(b.rows || []); }
        }
        await this.putBook(b);
      }
      if (data.cfg) { this.cfg = Object.assign(this.cfg, data.cfg); await this.saveCfg(); }
    },
    async wipe() {
      const d = await open();
      await new Promise((res, rej) => {
        const t = d.transaction(['items', 'books', 'photos', 'kv'], 'readwrite');
        ['items', 'books', 'photos', 'kv'].forEach(n => t.objectStore(n).clear());
        t.oncomplete = res; t.onerror = () => rej(t.error);
      });
      this.cfg = JSON.parse(JSON.stringify(DEFAULT_CFG));
    }
  };

  g.Store = S;
})(window);
