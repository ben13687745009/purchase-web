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

  // 常见 OCR 错字纠正：把高频误读映射回标准名称
  const TYPOS = {
    '咖士汁': '瑞士汁',
    '咖土汁': '瑞士汁',
    '黑淑': '黑椒汁',
    '黑淑汁': '黑椒汁',
    '冬荫功': '冬阴功',
    '冬荫功酱': '冬阴功',
    '咖哩': '咖喱',
    '咖哩汁': '咖喱汁'
  };

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
     * 策略（2026-08-30）：以识别到的名称为准，商品库只作单价参考/名称校验，不覆盖清晰识别名。
     *  a. 品名为空 → 只有在同分类下单价唯一命中时才反查品名
     *  b. 精确/别名/fuzzy 命中 → 只取商品库参考价/分类，不改名
     *  c. fuzzy 命中但 < thAuto → 标待核对，不改名
     *  d. 未命中 → 保留原名，标新品待核对
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

      // b. 精确命中：不改识别到的名称，仅把商品库参考价/分类带回去作校验
      if (cat) {
        const hit = this.idx.byKey.get(cat + '|' + nraw);
        if (hit) { out.price = U.ok(price) ? price : hit.ref; out.score = 1; out.source = 'exact'; out.cat = hit.cat; return out; }
      } else {
        for (const it of this.idx.all) {
          if (U.normName(it.name) === nraw) {
            out.price = U.ok(price) ? price : it.ref; out.score = 1; out.source = 'exact'; out.cat = it.cat; return out;
          }
        }
      }

      // c. 别名精确命中：同样保留识别名称
      for (const it of pool) {
        if (it.alias && it.alias.some(a => U.normName(a) === nraw)) {
          out.price = U.ok(price) ? price : it.ref; out.score = 1; out.source = 'alias'; out.cat = it.cat; return out;
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
        out.price = U.ok(price) ? price : best.ref; out.score = bs;
        out.source = bs >= 0.999 ? 'exact' : 'fuzzy'; out.cat = best.cat;
        return out;
      }
      if (best && bs >= thRev) {
        out.price = U.ok(price) ? price : best.ref; out.score = bs;
        out.source = 'fuzzy-low'; out.review = true; out.cat = best.cat;
        return out;
      }
      // 未命中：保留原名，标待核对（库里没有的新品）
      out.source = 'new'; out.review = true; out.score = bs;
      return out;
    },

    /* ---------- 三缺一反推（识别原值优先 + 数据库补全兜底）----------
     *
     * 核心原则（2026-08-31 最终版）：
     *   1. 金额、单价、数量都以 OCR 识别到的原值为准，最高优先级。
     *   2. 金额 ÷ 单价 = 数量 仅用于校验，绝不覆盖已经识别到的数量。
     *   3. 校验差值在 0.02 ~ 1.0 之间视为正常手写/称重误差，保留识别值，不标 review。
     *   4. 只有当数量缺失、为 0、或为非正数时，才用金额÷单价推算。
     *   5. 三值齐全但不一致时，仍然保留 OCR 识别原值，仅标记待核对。
     */
    reconcile(qty, price, amount, refPrice, tol) {
      tol = tol || 0.02;
      const derived = [];
      let review = false, note = '';
      let q = qty, p = price, a = amount;
      const hasQ = U.ok(q) && q > 0;
      const hasP = U.ok(p) && p > 0;
      const hasA = U.ok(a) && a > 0;

      // 有金额 + 有单价：用金额÷单价做校验，但绝不改写 OCR 识别数量
      if (hasA && hasP) {
        const calcQ = U.r4(a / p);
        const diff = hasQ ? Math.abs(q - calcQ) : Infinity;
        // 用户规则：差值在 0.02 ~ 1.0 之间视为允许误差（称重/手写常见）
        const tolRange = Math.max(0.02, Math.min(1.0, calcQ * 0.02));

        if (hasQ) {
          if (diff <= tolRange) {
            // 校验通过：保留识别数量，不标 review
            note = `金额÷单价=${U.fmt(calcQ)}，识别数量${U.fmt(q)}校验一致（差${U.fmt(diff)}）`;
          } else {
            // 校验不通过：仍然保留识别数量，仅标记待核对
            review = true;
            note = `识别数量${U.fmt(q)}与金额÷单价${U.fmt(calcQ)}偏差${U.fmt(diff)}，已保留识别原值，请核对`;
          }
        } else {
          // 数量缺失：才允许用金额÷单价推算
          q = calcQ; derived.push('qty');
          note = `数量缺失，按金额÷单价=${U.fmt(calcQ)}推算`;
          if (Math.abs(calcQ - Math.round(calcQ)) > 0.05 && Math.abs(calcQ - Math.round(calcQ * 10) / 10) > 0.05) review = true;
        }
        return { qty: q, price: p, amount: a, derived, review, note };
      }

      // 有金额 + 无单价
      if (hasA && !hasP) {
        if (U.ok(refPrice) && refPrice > 0) {
          p = refPrice; derived.push('price');
          q = U.r4(a / p); derived.push('qty');
          note = '单价取自商品库(' + U.fmt(refPrice) + ')，数量=金额÷单价';
          review = true;
        } else if (hasQ) {
          p = U.r4(a / q); derived.push('price');
          note = '单价 = 金额 ÷ 数量';
        } else {
          review = true; note = '仅有金额，缺少单价和数量，无法反推';
        }
        return { qty: q, price: p, amount: a, derived, review, note };
      }

      // 无金额
      if (!hasA) {
        if (hasQ && hasP) {
          a = U.r2(q * p); derived.push('amount');
          note = '金额 = 数量 × 单价（无原始金额，计算得出）';
        } else if (hasQ && U.ok(refPrice) && refPrice > 0) {
          p = refPrice; derived.push('price');
          a = U.r2(q * p); derived.push('amount');
          note = '单价取自商品库，金额 = 数量 × 单价';
          review = true;
        } else if (hasP) {
          review = true; note = '仅有单价，缺少数量和金额';
        } else if (hasQ) {
          review = true; note = '仅有数量，缺少单价和金额';
        } else {
          review = true; note = '数量/单价/金额均未识别';
        }
        return { qty: q, price: p, amount: a, derived, review, note };
      }

      return { qty: q, price: p, amount: a, derived, review, note };
    },

    /* ---------- 辅助：判断数量是否像「合理的手写数量」----------
     * 合理数量特征：整数、或最多一位小数（如 1.5, 2.5, 144.5, 0.5）
     * 不合理：47.6, 190.4, 95.9184, 57.1429, 5.7895（明显是除法余数）
     * 允许小浮点误差（如 1.0128 ≈ 1）
     */
    _isNiceQty(v) {
      if (!U.ok(v) || v <= 0) return false;
      // 数量太小（< 0.1）永远不合理——采购单不会买 0.01 份东西
      if (v < 0.1) return false;
      // 整数（允许±0.05浮点误差）
      if (Math.abs(v - Math.round(v)) < 0.05) return true;
      // 一位小数（含 .5 及 144.5 等称重数量）
      if (Math.abs(v - Math.round(v * 10) / 10) < 0.05) return true;
      return false;
    },

    /* ---------- 单位处理 ----------
     * 2026-08-30：不再从 name 末尾截断疑似单位字。单据「商品名称」列里的文字
     *（包括 方包/牛角包/菠萝包/长方盒 的「包」「盒」）都应原样保留在 name 中。
     * unit 只取 OCR 明确返回的单位列，没有就空着，避免误删商品名称尾字。
     */
    _splitUnit(name, rawUnit) {
      const n = String(name || '').trim();
      if (rawUnit) return { name: n, unit: U.normUnit(rawUnit) };
      return { name: n, unit: '' };
    },

    /* ---------- 单行完整处理 ---------- */
    processRow(raw, cfg, defMonth) {
      const forceCat = raw.forceCat || '';
      // 拆分单位：OCR 可能把「箱/包」等塞进 name
      const nameUnit = this._splitUnit(raw.name, raw.unit);
      // 常见错字纠正（必须在 matchName 之前做，否则 fuzzy 可能越走越远）
      let fixedName = nameUnit.name;
      for (const bad in TYPOS) {
        if (U.normName(fixedName) === U.normName(bad)) {
          fixedName = TYPOS[bad];
          break;
        }
      }
      const row = {
        id: raw.id || U.uid(),
        date: U.parseDate(raw.date, defMonth),
        cat: forceCat || raw.cat || '',
        name: fixedName,
        unit: nameUnit.unit,
        qty: U.toNum(raw.qty),
        price: U.toNum(raw.price),
        amount: U.toNum(raw.amount),
        rawAmount: U.ok(raw.rawAmount) ? U.toNum(raw.rawAmount) : U.toNum(raw.amount), // 原始识别到的金额（不换算），表格直接显示此值
        src: raw.src || 'manual',
        photo: raw.photo || '',
        rawName: nameUnit.name,
        seq: raw.seq || 0,
        flags: { derived: [], nameSrc: '', score: 0, review: false, note: '' }
      };
      const rawQty = row.qty, rawPrice = row.price, rawAmount = row.amount;

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

      // 品名匹配：以识别到的名称为准，不改名；商品库仅作单价参考/校验
      const mn = this.matchName(row.name, row.cat, row.price, cfg);
      row.flags.nameSrc = mn.source;
      row.flags.score = U.r2(mn.score);

      const fixNotes = [];
      // 反推（金额优先，单价/数量均采用原图识别值；不再因为≥100做÷100修正）
      const rc = this.reconcile(row.qty, row.price, row.amount, mn.price, cfg.tol);
      row.qty = rc.qty; row.price = rc.price; row.amount = rc.amount;
      row.flags.derived = rc.derived;
      if (rc.note) fixNotes.push(rc.note);

      // 不再做「分→元」或「单价≥100 强制÷100」相关兜底：金额与单价按原值保留，由用户在表格中核对。

      row.flags.review = mn.review || rc.review || row.flags.review;
      if (nameUnit.unit) fixNotes.unshift(`识别单位：${nameUnit.unit}`);
      row.flags.note = [mn.review && mn.source === 'fuzzy-low' ? `品名近似匹配(${U.r2(mn.score)})，请确认` : '',
                        mn.source === 'new' ? '商品库中无此品名，可能是新品或识别有误' : '',
                        mn.source === 'db-price' ? '品名按历史单价反查得出，请确认' : '',
                        mn.source === 'blank' ? '品名未识别' : '',
                        ...fixNotes].filter(Boolean).join('；');
      return row;
    },

    /* ---------- 批量处理 ---------- */
    processAll(rows, cfg, defMonth) {
      const out = rows.map(r => this.processRow(r, cfg, defMonth));
      return this.detectSerial(out);
    },

    /* ---------- 同单据串行/重复检测 ----------
     * 行与行之间数字串读是高频错误：A 行的金额跑到 B 行金额位、B 行数量跑到 C 行。
     * 这里只做「疑似」标记（review=true），提示人工核对，绝不自动改写，避免二次破坏。
     * 检测（同一张照片内的相邻行）：
     *   相邻两行 amount 完全相同且数量都为 1 → 可能复制串行。
     */
    detectSerial(rows) {
      const groups = new Map();
      rows.forEach((r, i) => {
        const k = r.photo || ('__s' + i);
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(r);
      });
      groups.forEach(grp => {
        for (let i = 1; i < grp.length; i++) {
          const cur = grp[i], prev = grp[i - 1];
          if (U.ok(cur.amount) && U.ok(prev.amount) &&
              Math.abs(cur.amount - prev.amount) < 0.005 &&
              U.ok(cur.qty) && Math.abs(cur.qty - 1) < 0.05 &&
              U.ok(prev.qty) && Math.abs(prev.qty - 1) < 0.05) {
            cur.flags.review = true;
            cur.flags.note = (cur.flags.note ? cur.flags.note + '；' : '') +
              `相邻行金额完全相同(${U.fmt(cur.amount)})，疑似串行复制，请核对原单`;
          }
        }
      });
      return rows;
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
          it = { id, cat: r.cat, name: r.name, prices: [], ref: null, low: null, high: null, n: 0, shops: [], alias: [], last: ym || '', unit: '' };
          map.set(id, it); added++;
        } else updated++;
        // 记录归一化后的单位（OCR/拆分得到的写法统一为标准）
        if (U.ok(r.unit)) it.unit = U.normUnit(r.unit);
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
