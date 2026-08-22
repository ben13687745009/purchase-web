/* ============================================================
 * exporter.js — 生成与原表一致的汇总 Excel
 *   固定表头：序号 日期 名称和规格 数量 单价 金额 合计
 *   宋体 14 / 行高 27 / 全边框 / 全部水平垂直居中 / 数字常规格式
 *   列宽：名称和规格 26（自动换行）· 合计 18 · 其余 13
 *   同日期：日期列与合计列合并单元格；合计列红字
 *   sheet 末尾小计行黄底红字；月度总帐汇总各分类
 * ============================================================ */
(function (g) {
  'use strict';
  const U = g.U;

  const FONT = { name: '宋体', size: 14 };
  const FONT_B = { name: '宋体', size: 14, bold: true };
  const RED = 'FFFF0000';
  const YELLOW = 'FFFFFF00';
  const HDR_BG = 'FFD9D9D9';
  const THIN = { style: 'thin', color: { argb: 'FF000000' } };
  const BORDER = { top: THIN, left: THIN, bottom: THIN, right: THIN };
  const CENTER = { horizontal: 'center', vertical: 'middle', wrapText: true };

  const HEADERS = ['序号', '日期', '名称和规格', '数量', '单价', '金额', '合计'];
  const WIDTHS = [13, 13, 26, 13, 13, 13, 18];
  const DAILY_HEADERS = ['序号', '日期', '商品品种统计', '金额（元）'];
  const DAILY_WIDTHS = [13, 13, 26, 18];

  function styleCell(cell, opt) {
    opt = opt || {};
    cell.font = Object.assign({}, opt.bold ? FONT_B : FONT, opt.red ? { color: { argb: RED } } : {});
    cell.alignment = CENTER;
    cell.border = BORDER;
    cell.numFmt = 'General';
    if (opt.fill) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: opt.fill } };
  }

  function setWidths(ws, arr) { arr.forEach((w, i) => { ws.getColumn(i + 1).width = w; }); }

  function colLetter(n) {
    let s = '';
    while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = (n - m - 1) / 26; }
    return s;
  }

  /* 明细 sheet */
  function buildDetail(wb, sheetName, rows, ym, opt) {
    const ws = wb.addWorksheet(sheetName, { views: [{ state: 'frozen', ySplit: 1 }] });
    setWidths(ws, WIDTHS);
    ws.properties.defaultRowHeight = 27;

    // 表头
    HEADERS.forEach((h, i) => {
      const c = ws.getCell(1, i + 1);
      c.value = h;
      styleCell(c, { bold: true, fill: HDR_BG, red: i === 6 });
    });
    ws.getRow(1).height = 27;

    // 按日期排序；同日严格按「录入序号 seq（放图顺序）」排列，保证与用户放图顺序一致
    const sorted = rows.slice().sort((a, b) => {
      const d = U.dateKey(a.date) - U.dateKey(b.date);
      if (d !== 0) return d;
      return (a.seq || 0) - (b.seq || 0);
    });

    // 分组
    const groups = [];
    let cur = null;
    sorted.forEach(r => {
      if (!cur || cur.date !== r.date) { cur = { date: r.date, rows: [] }; groups.push(cur); }
      cur.rows.push(r);
    });

    let r = 2, no = 1;
    const dayRanges = [];
    groups.forEach(gp => {
      const start = r;
      gp.rows.forEach(row => {
        ws.getRow(r).height = 27;
        const a = ws.getCell(r, 1); a.value = no++; styleCell(a);
        const b = ws.getCell(r, 2); b.value = row.date || ''; styleCell(b);
        const c = ws.getCell(r, 3); c.value = row.name || ''; styleCell(c);
        const d = ws.getCell(r, 4); d.value = U.ok(row.qty) ? row.qty : null; styleCell(d);
        const e = ws.getCell(r, 5); e.value = U.ok(row.price) ? row.price : null; styleCell(e);
        const f = ws.getCell(r, 6);
        // 数量×单价与金额一致时写公式，方便后续手改数量自动重算；不一致则写死金额
        if (U.ok(row.qty) && U.ok(row.price) && U.ok(row.amount) &&
          Math.abs(row.qty * row.price - row.amount) < 0.005) {
          f.value = { formula: `D${r}*E${r}`, result: U.r2(row.amount) };
        } else {
          f.value = U.ok(row.amount) ? row.amount : null;
        }
        styleCell(f);
        const gc = ws.getCell(r, 7); styleCell(gc, { red: true });
        r++;
      });
      const end = r - 1;
      dayRanges.push([start, end]);
      // 合计列：当日总额
      const gcell = ws.getCell(start, 7);
      gcell.value = { formula: `SUM(F${start}:F${end})`, result: U.r2(gp.rows.reduce((s, x) => s + (U.ok(x.amount) ? x.amount : 0), 0)) };
      styleCell(gcell, { red: true });
    });

    // 合并同日期的 B 列与 G 列
    if (opt.merge !== false) {
      dayRanges.forEach(([s, e]) => {
        if (e > s) { ws.mergeCells(s, 2, e, 2); ws.mergeCells(s, 7, e, 7); }
      });
    }

    // 小计行
    const last = r - 1;
    ws.getRow(r).height = 27;
    for (let c = 1; c <= 7; c++) styleCell(ws.getCell(r, c), { fill: YELLOW, red: true, bold: true });
    ws.getCell(r, 6).value = ym + '合计';
    const total = sorted.reduce((s, x) => s + (U.ok(x.amount) ? x.amount : 0), 0);
      ws.getCell(r, 7).value = last >= 2
        ? { formula: `SUM(G2:G${last})`, result: U.r2(total) }
        : U.r2(total);
    return { ws, total: U.r2(total), rowCount: sorted.length, totalRow: r };
  }

  /* 每日汇总格式 sheet（如 环绿蔬菜） */
  function buildDaily(wb, sheetName, rows, ym) {
    const ws = wb.addWorksheet(sheetName, { views: [{ state: 'frozen', ySplit: 1 }] });
    setWidths(ws, DAILY_WIDTHS);
    ws.properties.defaultRowHeight = 27;
    DAILY_HEADERS.forEach((h, i) => {
      const c = ws.getCell(1, i + 1); c.value = h;
      styleCell(c, { bold: true, fill: HDR_BG });
    });
    ws.getRow(1).height = 27;

    // 按日期聚合
    const map = new Map();
    rows.forEach(x => {
      const d = x.date || '';
      if (!map.has(d)) map.set(d, { variety: 0, amount: 0 });
      const t = map.get(d);
      // daily 行：qty 存的是品种数；普通行则按条计数
      t.variety += x.daily ? (U.ok(x.qty) ? x.qty : 0) : 1;
      t.amount += U.ok(x.amount) ? x.amount : 0;
    });
    const days = Array.from(map.keys()).sort((a, b) => U.dateKey(a) - U.dateKey(b));

    let r = 2, no = 1, total = 0;
    days.forEach(d => {
      const t = map.get(d);
      ws.getRow(r).height = 27;
      ws.getCell(r, 1).value = no++;
      ws.getCell(r, 2).value = d;
      ws.getCell(r, 3).value = U.r4(t.variety);
      ws.getCell(r, 4).value = U.r2(t.amount);
      for (let c = 1; c <= 4; c++) styleCell(ws.getCell(r, c));
      total += t.amount;
      r++;
    });
    ws.getRow(r).height = 27;
    for (let c = 1; c <= 4; c++) styleCell(ws.getCell(r, c), { fill: YELLOW, red: true, bold: true });
    ws.getCell(r, 3).value = ym + '合计';
    ws.getCell(r, 4).value = r > 2 ? { formula: `SUM(D2:D${r - 1})`, result: U.r2(total) } : U.r2(total);
    return { ws, total: U.r2(total), rowCount: days.length, totalRow: r };
  }

  /* 每日汇总（跨分类） */
  function buildDailyAll(wb, ym, rows, cats) {
    const ws = wb.addWorksheet('每日汇总' + ym);
    const catList = cats.slice();
    const heads = ['日期'].concat(catList).concat(['当日合计']);
    setWidths(ws, [13].concat(catList.map(() => 14)).concat([16]));
    ws.properties.defaultRowHeight = 27;
    heads.forEach((h, i) => {
      const c = ws.getCell(1, i + 1); c.value = h;
      styleCell(c, { bold: true, fill: HDR_BG });
    });
    ws.getRow(1).height = 27;

    const map = new Map();
    rows.forEach(x => {
      const d = x.date || '';
      if (!map.has(d)) map.set(d, {});
      const t = map.get(d);
      t[x.cat] = (t[x.cat] || 0) + (U.ok(x.amount) ? x.amount : 0);
    });
    const days = Array.from(map.keys()).sort((a, b) => U.dateKey(a) - U.dateKey(b));
    let r = 2;
    days.forEach(d => {
      ws.getRow(r).height = 27;
      ws.getCell(r, 1).value = d;
      catList.forEach((c, i) => {
        const v = map.get(d)[c];
        ws.getCell(r, i + 2).value = v ? U.r2(v) : null;
      });
      const L = colLetter(catList.length + 1);
      ws.getCell(r, catList.length + 2).value = {
        formula: `SUM(B${r}:${L}${r})`,
        result: U.r2(Object.values(map.get(d)).reduce((s, v) => s + v, 0))
      };
      for (let c = 1; c <= heads.length; c++) styleCell(ws.getCell(r, c));
      r++;
    });
    ws.getRow(r).height = 27;
    for (let c = 1; c <= heads.length; c++) styleCell(ws.getCell(r, c), { fill: YELLOW, red: true, bold: true });
    ws.getCell(r, 1).value = '合计';
    for (let i = 0; i < catList.length + 1; i++) {
      const L = colLetter(i + 2);
      const sum = days.reduce((s, d) => {
        if (i < catList.length) return s + (map.get(d)[catList[i]] || 0);
        return s + Object.values(map.get(d)).reduce((a, b) => a + b, 0);
      }, 0);
      ws.getCell(r, i + 2).value = r > 2 ? { formula: `SUM(${L}2:${L}${r - 1})`, result: U.r2(sum) } : U.r2(sum);
    }
    return ws;
  }

  /* 待核对 */
  function buildReview(wb, ym, rows) {
    const ws = wb.addWorksheet('待核对' + ym);
    const heads = ['序号', '日期', '分类', '名称和规格', '数量', '单价', '金额', '识别原文', '问题说明'];
    setWidths(ws, [8, 12, 14, 26, 12, 12, 13, 22, 46]);
    ws.properties.defaultRowHeight = 27;
    heads.forEach((h, i) => {
      const c = ws.getCell(1, i + 1); c.value = h;
      styleCell(c, { bold: true, fill: HDR_BG });
    });
    ws.getRow(1).height = 27;
    let r = 2, no = 1;
    rows.forEach(x => {
      ws.getRow(r).height = 27;
      const vals = [no++, x.date || '', x.cat || '', x.name || '',
        U.ok(x.qty) ? x.qty : null, U.ok(x.price) ? x.price : null, U.ok(x.amount) ? x.amount : null,
        x.rawName || '', (x.flags && x.flags.note) || ''];
      vals.forEach((v, i) => {
        const c = ws.getCell(r, i + 1); c.value = v;
        styleCell(c, { fill: 'FFFFF2CC' });
        if (i === 8 || i === 3) c.alignment = { horizontal: 'left', vertical: 'middle', wrapText: true };
      });
      r++;
    });
    if (r === 2) {
      ws.getCell(2, 1).value = '（无）';
      styleCell(ws.getCell(2, 1));
      ws.getRow(2).height = 27;
    }
    return ws;
  }

  const Exporter = {
    /* 生成一个账套的工作簿 */
    async build(book, cfg, opt) {
      opt = opt || {};
      const wb = new ExcelJS.Workbook();
      wb.creator = '采购单汇总台';
      wb.created = new Date();

      const ym = book.ym;
      const month = parseInt(ym.slice(2), 10) || 0;
      const rows = book.rows || [];
      const dailyCats = cfg.dailyCats || [];

      // 分类排序：配置顺序优先，其余按出现顺序追加
      const present = [];
      rows.forEach(r => { const c = r.cat || '未分类'; if (present.indexOf(c) < 0) present.push(c); });
      const ordered = (cfg.cats || []).filter(c => present.indexOf(c) >= 0)
        .concat(present.filter(c => (cfg.cats || []).indexOf(c) < 0));

      const parts = [];
      const sheetsInfo = [];
      ordered.forEach(cat => {
        const sub = rows.filter(r => (r.cat || '未分类') === cat);
        if (!sub.length) return;
        const sheetName = cat + ym;
        const isDaily = dailyCats.indexOf(cat) >= 0;
        sheetsInfo.push({ cat, sheetName, sub, isDaily });
      });

      // 月度总帐必须是第一个 sheet → 先创建，稍后填数据
      const ledger = wb.addWorksheet('月度总帐' + ym);

      sheetsInfo.forEach(si => {
        const res = si.isDaily
          ? buildDaily(wb, si.sheetName, si.sub, ym)
          : buildDetail(wb, si.sheetName, si.sub, ym, opt);
        parts.push({
          name: si.cat, sheet: si.sheetName, total: res.total,
          totalRef: (si.isDaily ? 'D' : 'G') + res.totalRow
        });
      });

      // 填月度总帐
      setWidths(ledger, [10, 26, 20, 10]);
      ledger.properties.defaultRowHeight = 27;
      ['序号', '项目', '金额（元）'].forEach((h, i) => {
        const c = ledger.getCell(1, i + 1); c.value = h;
        styleCell(c, { bold: true, fill: HDR_BG });
      });
      ledger.getRow(1).height = 27;
      let lr = 2, no = 1, total = 0;
      parts.forEach(p => {
        ledger.getRow(lr).height = 27;
        ledger.getCell(lr, 1).value = no++;
        ledger.getCell(lr, 2).value = p.name;
        ledger.getCell(lr, 3).value = { formula: `'${p.sheet}'!${p.totalRef}`, result: p.total };
        for (let c = 1; c <= 3; c++) styleCell(ledger.getCell(lr, c));
        total += p.total || 0;
        lr++;
      });
      ledger.getRow(lr).height = 27;
      for (let c = 1; c <= 4; c++) styleCell(ledger.getCell(lr, c), { fill: YELLOW, red: true, bold: true });
      ledger.getCell(lr, 3).value = lr > 2 ? { formula: `SUM(C2:C${lr - 1})`, result: U.r2(total) } : U.r2(total);
      ledger.getCell(lr, 4).value = '统计';
      lr += 2;
      ledger.getRow(lr).height = 27;
      ledger.getCell(lr, 3).value = book.shop; styleCell(ledger.getCell(lr, 3), { bold: true });
      lr++;
      ledger.getRow(lr).height = 27;
      ledger.getCell(lr, 3).value = month + '月'; styleCell(ledger.getCell(lr, 3), { bold: true });

      // 附加 sheet
      if (opt.daily !== false) buildDailyAll(wb, ym, rows, ordered);
      if (opt.review !== false) {
        const rev = rows.filter(r => r.flags && r.flags.review);
        buildReview(wb, ym, rev);
      }

      const buf = await wb.xlsx.writeBuffer();
      const ret = {
        blob: new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
        total: U.r2(total),
        parts
      };
      if (typeof Buffer !== 'undefined') ret.buf = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
      return ret;
    },

    fileName(tpl, book) {
      const m = parseInt(book.ym.slice(2), 10) || 0;
      return (tpl || '{shop}{m}月')
        .replace(/\{shop\}/g, book.shop)
        .replace(/\{m\}/g, m)
        .replace(/\{ym\}/g, book.ym) + '.xlsx';
    }
  };

  g.Exporter = Exporter;
})(window);
