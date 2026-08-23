/* ============================================================
 * matcher.js — 匹配 / 反推 / 合并引擎
 *   1. 三缺一反推：数量 单价 金额 互推
 *   2. 品名模糊匹配商品库，补全名称规格与历史单价
 *   3. 分类兜底推断
 *   4. 同日期同名合并
 * ============================================================ */
(function (g) {
  'use strict';
  const U = g.U;

  /* 品名关键词兜底分类（文件名/OCR 未给出分类时用） */
  const CAT_KW = {
    '茶粉': ['淡奶', '配茶', '拼配茶', '红茶', '茶碎', '糕粉', '朱古力粉', '咖啡粉', '椰乳', '爆珠', '椰果', '乌龙', '茉莉', '芝士片', '牛奶', '奶精', '果糖'],
    '汁水': ['黑椒汁', '烧汁', '茄汁', '咖喱汁', '瑞士汁', '糖醋汁', '肉酱', '汁'],
    '包装品': ['长方盒', '正方盒', '筷子更', '筷子', '单袋', '双袋', '小logo袋', 'logo袋', '打包', '热敏纸', '手套', '杯', '盖', '叉', '刀', '勺', '洗洁精', '漂白水', '垃圾袋', '保鲜膜'],
    '粮油': ['米', '鸡蛋', '调和油', '花生油', '生粉', '排粉', '粉丝', '砂糖', '幼砂糖', '牛油', '冬菇', '椰子酱', '五柳菜'],
    '面包': ['方包', '牛角包', '菠萝包', '餐包', '吐司'],
    '鲜肉': ['肉眼', '肉碎', '上肉碎', '花肉', '梅肉', '排骨', '猪肚', '牛肉', '鸡胸', '猪', '肉花', '肉'],
    '环绿蔬菜': ['菜心', '生菜', '西兰花', '青瓜', '番茄', '洋葱', '土豆', '姜', '蒜', '葱', '蔬菜'],
    '创银': ['虾仁', '牛扒', '西冷', '鱿鱼', '蟹柳', '鸡排', '肠', '盐酥鸡', '牛肉片', '鸣门卷', '闽门卷'],
    '裕笙隆': ['豆豉', '酱', '味露', '鱼露', '吉士粉', '咖喱粉', '黄姜粉', '辣鲜露', '双蒸酒', '酸青瓜', '沙律']
  };

// 常见手写短名（笔画少、极易误读）：在 fuzzy 匹配时放宽阈值
  const COMMON_SHORT_NAMES = [
    '肉眼','肉碎','上肉碎','花肉','梅肉','排骨','牛肉片','牛肉','鸡胸','猪肚',
    '菜心','生菜','西兰花','青瓜','番茄','洋葱','土豆','姜','蒜','葱',
    '冬菇','砂糖','幼砂糖','生粉','五柳菜','鸡蛋','米','调和油','花生油',
    '方包','餐包','吐司','菠萝包','牛角包',
    '淡奶','红茶','茶碎','椰乳','椰果','芝士片','牛奶','果糖',
    '长方盒','正方盒','打包盒','筷子','手套','杯','盖',
    '黑椒汁','烧汁','茄汁','咖喱汁','瑞士汁','糖醋汁','肉酱'
  ];

  const M = {
    /* 商品库索引：{ byKey: Map, byCat: Map<cat, [item]>, all: [] } */
    idx: { byKey: new Map(), byCat: new Map(), all: [] },

    buildIndex(items) {
      const byKey = new Map(), byCat = new Map();
      (items || []).forEach(it => {
        byKey.set(it.cat + '|' + U.normName(it.name), it);
        if (!byCat.has(it.cat)) byCat.set(it.cat, []);
        byCat.get(it.cat).push(it);
      });
      this.idx = { byKey, byCat, all: items || [] };
      return this.idx;
    },

    /* ---------- 分类推断 ---------- */
    guessCat(name, cats) {
      const n = U.normName(name);
      if (!n) return '';
      // 先查商品库精确/近似
      let best = null, bs = 0;
      this.idx.all.forEach(it => {
        const s = U.sim(name, it.name);
        if (s > bs) { bs = s; best = it; }
      });
      if (best && bs >= 0.9) return best.cat;
      // 关键词兜底
      for (const c of (cats || Object.keys(CAT_KW))) {
        const kws = CAT_KW[c];
        if (!kws) continue;
        for (const k of kws) {
          if (n.indexOf(U.normName(k)) >= 0) return c;
        }
      }
      if (best && bs >= 0.75) return best.cat;
      return '';
    },

    /* ---------- 品名匹配 ----------
     * 返回 {name, price, score, source, review}
     * 策略（保守，防张冠李戴）：
     *  a. 品名为空 → 只有在同分类下单价唯一命中时才反查品名
     *  b. 精确命中 → 直接用
     *  c. fuzzy ≥ thAuto 自动纠正；thRev~thAuto 纠正但标待核对；< thRev 保留原名
     *  d. 包含匹配要求长度比 ≥0.5 或前缀，防止"花生"→"花生酱"
     */
    matchName(raw, cat, price, cfg) {
      const thAuto = cfg.thAuto, thRev = cfg.thRev;
      const pool = (cat && this.idx.byCat.get(cat)) || this.idx.all;
      const out = { name: raw || '', price: null, score: 0, source: '', review: false, cat: cat || '' };

      // a. 品名为空：用单价反查
      if (!String(raw || '').trim()) {
        if (U.ok(price) && pool.length) {
          const hits = pool.filter(it => U.ok(it.ref) && Math.abs(it.ref - price) <= Math.max(0.01, price * 0.005));
          if (hits.length === 1) {
            out.name = hits[0].name; out.price = hits[0].ref; out.score = 0.8;
            out.source = 'db-price'; out.review = true; out.cat = hits[0].cat;
            return out;
          }
        }
        out.review = true; out.source = 'blank';
        return out;
      }

      const nraw = U.normName(raw);

      // b. 精确
      if (cat) {
        const hit = this.idx.byKey.get(cat + '|' + nraw);
        if (hit) { out.name = hit.name; out.price = U.ok(price) ? price : hit.ref; out.score = 1; out.source = 'exact'; out.cat = hit.cat; return out; }
      } else {
        for (const it of this.idx.all) {
          if (U.normName(it.name) === nraw) {
            out.name = it.name; out.price = U.ok(price) ? price : it.ref; out.score = 1; out.source = 'exact'; out.cat = it.cat; return out;
          }
        }
      }

      // c. 别名精确命中
      for (const it of pool) {
        if (it.alias && it.alias.some(a => U.normName(a) === nraw)) {
          out.name = it.name; out.price = U.ok(price) ? price : it.ref; out.score = 1; out.source = 'alias'; out.cat = it.cat; return out;
        }
      }

      // d. fuzzy（同时考虑单价一致性加权）
      let best = null, bs = 0;
      const scan = pool.length ? pool : this.idx.all;
      scan.forEach(it => {
        let s = U.sim(raw, it.name);
        // 常见短名手写误读：相似度够高时额外加分，但严格保留 review 标记
        if (COMMON_SHORT_NAMES.indexOf(it.name) >= 0 && s >= 0.78) {
          s = Math.min(1, s + 0.08);
        }
        // 包含匹配的长度比约束
        const a = nraw, b = U.normName(it.name);
        if (s < 0.99 && (a.indexOf(b) >= 0 || b.indexOf(a) >= 0)) {
          const ratio = Math.min(a.length, b.length) / Math.max(a.length, b.length);
          if (ratio >= 0.5 || b.indexOf(a) === 0 || a.indexOf(b) === 0) s = Math.max(s, 0.86 * ratio + 0.14);
        }
        // 单价吻合 → 加分
        if (U.ok(price) && U.ok(it.ref) && Math.abs(it.ref - price) <= Math.max(0.01, price * 0.01)) s = Math.min(1, s + 0.06);
        if (s > bs) { bs = s; best = it; }
      });

      if (best && bs >= thAuto) {
        out.name = best.name; out.price = U.ok(price) ? price : best.ref; out.score = bs;
        out.source = bs >= 0.999 ? 'exact' : 'fuzzy'; out.cat = best.cat;
        return out;
      }
      if (best && bs >= thRev) {
        out.name = best.name; out.price = U.ok(price) ? price : best.ref; out.score = bs;
        out.source = 'fuzzy-low'; out.review = true; out.cat = best.cat;
        return out;
      }
      // 未命中：保留原名，标待核对（库里没有的新品）
      out.source = 'new'; out.review = true; out.score = bs;
      return out;
    },

    /* ---------- 三缺一反推（以 OCR 识别为准，校验为辅）----------
     *
     * 核心原则：OCR 识别出的数量、单价、金额优先保留；校验只用于补全缺失字段
     * 或标记明显矛盾，不主动覆盖 OCR 已识别出的合理数值。
     *
     * 策略：
     *   ① 三值齐全且一致       → 全部保留
     *   ② 三值齐全但不一致     → 保留 OCR 原始值，标记待核对（不自动修正）
     *   ③ 有金额+单价          → 数量 = 金额 ÷ 单价（数量缺失时）
     *   ④ 有金额+数量          → 单价 = 金额 ÷ 数量（单价缺失时）
     *   ⑤ 只有金额             → 查数据库单价 → 反推数量；无库价则标待核对
     *   ⑥ 无金额               → 数量×单价算金额（最后手段）
     */
    reconcile(qty, price, amount, refPrice, tol) {
      tol = tol || 0.01;
      const derived = [];
      let review = false, note = '';
      const hasQ = U.ok(qty), hasP = U.ok(price), hasA = U.ok(amount);

      // ===== 情况 ①/②：三值齐全 → 一致性校验，不一致时保留 OCR 原始值并标记 =====
      if (hasQ && hasP && hasA) {
        const calcAmount = U.r2(qty * price);
        const diff = Math.abs(calcAmount - amount);
        const relDiff = diff / Math.max(Math.abs(amount), 1e-9);
        if (relDiff <= tol || diff <= 0.02) {
          return { qty, price, amount, derived, review, note }; // 一致，全保留
        }
        // 不一致：以 OCR 为准，仅标记待核对
        review = true;
        note = `三值不一致：数量${U.fmt(qty)}×单价${U.fmt(price)}=${U.fmt(calcAmount)}，金额${U.fmt(amount)}，请按原始单据核对`;
        return { qty, price, amount, derived, review, note };
      }

      // ===== 情况 ⑤：只有金额 =====
      if (hasA && !hasQ && !hasP) {
        if (U.ok(refPrice)) {
          price = refPrice; derived.push('price');
          qty = U.r4(amount / price); derived.push('qty');
          note = '仅有金额，单价取自商品库(' + U.fmt(refPrice) + ')，数量=金额÷单价';
          review = true;
        } else {
          review = true; note = '仅有金额且商品库无参考价，无法反推数量和单价';
        }
        return { qty, price, amount, derived, review, note };
      }

      // ===== 情况 ③：有金额+单价（没有数量）→ 以金额为准算数量 =====
      if (hasA && hasP) {
        qty = U.r4(amount / price); derived.push('qty');
        note = '数量 = 金额 ÷ 单价';
        return { qty, price, amount, derived, review, note };
      }

      // ===== 情况 ④：有金额+数量（没有单价）→ 以金额为准算单价 =====
      if (hasA && hasQ && !hasP) {
        price = U.r4(amount / qty); derived.push('price');
        note = '单价 = 金额 ÷ 数量';
        return { qty, price, amount, derived, review, note };
      }

      // ===== 情况 ⑥：没有金额 =====
      if (!hasA) {
        if (hasQ && hasP) {
          amount = U.r2(qty * price); derived.push('amount');
          note = '金额 = 数量 × 单价（无原始金额，计算得出）';
        } else if (hasQ && U.ok(refPrice)) {
          price = refPrice; derived.push('price');
          amount = U.r2(qty * price); derived.push('amount');
          note = '单价取自商品库，金额 = 数量 × 单价';
          review = true;
        } else if (hasP) {
          review = true; note = '仅有单价，缺少数量和金额';
        } else if (hasQ) {
          review = true; note = '仅有数量，缺少单价和金额';
        } else {
          review = true; note = '数量/单价/金额均未识别';
        }
        return { qty, price, amount, derived, review, note };
      }

      return { qty, price, amount, derived, review, note };
    },

    /* ---------- 辅助：判断数量是否像「合理的手写数量」----------
     * 合理数量特征：整数、或 .0/.5 结尾的简单小数（如 1.5, 2.5, 0.5）
     * 不合理：47.6, 190.4, 95.9184, 57.1429, 5.7895（明显是除法余数）
     * 允许小浮点误差（如 1.0128 ≈ 1）
     */
    _isNiceQty(v) {
      if (!U.ok(v) || v <= 0) return false;
      // 数量太小（< 0.1）永远不合理——采购单不会买 0.01 份东西
      if (v < 0.1) return false;
      const rv = Math.round(v);
      // 整数（允许±0.05浮点误差）
      if (Math.abs(v - rv) < 0.05) return true;
      // .5 结尾的半数（允许±0.05误差）
      if (v < 50 && Math.abs(v - Math.round(v * 2) / 2) < 0.05) return true;
      // 一位小数且 >= 0.5（允许±0.05误差，用于 6.71≈7 这类情况）
      if (v >= 0.5 && v < 10 && Math.abs(v - Math.round(v * 10) / 10) < 0.05) return true;
      return false;
    },

    /* ---------- 单行完整处理 ---------- */
    processRow(raw, cfg, defMonth) {
      const forceCat = raw.forceCat || '';
      const row = {
        id: raw.id || U.uid(),
        date: U.parseDate(raw.date, defMonth),
        cat: forceCat || raw.cat || '',
        name: String(raw.name || '').trim(),
        qty: U.toNum(raw.qty),
        price: U.toNum(raw.price),
        amount: U.toNum(raw.amount),
        src: raw.src || 'manual',
        photo: raw.photo || '',
        rawName: String(raw.name || '').trim(),
        seq: raw.seq || 0,
        flags: { derived: [], nameSrc: '', score: 0, review: false, note: '' }
      };

      // 每日汇总行（如环绿蔬菜）：数量列是「商品品种数」，不参与单价/金额反推
      if (raw.daily) {
        row.daily = true;
        row.price = null;
        row.flags.nameSrc = 'daily';
        row.flags.score = 1;
        row.flags.review = !U.ok(row.amount);
        row.flags.note = U.ok(row.amount) ? '每日汇总行（数量列为品种数）' : '每日汇总行缺金额';
        return row;
      }

      // 分类：强制分类最高优先（用户一次上传同类单据时锁定，屏蔽 OCR 返回的供应商名/其他分类）
      if (forceCat) {
        row.cat = forceCat;
      } else {
        // OCR 可能把供应商/送货人名当成分类，若不在标准清单里则丢弃。
        // 不按品名字眼自动推断分类——分类只来自用户强制选择、或 Excel 自带/文件名的分类。
        if (row.cat && cfg.cats && cfg.cats.indexOf(row.cat) < 0) row.cat = '';
      }

      // 品名匹配（仅标准化名称/补全单价，不回填分类）
      const mn = this.matchName(row.name, row.cat, row.price, cfg);
      if (mn.name && mn.name !== row.name) row.name = mn.name;
      row.flags.nameSrc = mn.source;
      row.flags.score = U.r2(mn.score);

      // 反推（金额优先）
      const rc = this.reconcile(row.qty, row.price, row.amount, mn.price, cfg.tol);
      row.qty = rc.qty; row.price = rc.price; row.amount = rc.amount;
      row.flags.derived = rc.derived;

      // ★ 数据库单价校验（仅作提示，不覆盖 OCR 识别结果）
      // 用户要求「以识别的单据为准，校验为辅」，因此当 OCR 单价与数据库参考价偏差较大时，
      // 只标记待核对并给出提示，不自动修正数量或单价。
      if (U.ok(row.amount) && U.ok(mn.price) && U.ok(row.price)) {
        const priceDev = Math.abs(row.price - mn.price) / Math.max(mn.price, 1);
        if (priceDev > 0.20) {
          row.flags.review = true;
          row.flags.note = (row.flags.note ? row.flags.note + '；' : '') +
            `单价${U.fmt(row.price)}与数据库参考价${U.fmt(mn.price)}差异较大，请核对原始单据`;
        }
      }

      row.flags.review = mn.review || rc.review || row.flags.review;
      row.flags.note = [mn.review && mn.source === 'fuzzy-low' ? `品名近似匹配(${U.r2(mn.score)})，请确认` : '',
                        mn.source === 'new' ? '商品库中无此品名，可能是新品或识别有误' : '',
                        mn.source === 'db-price' ? '品名按历史单价反查得出，请确认' : '',
                        mn.source === 'blank' ? '品名未识别' : '',
                        rc.note].filter(Boolean).join('；');
      return row;
    },

    /* ---------- 批量处理 ---------- */
    processAll(rows, cfg, defMonth) {
      return rows.map(r => this.processRow(r, cfg, defMonth));
    },

    /* ---------- 同日期同名合并 ----------
     * 同 分类+日期+名称 → 数量金额求和，单价 = 金额 ÷ 数量
     * 品名为空的行不合并，独立保留
     */
    dedup(rows) {
      const out = [], map = new Map();
      rows.forEach(r => {
        const key = r.cat + '|' + r.date + '|' + U.normName(r.name);
        if (!r.name || !U.normName(r.name)) { out.push(r); return; }
        if (!map.has(key)) { map.set(key, r); out.push(r); return; }
        const t = map.get(key);
        const q = (U.ok(t.qty) ? t.qty : 0) + (U.ok(r.qty) ? r.qty : 0);
        const a = (U.ok(t.amount) ? t.amount : 0) + (U.ok(r.amount) ? r.amount : 0);
        t.qty = U.ok(q) ? U.r4(q) : t.qty;
        t.amount = U.ok(a) ? U.r2(a) : t.amount;
        if (U.ok(t.qty) && U.ok(t.amount)) t.price = U.r4(t.amount / t.qty);
        t.flags.note = (t.flags.note ? t.flags.note + '；' : '') + '已合并同日同名行';
        t.flags.merged = (t.flags.merged || 1) + 1;
      });
      return out;
    },

    /* ---------- 从行数据学习回商品库 ----------
     * 仅学习未标待核对且信息完整的行，避免污染
     */
    learn(rows, items, shop, ym) {
      const map = new Map();
      (items || []).forEach(it => map.set(it.id, it));
      let added = 0, updated = 0;
      rows.forEach(r => {
        if (r.flags && r.flags.review) return;
        if (!r.name || !r.cat || !U.ok(r.price)) return;
        const id = r.cat + '|' + U.normName(r.name);
        let it = map.get(id);
        if (!it) {
          it = { id, cat: r.cat, name: r.name, prices: [], ref: null, low: null, high: null, n: 0, shops: [], alias: [], last: ym || '' };
          map.set(id, it); added++;
        } else updated++;
        it.prices.push(r.price);
        if (it.prices.length > 40) it.prices = it.prices.slice(-40);
        it.ref = U.mode(it.prices);
        it.low = Math.min.apply(null, it.prices);
        it.high = Math.max.apply(null, it.prices);
        it.n = (it.n || 0) + 1;
        if (shop && it.shops.indexOf(shop) < 0) it.shops.push(shop);
        if (ym && (!it.last || ym > it.last)) it.last = ym;
      });
      return { list: Array.from(map.values()), added, updated };
    },

    /* ---------- 整文件级分类 ----------
     * 扫描一批品名，按关键词统计返回占优的分类。
     * 用于「一个 Excel 文件 = 一个分类」：未强制、文件名无线索时，
     * 扫描文件内所有品名，把整文件归到命中最多的分类。
     */
    scanNamesCat(names, cats) {
      const cands = (cats && cats.length) ? cats : Object.keys(CAT_KW);
      const score = {};
      cands.forEach(c => {
        const kws = CAT_KW[c];
        if (!kws) return;
        names.forEach(nm => {
          const nn = U.normName(nm || '');
          if (!nn) return;
          for (let i = 0; i < kws.length; i++) {
            if (nn.indexOf(U.normName(kws[i])) >= 0) { score[c] = (score[c] || 0) + 1; break; }
          }
        });
      });
      let best = '', bv = 0;
      Object.keys(score).forEach(c => { if (score[c] > bv) { bv = score[c]; best = c; } });
      return best;
    },

    CAT_KW
  };

  g.Matcher = M;
})(window);
