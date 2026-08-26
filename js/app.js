/* ============================================================
 * app.js — 主控与界面
 * ============================================================ */
(function (g) {
  'use strict';
  const U = g.U, S = g.Store, M = g.Matcher, IMP = g.Importer, OCR = g.OCR, EXP = g.Exporter;
  const $ = U.$, $$ = U.$$, el = U.el, esc = U.esc, toast = U.toast;

  const App = {
    book: null,          // 当前账套
    items: [],           // 商品库
    photos: [],          // 待识别照片 [{id,file,url,status,msg,source:'desktop'|'mobile'}]
    filterCat: '',
    dbFilterCat: '',
    view: 'work',
    channel: 'desktop',  // 当前上传通道：desktop / mobile

    fillCatSelect(sel, withAuto) {
      const cur = sel.value;
      sel.innerHTML = '';
      if (withAuto) sel.appendChild(el('option', { value: '', text: '自动识别（按品名推断）' }));
      (S.cfg.cats || []).forEach(c => sel.appendChild(el('option', { value: c, text: c })));
      // ★ 手动输入分类：列表里没有的分类，可现场写
      sel.appendChild(el('option', { value: '__custom__', text: '➕ 手动输入分类…' }));
      if (S.cfg.cats && S.cfg.cats.indexOf(cur) >= 0) sel.value = cur;
      else if (cur === '__custom__') sel.value = '__custom__';
      else sel.value = withAuto ? '' : (S.cfg.cats[0] || '');
      // 同步「手动输入」框显示状态
      const custom = document.getElementById(sel.id + 'Custom');
      if (custom) custom.hidden = (sel.value !== '__custom__');
    },

    /* 读取强制分类：若选了「手动输入」，取输入框的值；否则取下拉值 */
    getForcedCat(selId) {
      const sel = document.getElementById(selId);
      if (!sel) return '';
      if (sel.value === '__custom__') {
        const custom = document.getElementById(selId + 'Custom');
        return ((custom && custom.value) || '').trim();
      }
      return (sel.value || '').trim();
    },

    /* 绑定强制分类下拉框 → 切到「手动输入」时显示输入框 */
    bindCatCustom(selId) {
      const sel = document.getElementById(selId);
      const custom = document.getElementById(selId + 'Custom');
      if (!sel || !custom) return;
      sel.onchange = () => {
        custom.hidden = (sel.value !== '__custom__');
        if (!custom.hidden) { custom.focus(); }
      };
      // 输入时即时同步到 select 的 title，便于日志显示
      custom.oninput = () => { sel.title = custom.value; };
    },

    /* 把手动输入的「新分类」静默写进分类列表，方便以后直接选 */
    async persistNewCat(cat) {
      cat = (cat || '').trim();
      if (!cat) return;
      if ((S.cfg.cats || []).indexOf(cat) < 0) {
        S.cfg.cats = (S.cfg.cats || []).concat(cat);
        try { await S.saveCfg(); } catch (e) { /* 忽略保存失败 */ }
      }
    },

    async init() {
      const missing = [];
      if (!U) missing.push('utils.js (U)');
      if (!S) missing.push('store.js (Store)');
      if (!M) missing.push('matcher.js (Matcher)');
      if (!IMP) missing.push('importer.js (Importer)');
      if (!OCR) missing.push('ocr.js (OCR)');
      if (!EXP) missing.push('exporter.js (Exporter)');
      if (missing.length) {
        const scriptErrs = (window.__scriptErrors && window.__scriptErrors.length) ? ('\n脚本加载错误：' + window.__scriptErrors.join('；')) : '';
        const runtimeErrs = (window.__runtimeErrors && window.__runtimeErrors.length) ? ('\n脚本执行错误：' + window.__runtimeErrors.join('；')) : '';
        throw new Error('核心脚本未加载完整：' + missing.join('、') + '\n\n请按 Ctrl+F5 强制刷新，或检查浏览器扩展/安全软件是否拦截了上述脚本。' + scriptErrs + runtimeErrs);
      }
      await S.init();
      this.items = await S.allItems();
      M.buildIndex(this.items);
      this.fillCatSelect($('#ocrCat'), true);
      this.fillCatSelect($('#rawCat'), true);
      this.bindNav();
      this.bindWork();
      this.bindCatCustom('ocrCat');
      this.bindCatCustom('rawCat');
      this.bindRawXlsx();
      this.bindTable();
      this.bindDb();
      this.bindOut();
      this.bindSet();
      await this.refreshBooks();
      this.fillSettings();
      this.renderAll();
      window.addEventListener('beforeunload', e => {
        if (this.photos.some(p => p.status === 'run')) { e.preventDefault(); e.returnValue = ''; }
      });
    },

    /* ================= 导航 ================= */
    bindNav() {
      const titles = { work: '识别工作台', table: '数据核对', db: '商品数据库', out: '汇总导出', set: '设置' };
      $$('#nav button').forEach(b => b.addEventListener('click', () => {
        const v = b.dataset.v;
        this.view = v;
        $$('#nav button').forEach(x => x.classList.toggle('on', x === b));
        ['work', 'table', 'db', 'out', 'set'].forEach(k => { $('#v-' + k).hidden = (k !== v); });
        $('#vtitle').textContent = titles[v];
        if (v === 'table') this.renderTable();
        if (v === 'db') this.renderDb();
        if (v === 'out') this.renderPreview();
      }));
      $('#lightbox').addEventListener('click', () => { $('#lightbox').hidden = true; });
    },

    /* ================= 账套 ================= */
    async refreshBooks() {
      const books = await S.allBooks();
      this.books = books;
      const shops = Array.from(new Set(books.map(b => b.shop))).filter(Boolean).sort();
      const cur = S.cfg.curShop || shops[0] || '';
      const sSel = $('#shopSel');
      sSel.innerHTML = '';
      shops.forEach(s => sSel.appendChild(el('option', { value: s, text: s })));
      if (!shops.length) sSel.appendChild(el('option', { value: '', text: '（暂无账套）' }));
      sSel.value = shops.indexOf(cur) >= 0 ? cur : (shops[0] || '');

      this.fillYm();
      sSel.onchange = () => { S.cfg.curShop = sSel.value; this.fillYm(); this.loadBook(); };
      $('#ymSel').onchange = () => { S.cfg.curYm = $('#ymSel').value; this.loadBook(); };
      $('#newBook').onclick = () => this.newBookDialog();
      await this.loadBook();
    },

    fillYm() {
      const shop = $('#shopSel').value;
      const yms = this.books.filter(b => b.shop === shop).map(b => b.ym).sort();
      const ySel = $('#ymSel');
      ySel.innerHTML = '';
      yms.forEach(y => ySel.appendChild(el('option', { value: y, text: `20${y.slice(0, 2)}年${parseInt(y.slice(2), 10)}月` })));
      if (!yms.length) ySel.appendChild(el('option', { value: '', text: '—' }));
      ySel.value = yms.indexOf(S.cfg.curYm) >= 0 ? S.cfg.curYm : (yms[yms.length - 1] || '');
    },

    async loadBook() {
      const shop = $('#shopSel').value, ym = $('#ymSel').value;
      if (!shop || !ym) { this.book = null; this.renderAll(); return; }
      this.rawItems = [];
      this.book = await S.getBook(S.bookId(shop, ym));
      S.cfg.curShop = shop; S.cfg.curYm = ym;
      await S.saveCfg();
      this.renderAll();
    },

    newBookDialog() {
      const now = new Date();
      const body = el('div', {}, []);
      body.innerHTML = `
        <div class="field"><label>店铺名称</label><input id="nbShop" placeholder="如 彩虹店" value="${esc($('#shopSel').value || '')}"></div>
        <div class="grid2">
          <div class="field"><label>年份（两位）</label><input id="nbY" type="number" value="${String(now.getFullYear() % 100)}"></div>
          <div class="field"><label>月份</label><input id="nbM" type="number" min="1" max="12" value="${now.getMonth() + 1}"></div>
        </div>`;
      this.modal('新建账套', body, [
        { text: '取消', cls: '' },
        {
          text: '创建', cls: 'primary', keep: false, fn: async () => {
            const shop = $('#nbShop').value.trim();
            const yy = parseInt($('#nbY').value, 10), mm = parseInt($('#nbM').value, 10);
            if (!shop || !yy || !mm) { toast('请填完整', 'err'); return true; }
            const ym = U.makeYm(yy, mm);
            await S.ensureBook(shop, ym);
            S.cfg.curShop = shop; S.cfg.curYm = ym; await S.saveCfg();
            await this.refreshBooks();
            toast('账套已创建：' + shop + ' ' + mm + '月', 'ok');
          }
        }
      ]);
    },

    /* ================= 工作台 ================= */
    bindWork() {
      const dz = $('#dropPhoto'), fi = $('#filePhoto');
      dz.onclick = () => fi.click();
      dz.ondragover = e => { e.preventDefault(); dz.classList.add('over'); };
      dz.ondragleave = () => dz.classList.remove('over');
      dz.ondrop = e => {
        e.preventDefault(); dz.classList.remove('over');
        this.addPhotos(Array.from(e.dataTransfer.files).filter(f => /^image\//.test(f.type)));
      };
      fi.onchange = () => { this.addPhotos(Array.from(fi.files)); fi.value = ''; };
      $('#btnClearPhoto').onclick = () => {
        this.photos.forEach(p => URL.revokeObjectURL(p.url));
        this.photos = []; this.renderThumbs(); this.updatePhotoStats();
      };
      $('#btnOcr').onclick = () => this.runOcr();

      // ★ 通道切换
      const tabs = $$('.channel-tab');
      tabs.forEach(t => t.addEventListener('click', () => {
        tabs.forEach(x => {
          x.classList.toggle('active', x === t);
          x.style.background = x === t ? 'var(--brand-1)' : 'var(--bg)';
          x.style.color = x === t ? '#fff' : 'var(--text)';
        });
        this.channel = t.dataset.ch;
        this.updateChannelUI();
      }));
      this.updateChannelUI();
    },

    updateChannelUI() {
      const isMobile = this.channel === 'mobile';
      $('#dropIcon').textContent = isMobile ? '📱' : '📁';
      $('#dropText').textContent = isMobile ? '点击选择手机照片，或拖进来' : '点击选择，或把照片拖进来';
      $('#dropSub').textContent = isMobile
        ? '手机拍照的图片会自动增强（对比度+锐化），并提示模型纠正可能的旋转/透视变形'
        : '一次可传多张，识别时会自动带上商品库做上下文纠错';
      $('#channelHint').textContent = isMobile
        ? '当前：手机模式 — 适合手机直接拍采购单（自动增强图片质量 + 模型智能纠偏）'
        : '当前：电脑模式 — 适合扫描件、PDF 转图片、微信文件传输助手收到的清晰图片';
    },

    addPhotos(files) {
      if (!files.length) return;
      const src = this.channel; // 记录上传时的通道
      files.forEach(f => {
        this.photos.push({ id: U.uid(), file: f, url: URL.createObjectURL(f), status: 'wait', msg: '', source: src });
      });
      this.renderThumbs(); this.updatePhotoStats();
    },

    updatePhotoStats() {
      const box = $('#photoStats');
      if (!this.photos.length) { box.innerHTML = ''; return; }
      const d = this.photos.filter(p => p.source === 'desktop').length;
      const m = this.photos.filter(p => p.source === 'mobile').length;
      box.innerHTML = (d ? `📁 电脑 ${d} 张` : '') + (m ? (d ? ' · ' : '') + `📱 手机 ${m} 张` : '');
    },

    renderThumbs() {
      const box = $('#thumbs');
      box.innerHTML = '';
      this.photos.forEach((p, i) => {
        const isMobile = p.source === 'mobile';
        const t = el('div', { class: 'thumb' + (p.status === 'empty' ? ' warn' : '') + (isMobile ? ' mobile-src' : '') });
        const img = el('img', { src: p.url, alt: p.file.name });
        img.onclick = () => { $('#lbImg').src = p.url; $('#lightbox').hidden = false; };
        // 来源标签
        const srcTag = el('span', { class: 'src-tag', text: isMobile ? '📱' : '📁', title: isMobile ? '手机拍照（增强模式）' : '电脑上传（标准模式）' });
        const meta = el('div', { class: 'meta' }, [
          srcTag,
          el('span', { class: 'st ' + p.status }),
          el('span', { class: 'nm', text: p.msg || p.file.name, title: p.msg || p.file.name })
        ]);
        const x = el('button', { class: 'x', text: '×', title: '移除' });
        x.onclick = () => { URL.revokeObjectURL(p.url); this.photos.splice(i, 1); this.renderThumbs(); this.updatePhotoStats(); };
        t.appendChild(img); t.appendChild(meta); t.appendChild(x);
        // 0行或出错的照片显示重试按钮
        if (p.status === 'empty' || p.status === 'err') {
          const rt = el('button', { class: 'retry-btn', text: '↻ 重试', title: '重新识别这张照片' });
          rt.onclick = () => { p.status = 'wait'; p.msg = ''; this.renderThumbs(); };
          t.appendChild(rt);
        }
        box.appendChild(t);
      });
      const has = this.photos.length > 0;
      $('#btnClearPhoto').disabled = !has;
      const apiOk = !!(S.cfg.api.base && S.cfg.api.model && S.cfg.api.key) ||
        (S.cfg.api.base && /localhost|127\.0\.0\.1/.test(S.cfg.api.base));
      $('#btnOcr').disabled = !has || !apiOk || !this.book;
      $('#ocrHint').textContent = !this.book ? '请先在右上角新建/选择账套'
        : (!apiOk ? '先在「设置」里填好视觉模型 API' : (has ? `共 ${this.photos.length} 张，将写入 ${this.book.shop} · ${parseInt(this.book.ym.slice(2), 10)}月` : ''));
    },

    bindRawXlsx() {
      this.rawItems = [];
      const dz = $('#dropRaw'), fi = $('#fileRaw');
      dz.onclick = () => fi.click();
      dz.ondragover = e => { e.preventDefault(); dz.classList.add('over'); };
      dz.ondragleave = () => dz.classList.remove('over');
      dz.ondrop = e => {
        e.preventDefault(); dz.classList.remove('over');
        this.addRawFiles(Array.from(e.dataTransfer.files).filter(f => /\.xlsx?$/i.test(f.name)));
      };
      fi.onchange = () => { this.addRawFiles(Array.from(fi.files)); fi.value = ''; };
      $('#btnRawImport').onclick = () => this.runRawImport();
    },

    addRawFiles(files) {
      if (!files.length) return;
      if (!this.book) { toast('请先选择账套', 'err'); return; }
      const log = $('#rawLog'); log.hidden = false; log.textContent = '解析中…';
      const forcedCat = this.getForcedCat('rawCat');
      const month = parseInt(this.book.ym.slice(2), 10);
      Promise.all(files.map(f => IMP.parseRawItems(f, { forceCat: forcedCat, cats: S.cfg.cats, month }))).then(res => {
        let total = 0;
        const msgs = [];
        res.forEach(r => {
          this.rawItems = this.rawItems.concat(r.items);
          total += r.items.length;
          msgs.push(`✔ ${r.file}：${r.items.length} 行`);
          r.log.forEach(l => msgs.push('   ' + l));
        });
        log.textContent = `共解析 ${total} 行，准备加入「${this.book.shop} ${parseInt(this.book.ym.slice(2), 10)}月」\n` + msgs.join('\n');
        $('#btnRawImport').disabled = !total;
      }).catch(e => {
        log.textContent = '解析失败：' + e.message;
        toast('Excel 解析失败', 'err');
      });
    },

    async runRawImport() {
      if (!this.book) { toast('请先选择账套', 'err'); return; }
      if (!this.rawItems.length) { toast('没有待导入的数据'); return; }
      const forcedCat = this.getForcedCat('rawCat');
      await this.persistNewCat(forcedCat);
      const month = parseInt(this.book.ym.slice(2), 10);
      const rows = this.rawItems.map(it => M.processRow({
        date: it.date, name: it.name,
        qty: it.qty, price: it.price, amount: it.amount,
        src: 'raw', photo: '', daily: it.daily,
        forceCat: forcedCat || it.cat || ''
      }, S.cfg, month));
      // 默认不跨照片/跨单合并：每张单独立录入，避免同名合并导致识别漏行被掩盖；
      // 如需合并，可在「数据核对」点「合并重复行」按钮手动执行。
      const base = this.book._seq || this.book.rows.reduce((m, r) => Math.max(m, r.seq || 0), 0);
      let seq = base;
      rows.forEach(row => { row.seq = ++seq; });
      this.book._seq = seq;
      this.book.rows = this.book.rows.concat(rows);
      await S.putBook(this.book);
      const lr = M.learn(this.book.rows, this.items, this.book.shop, this.book.ym);
      this.items = lr.list;
      await S.putItems(this.items);
      M.buildIndex(this.items);
      const newN = rows.filter(r => r.flags.nameSrc === 'new').length;
      const rev = rows.filter(r => r.flags.review).length;
      this.rawItems = [];
      $('#btnRawImport').disabled = true;
      $('#rawLog').hidden = true;
      this.renderAll();
      toast(`已导入 ${rows.length} 行（待核对 ${rev}，新品 ${newN}）`, 'ok');
      $$('#nav button').find(b => b.dataset.v === 'table').click();
    },

    log(msg) {
      const box = $('#ocrLog');
      box.hidden = false;
      box.textContent += (box.textContent ? '\n' : '') + msg;
      box.scrollTop = box.scrollHeight;
    },

    async runOcr() {
      if (!this.book) { toast('请先选择账套', 'err'); return; }
      const api = S.cfg.api;
      const cfg = S.cfg;
      const ctx = OCR.buildContext(this.items, cfg.cats);
      const month = parseInt(this.book.ym.slice(2), 10);
      const targets = this.photos.filter(p => p.status !== 'ok' && p.status !== 'done');
      if (!targets.length) {
        const emptyCount = this.photos.filter(p => p.status === 'empty').length;
        toast(emptyCount > 0 ? `${emptyCount} 张照片识别结果为空，可点缩略图「↻ 重试」重新识别` : '没有待识别的照片', 'warn');
        return;
      }

      $('#btnOcr').disabled = true;
      $('#ocrProg').hidden = false;
      $('#ocrLog').textContent = '';
      const forcedCat = this.getForcedCat('ocrCat');
      await this.persistNewCat(forcedCat);
      this.log(`开始识别 ${targets.length} 张 · 模型 ${api.model} · 并发 ${api.conc}${forcedCat ? ' · 强制分类「' + forcedCat + '」' : ''}`);
      const mobileCount = targets.filter(p => p.source === 'mobile').length;
      if (mobileCount) {
        const m = (api.mobileModel || '').trim() || api.model;
        this.log(`  其中 ${mobileCount} 张为手机拍照，使用模型：${m}`);
      }
      let done = 0, okCount = 0, rowCount = 0;
      const results = new Array(targets.length); // 按图序收集，最后统一写入

      const tasks = targets.map((p, idx) => async () => {
        p.status = 'run'; p.msg = '识别中…'; this.renderThumbs();
        // ★ 根据照片来源通道选择不同的图片处理管线和模型
        const isMobile = p.source === 'mobile';
        const dataUrl = isMobile
          ? await OCR.compressForMobile(p.file, api.maxw || 1600)
          : await OCR.compress(p.file, api.maxw || 2200, { enhance: !!api.desktopEnhance });

        // ★ 手机端模型可由用户在设置页「手机端模型」自行填写；
        //   留空时手机端跟随电脑端模型（api.model）保持一致
        const mobileModel = (api.mobileModel || '').trim();
        const mobileApi = isMobile && mobileModel
          ? { base: api.base, key: api.key, model: mobileModel, proxy: api.proxy || '' }
          : api;
        const res = await OCR.recognize(mobileApi, dataUrl, ctx, cfg.cats, { cat: forcedCat }, isMobile);

        // ★ 手机端如果专用模型返回空（0行），回退到配置的默认模型
        if (isMobile && mobileModel && res.items.length === 0) {
          this.log(`  ⚠ ${p.file.name} ${mobileModel} 返回空，回退到 ${api.model}…`);
          try {
            const fallbackRes = await OCR.recognize(api, dataUrl, ctx, cfg.cats, { cat: forcedCat }, true);
            if (fallbackRes.items.length > 0) {
              res.items = fallbackRes.items; res.raw = fallbackRes.raw;
              res.date = fallbackRes.date; res.category = fallbackRes.category;
              this.log(`  ✓ 回退成功：${fallbackRes.items.length} 行`);
            }
          } catch (fbErr) {
            this.log(`  ⚠ 回退也失败(${fbErr.message.slice(0,40)})`);
          }
        }

        // ★ 日期 fallback：如果模型没返回 date，从原始 JSON 文本中正则提取
        if (!res.date && res.raw) {
          const dm = res.raw.match(/"date"\s*:\s*"(\d{1,2}[.\-\/]\d{1,2})"/)
            || res.raw.match(/(\d{4})[年\-\/](\d{1,2})[月\-\/](\d{1,2})/);
          if (dm) {
            res.date = dm[2] ? (+dm[2] + '.' + +dm[3]) : dm[1];
          }
          // 记录日期到照片对象，供重试清理旧行时匹配用
          p._date = res.date;
        }
        // 存照片以便回溯
        try {
          await S.putPhoto({ id: p.id, book: this.book.id, name: p.file.name, blob: p.file, at: Date.now() });
        } catch (e) { /* 忽略存储失败 */ }
        const rows = res.items.map(it => M.processRow({
          date: it.date || res.date, name: it.name,
          qty: it.qty, price: it.price, amount: it.amount, src: 'ocr', photo: p.id,
          forceCat: forcedCat
        }, cfg, month));
        // ★ 手机端专属：预计算本单金额量级，用于小数点错误兜底检测（整数被误读成 1 位小数时，同单其他金额可作对照）
        const _otherAmts = res.items.map(o => Number(o.amount)).filter(x => isFinite(x) && x > 0);
        const _hasLarger = _otherAmts.some(x => x >= 50);
        // 把模型标记的模糊字段并入待核对说明
        res.items.forEach((it, i) => {
          if (!rows[i]) return;
          if (it.blur && it.blur.length) {
            rows[i].flags.review = true;
            rows[i].flags.note = (rows[i].flags.note ? rows[i].flags.note + '；' : '') + '模型标记模糊字段：' + it.blur.join('/');
          }
          if (typeof it.conf === 'number' && it.conf < 0.6) {
            rows[i].flags.review = true;
            rows[i].flags.note = (rows[i].flags.note ? rows[i].flags.note + '；' : '') + `识别置信度低(${it.conf})`;
          }
          // ★ 原始三值自洽性检查：金额 = 数量 × 单价（不再区分分/元，直接用识别原值比对）
          if (U.ok(it.qty) && U.ok(it.price) && U.ok(it.amount)) {
            const calc = U.r4(it.qty * it.price);
            const dev = Math.abs(calc - it.amount) / Math.max(it.amount, 1);
            if (dev > 0.5) {
              rows[i].flags.review = true;
              rows[i].flags.note = (rows[i].flags.note ? rows[i].flags.note + '；' : '') +
                `OCR三值不自洽(数量${U.fmt(it.qty)}×单价${U.fmt(it.price)}=${U.fmt(calc)}≠金额${U.fmt(it.amount)}，偏差${U.fmt(Math.round(dev*100))}%)`;
            }
          }
          // ★ 手机端专属：小数点错误兜底检测（整数被误读成 1 位小数，如 42→4.2、189→18.9）
          //   此时 qty×price=amount 仍成立（模型把三个值同时÷10），上面的三值自洽检查抓不到，必须单独检测
          if (isMobile && U.ok(it.amount) && !rows[i].flags.review) {
            const _a = Number(it.amount);
            const _dec = String(_a).split('.')[1];
            if (_a > 0 && _a < 100 && _dec && _dec.length === 1 && Math.abs(_a * 10 - Math.round(_a * 10)) < 0.01) {
              const _a10 = Math.round(_a * 10);
              if (_a10 >= 10 && _hasLarger) {
                rows[i].flags.review = true;
                rows[i].flags.note = (rows[i].flags.note ? rows[i].flags.note + '；' : '') +
                  `⚠金额疑似多读小数点(${U.fmt(_a)}→可能应为${U.fmt(_a10)})，请核对原图`;
              }
            }
          }
          // ★ 反推后合理性检查：如果反推出的单价/数量明显不合理（单价<0.5或数量<0.1），也标红
          if (U.ok(rows[i].price) && rows[i].price < 0.5 && !rows[i].flags.review) {
            rows[i].flags.review = true;
            rows[i].flags.note = (rows[i].flags.note ? rows[i].flags.note + '；' : '') +
              `反推单价异常偏低(${U.fmt(rows[i].price)})，可能金额有误`;
          }
          if (U.ok(rows[i].qty) && rows[i].qty < 0.1 && !rows[i].flags.review) {
            rows[i].flags.review = true;
            rows[i].flags.note = (rows[i].flags.note ? rows[i].flags.note + '；' : '') +
              `反推数量异常偏小(${U.fmt(rows[i].qty)})，可能金额有误`;
          }
        });
        results[idx] = rows; // 先收集，识别全部完成后按放图顺序统一写入
        rowCount += rows.length;
        p.status = rows.length > 0 ? 'ok' : 'empty';
        p.msg = `${rows.length} 行 · ${forcedCat || res.category || '自动分类'} · ${res.date || '⚠️缺日期'}`;
        p.rowCount = rows.length;
        okCount++;
        return rows.length;
      });

      await OCR.runQueue(tasks, api.conc || 6, (k, r, err) => {
        done++;
        const p = targets[k];
        if (err) {
          p.status = 'err';
          let m = String(err.message || err);
          if (/无法解析/.test(m)) m = '识别失败(模型输出过长被截断，建议换更强模型或一次少传几张)';
          else if (/401|Authentication|invalid.*key|InvalidApiKey/i.test(m)) m = '识别失败(Key无效，请检查API Key)';
          else if (/403|Access denied|AccessDenied/i.test(m)) m = '识别失败(模型未开通/无权限，请在百炼控制台开通视觉模型)';
          else if (/跨域|Failed to fetch|网络请求失败/i.test(m)) m = '识别失败(跨域/网络，请在设置填代理前缀)';
          p.msg = m.slice(0, 80);
          this.log(`✗ ${p.file.name}：${err.message || err}`);
        } else {
          const resInfo = results[k] ? (results[k][0] && results[k][0].date ? `· 日期 ${results[k][0].date}` : ' · ⚠️无日期') : '';
          this.log(`✓ ${p.file.name}：识别 ${r} 行${resInfo}`);
        }
        $('#ocrProg').querySelector('i').style.width = (done / targets.length * 100) + '%';
        this.renderThumbs();
      });

      // ★ 按「放图顺序」统一写入 book.rows（并发完成顺序 ≠ 放图顺序，必须在此重排）
      // ★ 重试前先清除这些照片之前写入的旧行（避免脏数据/重复堆积）
      const targetIds = new Set(targets.map(t => t.id));
      const targetDates = new Set(targets.map(t => t._date).filter(Boolean));
      const before = this.book.rows.length;
      this.book.rows = this.book.rows.filter(r => {
        // 有 photo 字段且匹配目标照片 → 删除（正常清理路径）
        if (r.photo && targetIds.has(r.photo)) return false;
        // 兼容旧数据：OCR 来源但没有 photo 字段的旧行，如果日期也匹配 → 一并删除
        // （旧版代码写入时没带 photo 字段，导致上面的匹配漏掉它们）
        if (!r.photo && r.src === 'ocr' && targetDates.size && r.date && targetDates.has(String(r.date))) return false;
        return true;
      });
      const removed = before - this.book.rows.length;
      if (removed) this.log(`已清除 ${removed} 行旧数据（来自本次重识别的照片）`);
      const base = this.book._seq || this.book.rows.reduce((m, r) => Math.max(m, r.seq || 0), 0);
      let seq = base;
      results.forEach(r => {
        if (!r) return;
        r.forEach(row => { row.seq = ++seq; });
        this.book.rows = this.book.rows.concat(r);
      });
      this.book._seq = seq;

      if (rowCount) {
        await S.putBook(this.book);
        // 学习回商品库（只学未标待核对的行）
        const lr = M.learn(this.book.rows, this.items, this.book.shop, this.book.ym);
        this.items = lr.list;
        await S.putItems(this.items);
        M.buildIndex(this.items);
      }
      this.log(`完成：成功 ${okCount}/${targets.length} 张，新增 ${rowCount} 行`);
      $('#btnOcr').disabled = false;
      this.renderAll();
      toast(`识别完成，新增 ${rowCount} 行`, okCount === targets.length ? 'ok' : 'err');
      if (rowCount) {
        $$('#nav button').find(b => b.dataset.v === 'table').click();
      }
    },

    /* ================= 数据表 ================= */
    bindTable() {
      $('#btnRecalc').onclick = async () => {
        if (!this.book) return;
        const month = parseInt(this.book.ym.slice(2), 10);
        this.book.rows = this.book.rows.map(r => {
          const nr = M.processRow({
            id: r.id, date: r.date, cat: r.cat, name: r.rawName || r.name,
            qty: r.qty, price: r.price, amount: r.amount, rawAmount: r.rawAmount,
            src: r.src, photo: r.photo
          }, S.cfg, month);
          nr.daily = r.daily;
          return nr;
        });
        await S.putBook(this.book);
        this.renderAll(); toast('已重新推算', 'ok');
      };
      $('#btnDedup').onclick = async () => {
        if (!this.book) return;
        const before = this.book.rows.length;
        this.book.rows = M.dedup(this.book.rows);
        await S.putBook(this.book);
        this.renderAll();
        toast(`合并完成：${before} → ${this.book.rows.length} 行`, 'ok');
      };
      $('#btnClearRows').onclick = () => {
        if (!this.book) return;
        this.confirm(`确定清空「${this.book.shop} ${parseInt(this.book.ym.slice(2), 10)}月」的 ${this.book.rows.length} 行数据？此操作不可撤销。`, async () => {
          this.book.rows = [];
          await S.putBook(this.book);
          this.renderAll(); toast('已清空', 'ok');
        });
      };
      // ★ 批量删除选中行
      $('#btnDelSel').onclick = async () => {
        const cks = $$('#dtBody .rowchk:checked');
        if (!cks.length) return;
        const ids = new Set(cks.map(c => c.dataset.rid));
        this.confirm(`确定删除选中的 ${ids.length} 行数据？`, async () => {
          const before = this.book.rows.length;
          this.book.rows = this.book.rows.filter(r => !ids.has(r.id));
          await S.putBook(this.book);
          this.renderAll();
          toast(`已删除 ${before - this.book.rows.length} 行`, 'ok');
        });
      };
      // ★ 全选/取消
      $('#chkAll').onchange = () => {
        $$('#dtBody .rowchk').forEach(c => { c.checked = $('#chkAll').checked; });
        this.updateSelCount();
      };
      $('#onlyReview').onchange = () => this.renderTable();
      $('#searchRow').oninput = () => this.renderTable();
    },

    rowsFiltered() {
      if (!this.book) return [];
      let rows = this.book.rows;
      if (this.filterCat) rows = rows.filter(r => (r.cat || '未分类') === this.filterCat);
      if ($('#onlyReview').checked) rows = rows.filter(r => r.flags && r.flags.review);
      const kw = $('#searchRow').value.trim();
      if (kw) {
        const k = U.normName(kw);
        rows = rows.filter(r => U.normName(r.name).indexOf(k) >= 0 || String(r.date).indexOf(kw) >= 0);
      }
      return rows;
    },

    renderStats() {
      const box = $('#stats');
      if (!this.book) { box.innerHTML = ''; return; }
      const rows = this.book.rows;
      const total = rows.reduce((s, r) => s + (U.ok(r.amount) ? r.amount : 0), 0);
      const rev = rows.filter(r => r.flags && r.flags.review).length;
      const der = rows.filter(r => r.flags && r.flags.derived && r.flags.derived.length).length;
      const days = new Set(rows.map(r => r.date).filter(Boolean)).size;
      const cats = new Set(rows.map(r => r.cat || '未分类')).size;
      box.innerHTML = '';
      [['明细行数', rows.length, ''], ['金额合计', '¥' + U.money(total), 'brand'],
      ['自动推算', der, ''], ['待核对', rev, rev ? 'warn' : ''],
      ['采购天数', days, ''], ['分类数', cats, '']].forEach(([k, v, c]) => {
        box.appendChild(el('div', { class: 'stat ' + c }, [
          el('div', { class: 'k', text: k }), el('div', { class: 'v', text: String(v) })
        ]));
      });
    },

    renderCatFilter() {
      const box = $('#catFilter');
      box.innerHTML = '';
      if (!this.book) return;
      const m = new Map();
      this.book.rows.forEach(r => { const c = r.cat || '未分类'; m.set(c, (m.get(c) || 0) + 1); });
      const mk = (label, val, n) => {
        const c = el('div', { class: 'chip' + (this.filterCat === val ? ' on' : '') }, [
          document.createTextNode(label),
          el('span', { class: 'n', text: n === null ? '' : String(n) })
        ]);
        c.onclick = () => { this.filterCat = val; this.renderTable(); };
        return c;
      };
      box.appendChild(mk('全部', '', this.book.rows.length));
      const order = (S.cfg.cats || []).filter(c => m.has(c)).concat(Array.from(m.keys()).filter(c => (S.cfg.cats || []).indexOf(c) < 0));
      order.forEach(c => box.appendChild(mk(c, c, m.get(c))));
    },

    renderTable() {
      this.renderStats();
      this.renderCatFilter();
      const tb = $('#dtBody');
      tb.innerHTML = '';
      const rows = this.rowsFiltered();
      $('#bg-rows').textContent = this.book ? this.book.rows.length : 0;
      if (!rows.length) {
        tb.appendChild(el('tr', {}, [el('td', { colspan: 10, html: '<div class="empty"><div class="big">📭</div>暂无数据，去「识别工作台」上传采购单</div>' })]));
        return;
      }
      const sorted = rows.slice().sort((a, b) => {
        const d = U.dateKey(a.date) - U.dateKey(b.date);
        if (d) return d;
        return String(a.cat).localeCompare(String(b.cat), 'zh');
      });
      const frag = document.createDocumentFragment();
      sorted.forEach((r, i) => frag.appendChild(this.buildRow(r, i + 1)));
      tb.appendChild(frag);
      this.updateSelCount();
    },

    buildRow(r, no) {
      const tr = el('tr', { class: (r.flags && r.flags.review) ? 'review' : '' });
      // 选择框（批量删除用）
      const tdChk = el('td');
      const chk = el('input', { type: 'checkbox', class: 'rowchk', 'data-rid': r.id });
      chk.onchange = () => this.updateSelCount();
      tdChk.appendChild(chk);
      tr.appendChild(tdChk);
      tr.appendChild(el('td', { text: String(no) }));

      const mkCell = (val, key, cls) => {
        const td = el('td', { class: cls || '' });
        const inp = el('input', { class: 'cell', value: val === null || val === undefined ? '' : String(val) });
        inp.addEventListener('change', () => this.editCell(r, key, inp.value));
        td.appendChild(inp);
        return td;
      };
      tr.appendChild(mkCell(r.date, 'date'));

      // 分类下拉
      const tdCat = el('td');
      const sel = el('select', { class: 'cell' });
      const cats = (S.cfg.cats || []).slice();
      if (r.cat && cats.indexOf(r.cat) < 0) cats.push(r.cat);
      sel.appendChild(el('option', { value: '', text: '未分类' }));
      cats.forEach(c => sel.appendChild(el('option', { value: c, text: c })));
      sel.value = r.cat || '';
      sel.addEventListener('change', () => this.editCell(r, 'cat', sel.value));
      tdCat.appendChild(sel);
      tr.appendChild(tdCat);

      tr.appendChild(mkCell(r.name, 'name', 'nm'));
      tr.appendChild(mkCell(U.fmt(r.qty), 'qty', 'num'));
      tr.appendChild(mkCell(U.fmt(r.price), 'price', 'num'));
      // 金额列：直接显示 OCR 识别到的原始数字（如 560），不做任何单位换算。
      // row.rawAmount 与 row.amount 现在保持一致，都按原值显示和导出。
      tr.appendChild(mkCell(U.fmt(r.rawAmount != null ? r.rawAmount : r.amount), 'amount', 'num'));

      // 来源标记
      const td = el('td');
      const f = r.flags || {};
      const tags = [];
      if (r.src === 'ocr') tags.push(['ocr', 'OCR']);
      else if (r.src === 'import') tags.push(['ocr', '导入']);
      else tags.push(['ocr', '手工']);
      (f.derived || []).forEach(d => tags.push(['calc', { qty: '数量推算', price: '单价推算', amount: '金额推算' }[d] || d]));
      if (f.nameSrc === 'fuzzy' || f.nameSrc === 'exact' || f.nameSrc === 'alias') tags.push(['db', '库匹配']);
      if (f.nameSrc === 'db-price') tags.push(['db', '价格反查']);
      if (f.nameSrc === 'new') tags.push(['rev', '新品名']);
      if (f.review) tags.push(['rev', '待核对']);
      tags.forEach(([c, t]) => td.appendChild(el('span', { class: 'tag ' + c, text: t })));
      if (f.note) td.title = f.note;
      tr.appendChild(td);

      // 操作
      const tdA = el('td');
      const act = el('div', { class: 'rowact' });
      if (r.photo) {
        const b = el('button', { text: '🖼', title: '查看原图' });
        b.onclick = async () => {
          const ph = (await S.photosOf(this.book.id)).find(x => x.id === r.photo);
          if (!ph) { toast('原图未找到'); return; }
          $('#lbImg').src = URL.createObjectURL(ph.blob);
          $('#lightbox').hidden = false;
        };
        act.appendChild(b);
      }
      if (f.note) {
        const b = el('button', { text: 'ⓘ', title: f.note });
        b.onclick = () => this.modal('识别与推算说明', el('div', { html: `<div style="line-height:1.8">${esc(f.note)}</div>` }), [{ text: '知道了', cls: 'primary' }]);
        act.appendChild(b);
      }
      const del = el('button', { text: '✕', title: '删除此行' });
      del.onclick = async () => {
        this.book.rows = this.book.rows.filter(x => x.id !== r.id);
        await S.putBook(this.book);
        this.renderAll();
      };
      act.appendChild(del);
      tdA.appendChild(act);
      tr.appendChild(tdA);
      return tr;
    },

    /* 批量选择：更新选中计数 */
    updateSelCount() {
      const n = $$('#dtBody .rowchk:checked').length;
      $('#selCount').textContent = n;
      $('#btnDelSel').style.display = n > 0 ? '' : 'none';
      // 同步全选框状态
      const all = $$('#dtBody .rowchk');
      $('#chkAll').checked = all.length > 0 && all.length === n;
    },

    /* 手动编辑：不覆盖用户已填的值，只补空 + 校验 */
    async editCell(row, key, val) {
      if (key === 'date') row.date = U.parseDate(val, parseInt(this.book.ym.slice(2), 10));
      else if (key === 'cat') row.cat = val;
      else if (key === 'name') { row.name = String(val).trim(); row.rawName = row.name; }
      else if (key === 'amount') {
        // 金额编辑：表格直接显示用户填入的原始数字，后端不再做分/元换算。
        const v = U.toNum(val);
        row.rawAmount = v;
        row.amount = v;
      } else row[key] = U.toNum(val);

      const f = row.flags || (row.flags = { derived: [], note: '' });
      f.derived = [];
      f.review = false;
      f.note = '';
      f.manual = true;

      const hasQ = U.ok(row.qty), hasP = U.ok(row.price), hasA = U.ok(row.amount);
      if (hasQ && hasP && hasA) {
        const dev = Math.abs(row.qty * row.price - row.amount) / Math.max(Math.abs(row.amount), 1e-9);
        if (dev > (S.cfg.tol || 0.01)) {
          f.review = true;
          f.note = `数量×单价=${U.fmt(U.r2(row.qty * row.price))} 与金额 ${U.fmt(row.amount)} 不一致，请确认`;
        }
      } else {
        const it = this.items.find(x => x.cat === row.cat && U.normName(x.name) === U.normName(row.name));
        const rc = M.reconcile(row.qty, row.price, row.amount, it && it.ref, S.cfg.tol);
        row.qty = rc.qty; row.price = rc.price; row.amount = rc.amount;
        f.derived = rc.derived; f.review = rc.review; f.note = rc.note;
      }
      await S.putBook(this.book);
      this.renderTable();
    },

    /* ================= 商品库 ================= */
    bindDb() {
      const dz = $('#dropXlsx'), fi = $('#fileXlsx');
      dz.onclick = () => fi.click();
      dz.ondragover = e => { e.preventDefault(); dz.classList.add('over'); };
      dz.ondragleave = () => dz.classList.remove('over');
      dz.ondrop = e => {
        e.preventDefault(); dz.classList.remove('over');
        this.importXlsx(Array.from(e.dataTransfer.files).filter(f => /\.xlsx?$/i.test(f.name)));
      };
      fi.onchange = () => { this.importXlsx(Array.from(fi.files)); fi.value = ''; };
      $('#searchItem').oninput = () => this.renderDb();
      $('#btnClearDb').onclick = () => this.confirm(`确定清空商品库（${this.items.length} 条）？账套数据不受影响。`, async () => {
        await S.clearItems(); this.items = []; M.buildIndex([]); this.renderDb(); toast('商品库已清空', 'ok');
      });
      $('#btnExportDb').onclick = () => {
        U.download(new Blob([JSON.stringify(this.items, null, 2)], { type: 'application/json' }), '商品库.json');
      };
      $('#btnNormUnit').onclick = async () => {
        if (!window.confirm('将把商品库与所有账套里的单位写法统一为标准（KG→kg、千克→kg、克→g、毫升→ml、升→l），不改动数量与金额。确定执行？')) return;
        $('#btnNormUnit').disabled = true;
        try {
          const r = await S.normalizeUnits();
          this.items = await S.allItems(); M.buildIndex(this.items); this.renderDb();
          toast(`单位已统一：商品库 ${r.items} 条、账套 ${r.rows} 行已标准化`, 'ok');
        } catch (e) { toast('统一失败：' + e.message, 'err'); }
        finally { $('#btnNormUnit').disabled = false; }
      };
    },

    async importXlsx(files) {
      if (!files.length) return;
      const box = $('#impLog'); box.hidden = false; box.textContent = '';
      const log = m => { box.textContent += (box.textContent ? '\n' : '') + m; box.scrollTop = box.scrollHeight; };
      const map = new Map();
      this.items.forEach(it => map.set(it.id, it));
      const parsedList = [];

      for (const f of files) {
        try {
          log(`▸ 解析 ${f.name} …`);
          const p = await IMP.parseFile(f);
          p.log.forEach(l => log('   ' + l));
          const r = IMP.mergeToItems(p, map);
          log(`   → 店铺 ${p.shop} · 期间 ${p.ym || '未知'} · 新增品项 ${r.added}，更新 ${r.updated}`);
          // 扩充分类清单
          p.sheets.forEach(sh => {
            if (sh.cat && (S.cfg.cats || []).indexOf(sh.cat) < 0 && !/总帐|总账|每日汇总|待核对/.test(sh.cat)) {
              S.cfg.cats.push(sh.cat);
            }
          });
          parsedList.push(p);
        } catch (e) {
          log(`   ✗ 失败：${e.message}`);
        }
      }
      this.items = Array.from(map.values());
      await S.putItems(this.items);
      M.buildIndex(this.items);
      await S.saveCfg();
      log(`✔ 完成，商品库共 ${this.items.length} 条`);
      this.renderDb();
      this.fillSettings();
      toast(`商品库已更新：${this.items.length} 条`, 'ok');

      // 询问是否同时建成账套
      if (parsedList.length) {
        const names = parsedList.filter(p => p.shop && p.ym).map(p => `${p.shop} ${parseInt(p.ym.slice(2), 10)}月`);
        if (names.length) {
          this.confirm(`是否把这些历史表同时载入为账套，方便查看和重新导出？\n\n${names.join('、')}`, async () => {
            for (const p of parsedList) {
              if (!p.shop || !p.ym) continue;
              const b = await S.ensureBook(p.shop, p.ym);
              b.rows = IMP.toBookRows(p);
              await S.putBook(b);
            }
            await this.refreshBooks();
            toast('历史账套已载入', 'ok');
          }, '载入为账套', '只做数据库');
        }
      }
    },

    renderDb() {
      $('#bg-items').textContent = this.items.length;
      const box = $('#dbCatFilter');
      box.innerHTML = '';
      const m = new Map();
      this.items.forEach(it => m.set(it.cat, (m.get(it.cat) || 0) + 1));
      const mk = (label, val, n) => {
        const c = el('div', { class: 'chip' + (this.dbFilterCat === val ? ' on' : '') }, [
          document.createTextNode(label), el('span', { class: 'n', text: String(n) })]);
        c.onclick = () => { this.dbFilterCat = val; this.renderDb(); };
        return c;
      };
      box.appendChild(mk('全部', '', this.items.length));
      Array.from(m.keys()).sort().forEach(c => box.appendChild(mk(c, c, m.get(c))));

      const kw = U.normName($('#searchItem').value);
      let list = this.items;
      if (this.dbFilterCat) list = list.filter(it => it.cat === this.dbFilterCat);
      if (kw) list = list.filter(it => U.normName(it.name).indexOf(kw) >= 0);
      list = list.slice().sort((a, b) => (b.n || 0) - (a.n || 0)).slice(0, 500);

      const tb = $('#itemBody');
      tb.innerHTML = '';
      if (!list.length) {
        tb.appendChild(el('tr', {}, [el('td', { colspan: 7, html: '<div class="empty"><div class="big">🗃️</div>还没有数据，先在上方导入历史汇总表</div>' })]));
        return;
      }
      list.forEach(it => {
        const tr = el('tr');
        tr.appendChild(el('td', { text: it.cat }));
        tr.appendChild(el('td', { text: it.name }));
        tr.appendChild(el('td', { class: 'tr num', text: U.ok(it.ref) ? U.fmt(it.ref) : '—' }));
        tr.appendChild(el('td', { class: 'tr num', text: (U.ok(it.low) || U.ok(it.high)) ? `${U.fmt(it.low)} ~ ${U.fmt(it.high)}` : '—' }));
        tr.appendChild(el('td', { class: 'tc num', text: String(it.n || 0) }));
        tr.appendChild(el('td', { text: (it.shops || []).join('、') }));
        const td = el('td', { class: 'tr' });
        const b = el('button', { class: 'btn sm danger', text: '删除' });
        b.onclick = async () => {
          await S.delItem(it.id);
          this.items = this.items.filter(x => x.id !== it.id);
          M.buildIndex(this.items); this.renderDb();
        };
        td.appendChild(b); tr.appendChild(td);
        tb.appendChild(tr);
      });
    },

    /* ================= 导出 ================= */
    bindOut() {
      $('#btnExport').onclick = () => this.doExport();
      $('#expScope').onchange = () => this.renderPreview();
    },

    renderPreview() {
      const box = $('#expPreview');
      if (!this.book || !this.book.rows.length) { box.innerHTML = '<div class="empty">当前账套暂无数据</div>'; return; }
      const m = new Map();
      this.book.rows.forEach(r => {
        const c = r.cat || '未分类';
        m.set(c, (m.get(c) || 0) + (U.ok(r.amount) ? r.amount : 0));
      });
      const order = (S.cfg.cats || []).filter(c => m.has(c)).concat(Array.from(m.keys()).filter(c => (S.cfg.cats || []).indexOf(c) < 0));
      let total = 0;
      let html = '<table class="simple"><thead><tr><th style="width:60px">序号</th><th>项目</th><th class="tr">金额（元）</th></tr></thead><tbody>';
      order.forEach((c, i) => {
        const v = m.get(c) || 0; total += v;
        html += `<tr><td>${i + 1}</td><td>${esc(c)}</td><td class="tr num">${U.money(v)}</td></tr>`;
      });
      html += `<tr style="background:#fffbe6;font-weight:600"><td></td><td>统计</td><td class="tr num" style="color:#c0392b">${U.money(total)}</td></tr>`;
      html += `</tbody></table><div class="muted" style="margin-top:10px">${esc(this.book.shop)} · ${parseInt(this.book.ym.slice(2), 10)}月 · 共 ${this.book.rows.length} 行明细，将生成 ${order.length} 个分类 sheet</div>`;
      box.innerHTML = html;
    },

    async doExport() {
      const scope = $('#expScope').value;
      let books = [];
      if (scope === 'cur') { if (this.book) books = [this.book]; }
      else if (scope === 'shop') books = (await S.allBooks()).filter(b => b.shop === $('#shopSel').value);
      else books = await S.allBooks();
      books = books.filter(b => b.rows && b.rows.length);
      if (!books.length) { toast('没有可导出的数据', 'err'); return; }

      const opt = {
        daily: $('#optDaily').checked,
        review: $('#optReview').checked,
        merge: $('#optMerge').checked
      };
      $('#btnExport').disabled = true;
      $('#expHint').textContent = '生成中…';
      try {
        for (const b of books) {
          const res = await EXP.build(b, S.cfg, opt);
          U.download(res.blob, EXP.fileName($('#expName').value, b));
          $('#expHint').textContent = `已导出 ${b.shop} ${parseInt(b.ym.slice(2), 10)}月，合计 ¥${U.money(res.total)}`;
          await new Promise(r => setTimeout(r, 400));
        }
        toast(`导出完成，共 ${books.length} 个文件`, 'ok');
      } catch (e) {
        console.error(e);
        toast('导出失败：' + e.message, 'err');
        $('#expHint').textContent = '导出失败：' + e.message;
      }
      $('#btnExport').disabled = false;
    },

    /* ================= 设置 ================= */
    bindSet() {
      $('#apiPreset').onchange = () => {
        const p = S.PRESETS[$('#apiPreset').value];
        if (p) { $('#apiBase').value = p.base; $('#apiModel').value = p.model; }
      };
      $('#btnSaveApi').onclick = async () => {
        S.cfg.api = {
          preset: $('#apiPreset').value, base: $('#apiBase').value.trim(),
          model: $('#apiModel').value.trim(),
          mobileModel: $('#apiMobileModel').value.trim(),
          key: $('#apiKey').value.trim(),
          conc: parseInt($('#apiConc').value, 10) || 6,
          maxw: parseInt($('#apiMaxW').value, 10) || 1800,
          proxy: $('#apiProxy').value.trim(),
          desktopEnhance: $('#apiDesktopEnhance').checked
        };
        await S.saveCfg();
        toast('已保存', 'ok'); this.renderThumbs();
      };
      $('#btnTestApi').onclick = async () => {
        if (!OCR || !OCR.test) {
          $('#apiMsg').textContent = '✗ OCR 模块未加载，请按 Ctrl+F5 强制刷新';
          toast('OCR 模块未加载', 'err');
          return;
        }
        const api = {
          base: $('#apiBase').value.trim(), model: $('#apiModel').value.trim(),
          key: $('#apiKey').value.trim(), proxy: $('#apiProxy').value.trim()
        };
        $('#apiMsg').textContent = '测试中…';
        try {
          const r = await OCR.test(api);
          $('#apiMsg').textContent = '✓ 连接正常：' + r.slice(0, 30);
          toast('接口连接正常', 'ok');
        } catch (e) {
          $('#apiMsg').textContent = '✗ ' + e.message;
          toast('连接失败', 'err');
        }
      };
      $('#btnSaveCfg').onclick = async () => {
        S.cfg.cats = $('#cfgCats').value.split('\n').map(s => s.trim()).filter(Boolean);
        S.cfg.dailyCats = $('#cfgDaily').value.split(/[,，、\s]+/).map(s => s.trim()).filter(Boolean);
        S.cfg.thAuto = parseFloat($('#cfgAuto').value) || 0.92;
        S.cfg.thRev = parseFloat($('#cfgRev').value) || 0.85;
        S.cfg.tol = parseFloat($('#cfgTol').value) || 0.01;
        await S.saveCfg();
        this.fillCatSelect($('#ocrCat'), true);
        this.fillCatSelect($('#rawCat'), true);
        toast('规则已保存', 'ok');
      };
      $('#btnBackup').onclick = async () => {
        const d = await S.dump();
        U.download(new Blob([JSON.stringify(d)], { type: 'application/json' }),
          `采购汇总台备份_${new Date().toISOString().slice(0, 10)}.json`);
      };
      $('#btnRestore').onclick = () => $('#fileRestore').click();
      $('#fileRestore').onchange = async e => {
        const f = e.target.files[0]; if (!f) return;
        try {
          const d = JSON.parse(await f.text());
          await S.restore(d, false);
          this.items = await S.allItems(); M.buildIndex(this.items);
          await this.refreshBooks(); this.fillSettings(); this.renderAll();
          toast('备份已恢复', 'ok');
        } catch (err) { toast('恢复失败：' + err.message, 'err'); }
        e.target.value = '';
      };
      $('#btnWipe').onclick = () => this.confirm('确定清除本浏览器内的全部数据？包括商品库和所有账套，不可撤销。建议先做一次备份导出。', async () => {
        await S.wipe();
        this.items = []; this.book = null; M.buildIndex([]);
        await this.refreshBooks(); this.fillSettings(); this.renderAll();
        toast('已清除', 'ok');
      });
    },

    fillSettings() {
      const a = S.cfg.api;
      $('#apiPreset').value = a.preset || '';
      $('#apiBase').value = a.base || '';
      $('#apiModel').value = a.model || '';
      $('#apiMobileModel').value = a.mobileModel || '';
      $('#apiKey').value = a.key || '';
      $('#apiConc').value = a.conc || 6;
      $('#apiMaxW').value = a.maxw || 1800;
      $('#apiProxy').value = a.proxy || '';
      $('#apiDesktopEnhance').checked = !!a.desktopEnhance;
      $('#cfgCats').value = (S.cfg.cats || []).join('\n');
      $('#cfgDaily').value = (S.cfg.dailyCats || []).join('、');
      $('#cfgAuto').value = S.cfg.thAuto;
      $('#cfgRev').value = S.cfg.thRev;
      $('#cfgTol').value = S.cfg.tol;
      this.fillCatSelect($('#ocrCat'), true);
      this.fillCatSelect($('#rawCat'), true);
    },


    /* ================= 通用 UI ================= */
    modal(title, bodyEl, buttons) {
      $('#mdTitle').textContent = title;
      const b = $('#mdBody'); b.innerHTML = ''; b.appendChild(bodyEl);
      const f = $('#mdFoot'); f.innerHTML = '';
      (buttons || []).forEach(cfg => {
        const btn = el('button', { class: 'btn ' + (cfg.cls || ''), text: cfg.text });
        btn.onclick = async () => {
          let keep = false;
          if (cfg.fn) keep = await cfg.fn();
          if (!keep) $('#modal').hidden = true;
        };
        f.appendChild(btn);
      });
      $('#modal').hidden = false;
    },
    confirm(msg, fn, okText, cancelText) {
      const d = el('div', { html: `<div style="line-height:1.85;white-space:pre-wrap">${esc(msg)}</div>` });
      this.modal('请确认', d, [
        { text: cancelText || '取消', cls: '' },
        { text: okText || '确定', cls: 'primary', fn }
      ]);
    },

    renderAll() {
      this.renderThumbs();
      this.renderTable();
      this.renderDb();
      if (this.view === 'out') this.renderPreview();
    }
  };

  window.addEventListener('DOMContentLoaded', () => {
    App.init().catch(e => {
      console.error(e);
      const scripts = Array.from(document.querySelectorAll('script[src]')).map(s => {
        const ok = s.src && s.src.includes('?v=');
        return (ok ? '✓ ' : '✗ ') + (s.getAttribute('src') || '');
      }).join('\n');
      const runtime = (window.__runtimeErrors && window.__runtimeErrors.length) ? ('\n' + window.__runtimeErrors.join('\n')) : '(暂无运行时错误记录)';
      document.body.innerHTML = `<div style="padding:40px;font-family:sans-serif">
        <h2>启动失败</h2>
        <pre style="color:#c0392b;white-space:pre-wrap">${esc(e.message || e)}</pre>
        <p>请按 <b>F12</b> 打开控制台，查看具体的红色报错信息，然后截图给我。</p>
        <p>如果是通过双击 index.html 打开的，请改用附带的启动脚本（浏览器对本地文件的数据库有限制）。</p>
        <pre style="background:#f4f4f4;padding:10px;border-radius:4px">已加载脚本列表：\n${esc(scripts)}</pre>
        <pre style="background:#fff3f3;padding:10px;border-radius:4px;margin-top:10px">运行时错误记录：\n${esc(runtime)}</pre></div>`;
    });
  });
  g.App = App;
})(window);
