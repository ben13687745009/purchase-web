/* ============================================================
 * importer.js — 解析历史标准汇总 Excel，构建商品数据库
 *   兼容表头：货品名称 / 名称及规格 / 品名及规格 / 名称和规格
 *   兼容两种格式：line_items（7列） 与 daily_summary（环绿蔬菜4列）
 *   日期沿用上一行；跳过 sheet 末尾的合计行
 * ============================================================ */
(function (g) {
  'use strict';
  const U = g.U;

  const NAME_HDR = ['名称和规格', '名称及规格', '货品名称', '品名及规格', '品名', '名称', '货品', '商品名称', '商品全名', '商品名'];
  const SPEC_HDR = ['规格', '型号'];
  const DAILY_HDR = ['商品品种统计', '品种统计', '商品品种'];

  function cellVal(ws, r, c) {
    if (!r || !c) return undefined;
    try {
      const cell = ws.getCell(r, c);
      let v = cell.value;
      if (v && typeof v === 'object') {
        if (v.result !== undefined) v = v.result;         // 公式
        else if (v.text !== undefined) v = v.text;         // 富文本
        else if (v.richText) v = v.richText.map(t => t.text).join('');
        else if (v instanceof Date) return v;
      }
      return v;
    } catch (e) {
      return undefined;
    }
  }
  function str(v) {
    if (v === null || v === undefined) return '';
    if (v instanceof Date) return v.toISOString();
    return String(v).trim();
  }

  /* 在前 15 行里找表头行；兼容合并单元格/跨列表头 */
  function findHeader(ws) {
    const maxR = Math.min(ws.rowCount || 1, 15);
    const maxC = Math.min(ws.columnCount || 1, 20);
    for (let r = 1; r <= maxR; r++) {
      const cells = [];
      for (let c = 1; c <= maxC; c++) cells.push(str(cellVal(ws, r, c)));
      const joined = cells.join('|');
      const hasName = NAME_HDR.some(h => joined.indexOf(h) >= 0) || DAILY_HDR.some(h => joined.indexOf(h) >= 0);
      const hasNum = /数量|单价|金额|合计/.test(joined);
        if (hasName && hasNum) {
        const col = {};
        cells.forEach((t, i) => {
          const c = i + 1;
          if (!t) return;
          const tc = t.replace(/\s+/g, '');
          if (/序号|序母|序號|NO\.?$/i.test(tc)) col.no = c;
          if (/日期/.test(tc)) col.date = c;
          if (DAILY_HDR.some(h => tc.indexOf(h) >= 0)) col.variety = c;
          if (NAME_HDR.some(h => tc.indexOf(h) >= 0)) col.name = col.name || c;
          if (SPEC_HDR.some(h => tc.indexOf(h) >= 0)) col.spec = col.spec || c;
          if (/数量/.test(tc)) col.qty = c;
          if (/单价/.test(tc)) col.price = c;
          if (/金额/.test(tc)) col.amount = c;
          if (/合计/.test(tc)) col.total = c;
          if (/单位/.test(tc)) col.unit = c;
        });
        return { row: r, col, daily: !!col.variety && !col.qty };
      }
    }
    return null;
  }

  /* 从 sheet 前若干行文本里提取 "录单日期" 或 "送货日期" */
  function findSheetDate(ws, maxRow) {
    maxRow = Math.min(maxRow || 12, ws.rowCount || 12);
    for (let r = 1; r <= maxRow; r++) {
      for (let c = 1; c <= 8; c++) {
        const t = str(cellVal(ws, r, c));
        const m = t.match(/(?:录单日期|送货日期|日期)[:：\s]*(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
        if (m) return `${+m[2]}.${+m[3]}`;
        const m2 = t.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
        if (m2) return `${+m2[2]}.${+m2[3]}`;
      }
    }
    return '';
  }

  /* 用文件名猜分类（不依赖 matcher，只作兜底） */
  function guessFileCat(fname, cats) {
    cats = cats || [];
    if (!cats.length || !fname) return '';
    const lower = fname.toLowerCase();
    for (let i = 0; i < cats.length; i++) {
      if (lower.indexOf(String(cats[i]).toLowerCase()) >= 0) return cats[i];
    }
    return '';
  }

  /* 清洗扫描王/出库单里的品名：去掉勾选符、行首行尾残留符、多余空白、换行 */
  function cleanName(nm) {
    if (!nm) return '';
    return String(nm)
      .replace(/[✓✔✗✘]/g, '')
      .replace(/\s+/g, ' ')
      .replace(/[\n\r]/g, ' ')
      .replace(/\/\d+\b/g, '')          // 去掉 /1、/2 这类勾选标记
      .replace(/\bV\b/g, '')            // 单独出现的勾选 V
      .replace(/^[\-/\\—–\s]+|[\-/\\—–\s]+$/g, '')  // 去掉行首行尾 斜杠/横杠/空格
      .replace(/[~～]/g, '')
      .trim();
  }

  /* 判断一行是否为商品数据行（正向判定：只有像商品的才录入）
   * 原则：宁可漏掉可疑行，也不能把制单人/送货日期/备注 当成商品录入
   */
  function looksLikeProduct(nm, qty, price, amount) {
    if (!nm) return false;
    const trimmed = nm.replace(/\s+/g, '');

    // --- 纯数字/编码/序号：一定不是商品名 ---
    // "70 70"、"664 664"、"6479 6479" 这类是内部编码或序号列溢出
    if (/^\d+$/.test(trimmed)) return false;                          // 纯数字
    if (/^(\d+)\s+\1$/.test(trimmed)) return false;                  // 重复数字 "70 70"
    if (/^(\d{2,5})\s+(\d{2,5})$/.test(trimmed)) return false;      // 两组短数字 "167 2540"
    // 品名以表头关键词开头（表头泄漏）：如 "商品名称 xxx"、"序号 xxx"
    if (/^(序号|商品名|商品名称|名称|货号|编码|代码|编号|NO?\.?|ID)[:：\s]/i.test(nm)) return false;
    // 品名太短（<2字符）且不含中文/字母 → 不是有效品名
    if (trimmed.length < 2 && !/[a-zA-Z\u4e00-\u9fff]/.test(nm)) return false;

    // --- 硬排除：品名以这些开头的一定不是商品 ---
    if (/^注[:：]|^备注|^说明|^此单|^具有法|^法律效/i.test(nm)) return false;
    if (/^制单人|^经办人|^送货人|^收货单位|^仓/i.test(nm)) return false;
    if (/^送货日期|^打印时间|^录单时间|^第\d+页.*共\d+页|^联客户|^白联回单/i.test(nm)) return false;
    if (/^总重量|^总件数|^合计.*[数量件数]|^净重|^金额.*[（(]/i.test(nm)) return false;

    // --- 正向信号：品名包含常见商品关键词（规格单位/食材名/包装单位）---
    const hasUnit = /\b(kg|g|斤|包|件|箱|ml|l|袋|盒|罐|瓶|条|只|个|磅|支|组|套|板|桶|篮|扎|捆|对|双|打|听|粒|片|块|颗|枚|碗|盘|碟|勺|叉|筷|张|卷|筒|根|段|节|束|串|笼|屉|垫|罩|批|副|付|罗|刀|剪|铲|夹|刷|布|纸|膜|绳|线|带|扣|环|签|标|贴|胶|蜡)\b/i.test(nm);
    const hasFood = /(牛肉|猪肉|鸡肉|鸭肉|鹅肉|羊肉|鱼肉|虾仁|蟹柳|牛排|猪排|鸡排|鸡翅|鸡腿|鸭掌|鹅肝|羊排|鱼丸|肉丸|蛋挞|面包|蛋糕|饼干|汤圆|饺子|包子|馒头|面条|米粉|河粉|意粉|乌冬|拉面|馄饨|云吞|烧麦|春卷|油条|麻花|豆浆|豆腐|豆奶|酸奶|奶酪|黄油|奶油|芝士|沙拉|果汁|可乐|雪碧|啤酒|白酒|红酒|普洱|龙井|乌龙|绿茶|红茶|咖啡|可可|巧克力|糖果|蜜饯|坚果|干果|瓜子|花生|核桃|杏仁|腰果|开心果|榛子|松子|栗子|莲子|百合|银耳|木耳|香菇|金针菇|茶树菇|平菇|口蘑|杏鲍菇|海鲜菇|草菇|竹笙|海带|紫菜|葛根|山药|红薯|紫薯|芋头|南瓜|冬瓜|丝瓜|苦瓜|黄瓜|萝卜|胡萝卜|白菜|菠菜|芹菜|生菜|油麦菜|空心菜|茼蒿|韭菜|香菜|洋葱|番茄|茄子|土豆|青椒|彩椒|辣椒|西兰花|花椰菜|四季豆|豇豆|扁豆|豌豆|毛豆|蚕豆|黄豆|绿豆|红豆|黑豆|薏米|燕麦|荞麦|小米|玉米|高粱|糙米|糯米|香米|大米|米粉|河粉|意粉|乌冬|拉面|馄饨|云吞|烧麦|春卷|油条|麻花|豆浆|豆腐|豆奶|酸奶|奶酪|黄油|奶油|芝士|沙拉|果汁|可乐|雪碧|啤酒|白酒|红酒|普洱|龙井|乌龙|绿茶|红茶|咖啡|可可|巧克力|糖果|蜜饯|坚果|干果|白糖|红糖|冰糖|黑糖|盐|醋|酱|酒|奶|粉|面|米|蛋|肉|鱼|虾|蟹|菜|果|豆|薯|葱|姜|蒜|椒|菇|耳|笋|腐|皮|骨|肠|肚|肝|心|翅|腿|排|腩|五花)/i.test(nm);
    if (hasUnit || hasFood) return true;

    // --- 数值合理性检查 ---
    const hasQ = typeof qty === 'number', hasP = typeof price === 'number', hasA = typeof amount === 'number';
    if (!hasQ && !hasP && !hasA) return false;  // 完全没数字
    // qty=price=amount 且都是 ≤3 的整数 → 元数据行（序号、页码等）
    if (hasQ && hasP && hasA && qty === price && qty === amount && qty <= 3) return false;
    // price 或 amount 是年份（2024-2030）
    if ((hasP && price >= 2024 && price <= 2030) || (hasA && amount >= 2024 && amount <= 2030)) return false;
    // 品名含"日期人单页联系电话仓库重量件数"且无商品关键词 → 不是商品
    if (/[日期人单页联系电话仓库重量件数]/.test(nm) && !hasUnit && !hasFood) return false;

    // 有合理单价(0.5~99999)或合理金额(1~99999) → 放行
    if ((hasP && price >= 0.5 && price <= 99999) || (hasA && amount >= 1 && amount <= 99999)) return true;

    return false;
  }

  const Importer = {
    guessFileCat,
    /* 解析一个工作簿文件 → {shop, ym, sheets:[{cat, ym, rows[], daily}], log[]} */
    async parseFile(file) {
      const buf = await file.arrayBuffer();
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(buf);

      const fname = file.name.replace(/\.(xlsx|xlsm)$/i, '');
      let shop = U.guessShop(fname);
      let month = U.guessMonth(fname);
      const log = [];
      const sheets = [];
      let ymFromSheet = '';

      wb.eachSheet(ws => {
        const sname = (ws.name || '').trim();
        const sp = U.splitSheet(sname);

        // 月度总帐：提取店铺/月份兜底
        if (/总帐|总账/.test(sp.cat)) {
          for (let r = 1; r <= Math.min(ws.rowCount, 30); r++) {
            for (let c = 1; c <= 5; c++) {
              const t = str(cellVal(ws, r, c));
              if (!shop && /店$|茶记$/.test(t) && t.length <= 10) shop = t;
              if (!month && /^\d{1,2}月$/.test(t)) month = parseInt(t, 10);
            }
          }
          return;
        }

        const hd = findHeader(ws);
        if (!hd) { log.push(`· ${sname}：未找到表头，跳过`); return; }
        if (sp.ym && !ymFromSheet) ymFromSheet = sp.ym;

        const col = hd.col;
        const rows = [];
        let lastDate = '';
        const maxR = ws.rowCount || 1;

        for (let r = hd.row + 1; r <= maxR; r++) {
          const dRaw = col.date ? cellVal(ws, r, col.date) : null;
          const d = str(dRaw) ? U.parseDate(dRaw, sp.mm || month) : '';
          if (d) lastDate = d;

          if (hd.daily) {
            const variety = U.toNum(cellVal(ws, r, col.variety));
            const amount = U.toNum(cellVal(ws, r, col.amount || col.total));
            // 跳过末尾合计行（品种数不是数字）
            if (variety === null) continue;
            if (!U.ok(amount)) continue;
            rows.push({ date: lastDate, variety, amount });
          } else {
            const nm = str(cellVal(ws, r, col.name)).replace(/[～~]/g, '');
            const qty = U.toNum(cellVal(ws, r, col.qty));
            const price = U.toNum(cellVal(ws, r, col.price));
            const amount = U.toNum(cellVal(ws, r, col.amount));
            if (!nm && !U.ok(qty) && !U.ok(price) && !U.ok(amount)) continue;
            // 跳过合计行
            if (/合计|小计|总计|统计/.test(nm)) continue;
            rows.push({ date: lastDate, name: nm, qty, price, amount });
          }
        }
        sheets.push({ cat: sp.cat, ym: sp.ym, daily: hd.daily, rows });
        log.push(`· ${sname} → ${sp.cat}：${rows.length} 行${hd.daily ? '（每日汇总格式）' : ''}`);
      });

      let ym = ymFromSheet;
      if (!ym && month) {
        const yy = new Date().getFullYear() % 100;
        ym = U.makeYm(yy, month);
      }
      if (!shop) shop = fname.slice(0, 12);
      return { file: file.name, shop, ym, month: month || (ym ? +ym.slice(2) : 0), sheets, log };
    },

    /* 把解析结果合并进商品库 */
    mergeToItems(parsed, itemMap) {
      let added = 0, updated = 0, skipped = 0;
      parsed.sheets.forEach(sh => {
        if (sh.daily) { skipped += sh.rows.length; return; }
        sh.rows.forEach(r => {
          if (!r.name) return;
          // 单价缺失时尝试反推
          let price = r.price;
          if (!U.ok(price) && U.ok(r.qty) && U.ok(r.amount)) price = U.r4(r.amount / r.qty);
          if (!U.ok(price)) return;
          const id = sh.cat + '|' + U.normName(r.name);
          let it = itemMap.get(id);
          if (!it) {
            it = {
              id, cat: sh.cat, name: r.name, prices: [], ref: null,
              low: null, high: null, n: 0, shops: [], alias: [], last: sh.ym || parsed.ym || ''
            };
            itemMap.set(id, it); added++;
          } else {
            updated++;
            // 保留字数更多的规范名（信息更全）
            if (r.name.length > it.name.length && U.sim(r.name, it.name) >= 0.8) it.name = r.name;
          }
          it.prices.push(price);
          if (it.prices.length > 60) it.prices = it.prices.slice(-60);
          it.n = (it.n || 0) + 1;
          if (parsed.shop && it.shops.indexOf(parsed.shop) < 0) it.shops.push(parsed.shop);
          const ym = sh.ym || parsed.ym || '';
          if (ym && (!it.last || ym > it.last)) it.last = ym;
        });
      });
      // 重算参考价
      itemMap.forEach(it => {
        if (it.prices && it.prices.length) {
          it.ref = U.mode(it.prices);
          it.low = U.r4(Math.min.apply(null, it.prices));
          it.high = U.r4(Math.max.apply(null, it.prices));
        }
      });
      return { added, updated, skipped };
    },

    /* 解析「扫描王/原始采购单 Excel」→ 原始 item 行（不假定分类，分类由 processRow / 强制分类决定）
     * 与 parseFile 区别：parseFile 面向「标准汇总 Excel」（每 sheet 已带分类，用于建库）；
     * 这里面向手机扫描王/拍出的采购单导出的 Excel，逐行抽 name/qty/price/amount/date。
     */
    async parseRawItems(file, opt) {
      opt = opt || {};
      const buf = await file.arrayBuffer();
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(buf);
      const fname = file.name.replace(/\.(xlsx|xlsm)$/i, '');
      let fileCat = opt.forceCat || guessFileCat(fname, opt.cats) || '';
      const log = [];
      const items = [];
      wb.eachSheet(ws => {
        const sname = (ws.name || '').trim();
        const sp = U.splitSheet(sname);
        if (/总帐|总账/.test(sp.cat)) return;          // 跳过月度总帐 sheet
        const hd = findHeader(ws);
        if (!hd) { log.push(`· ${sname}：未找到表头，跳过`); return; }
        const col = hd.col;
        // 从表头上方抓默认日期
        let defaultDate = findSheetDate(ws, hd.row - 1) || '';
        let lastDate = defaultDate;
        const maxR = ws.rowCount || 1;
        let n = 0;
        for (let r = hd.row + 1; r <= maxR; r++) {
          const dRaw = col.date ? cellVal(ws, r, col.date) : null;
          const d = str(dRaw) ? U.parseDate(dRaw, opt.month) : '';
          if (d) lastDate = d;
          if (hd.daily) {
            const variety = U.toNum(cellVal(ws, r, col.variety));
            const amount = U.toNum(cellVal(ws, r, col.amount || col.total));
            if (variety === null) continue;
            if (!U.ok(amount)) continue;
            items.push({ date: lastDate || defaultDate, cat: fileCat, name: '', qty: variety, price: null, amount, daily: true });
            n++;
          } else {
            let nm = cleanName(str(cellVal(ws, r, col.name)));
            // 商品规格列忽略，不合并到名称里；名称列空但 spec 列有内容时也不采用 spec。
            const qty = U.toNum(cellVal(ws, r, col.qty));
            const price = U.toNum(cellVal(ws, r, col.price));
            const amount = U.toNum(cellVal(ws, r, col.amount));
            if (!nm && !U.ok(qty) && !U.ok(price) && !U.ok(amount)) continue;
            if (/合计|小计|总计|统计/.test(nm)) continue;
            // 有品名时才做商品行判定；空名但数字合理的留给反推补全
            if (nm && !looksLikeProduct(nm, qty, price, amount)) continue;
            if (U.ok(qty) && qty === 0 && !U.ok(amount) && !U.ok(price)) continue; // 空行序号残留
            items.push({ date: lastDate || defaultDate, cat: fileCat, name: nm, qty, price, amount });
            n++;
          }
        }
        if (n) log.push(`· ${sname}：${n} 行`);
      });

      // 一个 Excel = 一个分类：分类只来自「用户手动选」或「文件名含分类词」。
      // 不再按品名字眼自动识别分类（避免同一文件被关键词拆成多类）。
      if (!fileCat) {
        log.unshift('· 未指定分类：该文件既未手动选分类、文件名也不含分类词；导入后请在「数据核对」指定，或重传时在下拉框选好');
      }

      if (!items.length && !log.length) log.push('· 未解析到任何数据行');
      return { file: file.name, items, log, fileCat };
    },

    /* 把解析结果转成账套行（可选：让历史月份也能被管理和重新导出） */
    toBookRows(parsed) {
      const rows = [];
      parsed.sheets.forEach(sh => {
        if (sh.daily) {
          sh.rows.forEach(r => rows.push({
            id: U.uid(), date: r.date, cat: sh.cat, name: '', qty: r.variety,
            price: null, amount: r.amount, src: 'import', daily: true,
            flags: { derived: [], nameSrc: 'import', score: 1, review: false, note: '每日汇总行' }
          }));
        } else {
          sh.rows.forEach(r => rows.push({
            id: U.uid(), date: r.date, cat: sh.cat, name: r.name, qty: r.qty,
            price: r.price, amount: r.amount, src: 'import',
            flags: { derived: [], nameSrc: 'import', score: 1, review: false, note: '' }
          }));
        }
      });
      return rows;
    }
  };

  g.Importer = Importer;
})(window);
