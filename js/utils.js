/* ============================================================
 * utils.js — 通用工具：数字清洗 / 日期 / 相似度 / DOM
 * ============================================================ */
(function (g) {
  'use strict';

  /* ---------- 数字清洗 ----------
   * 容忍：¥1104.04  1,104.04  2.00.  1✓  １２３（全角）  "78 00"(取78)
   * 规则：去货币符/千分位/勾选符 → 取第一个数字 token（不删空格，避免 78 00 → 7800）
   */
  function toNum(v) {
    if (v === null || v === undefined) return null;
    if (typeof v === 'number') return isFinite(v) ? v : null;
    let s = String(v);
    if (!s.trim()) return null;
    // 全角转半角
    s = s.replace(/[０-９．－]/g, c => '0123456789.-'['０１２３４５６７８９．－'.indexOf(c)]);
    s = s.replace(/[¥￥$€,，、✓√✔×xX*]/g, '');
    s = s.replace(/[Oo](?=\d)|(?<=\d)[Oo]/g, '0');
    const m = s.match(/-?\d+(?:\.\d+)?/);
    if (!m) return null;
    const n = parseFloat(m[0]);
    return isFinite(n) ? n : null;
  }

  /* 数值有效（非空且非 NaN；0 视为无效，采购场景无 0 值） */
  function ok(n) { return n !== null && n !== undefined && !isNaN(n) && n !== 0; }

  /* 保留小数：最多 4 位，去尾零 */
  function r4(n) {
    if (!isFinite(n)) return null;
    return Math.round(n * 10000) / 10000;
  }
  function r2(n) {
    if (!isFinite(n)) return null;
    return Math.round(n * 100) / 100;
  }
  function fmt(n) {
    if (n === null || n === undefined || n === '' || isNaN(n)) return '';
    const x = r4(Number(n));
    return String(x);
  }
  function money(n) {
    if (!isFinite(n)) return '0';
    return (Math.round(n * 100) / 100).toLocaleString('zh-CN', { maximumFractionDigits: 2 });
  }

  /* ---------- 日期 ----------
   * 统一内部格式 "m.d" （如 5.1 / 5.12），导出也用这个
   * 输入可能：5.1  5/1  05-01  0501  5月1日  2026-05-01  Date对象  Excel序列号
   */
  function parseDate(v, defMonth) {
    if (v === null || v === undefined || v === '') return '';
    if (v instanceof Date && !isNaN(v)) return (v.getMonth() + 1) + '.' + v.getDate();
    if (typeof v === 'number') {
      // Excel 序列号（1900 基准）
      if (v > 20000 && v < 60000) {
        const d = new Date(Date.UTC(1899, 11, 30) + v * 86400000);
        return (d.getUTCMonth() + 1) + '.' + d.getUTCDate();
      }
      // 可能是 5.1 这种数字
      const s0 = String(v);
      if (/^\d{1,2}\.\d{1,2}$/.test(s0)) return s0;
      if (/^\d{3,4}$/.test(s0)) { // 0501 / 501
        const s1 = s0.padStart(4, '0');
        return parseInt(s1.slice(0, 2), 10) + '.' + parseInt(s1.slice(2), 10);
      }
      return s0;
    }
    let s = String(v).trim();
    if (!s) return '';
    let m;
    if ((m = s.match(/(\d{1,2})\s*月\s*(\d{1,2})/))) return +m[1] + '.' + +m[2];
    if ((m = s.match(/^\d{4}[-/.](\d{1,2})[-/.](\d{1,2})/))) return +m[1] + '.' + +m[2];
    if ((m = s.match(/^(\d{1,2})\s*[.\-/]\s*(\d{1,2})$/))) return +m[1] + '.' + +m[2];
    if ((m = s.match(/^(\d{2})(\d{2})$/))) return +m[1] + '.' + +m[2];
    if ((m = s.match(/^(\d)(\d{2})$/))) return +m[1] + '.' + +m[2];
    if (/^\d{1,2}$/.test(s) && defMonth) return defMonth + '.' + +s;
    return s;
  }

  /* 日期排序键 */
  function dateKey(d) {
    const m = String(d || '').match(/^(\d{1,2})\.(\d{1,2})$/);
    if (!m) return 9999;
    return (+m[1]) * 100 + (+m[2]);
  }

  /* 从文件名/文本里猜店铺与月份 */
  function guessShop(text) {
    const m = String(text || '').match(/[（(]([^）)]{1,12}店[^）)]{0,6})[）)]/);
    if (m) return m[1];
    const m2 = String(text || '').match(/([\u4e00-\u9fa5]{1,6}店)/);
    return m2 ? m2[1] : '';
  }
  function guessMonth(text) {
    const m = String(text || '').match(/(\d{1,2})\s*月/);
    return m ? +m[1] : 0;
  }
  /* sheet 名尾部 yymm，如 裕笙隆2605 → {cat:'裕笙隆', yy:26, mm:5} */
  function splitSheet(name) {
    const m = String(name || '').match(/^(.+?)(\d{4})$/);
    if (m) return { cat: m[1], yy: +m[2].slice(0, 2), mm: +m[2].slice(2), ym: m[2] };
    return { cat: String(name || '').trim(), yy: 0, mm: 0, ym: '' };
  }
  function makeYm(yy, mm) {
    return String(yy).padStart(2, '0') + String(mm).padStart(2, '0');
  }

  /* ---------- 文本归一化 ---------- */
  function normName(s) {
    return String(s || '')
      .replace(/[\s\u3000]/g, '')
      .replace(/[（）()【】\[\]{}]/g, '')
      .replace(/[，,。.、；;：:!！?？"'"'`~～·]/g, '')
      .replace(/[Ａ-Ｚａ-ｚ０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 65248))
      .toLowerCase();
  }

  /* ---------- 相似度 ---------- */
  function levenshtein(a, b) {
    const m = a.length, n = b.length;
    if (!m) return n; if (!n) return m;
    let prev = new Array(n + 1), cur = new Array(n + 1);
    for (let j = 0; j <= n; j++) prev[j] = j;
    for (let i = 1; i <= m; i++) {
      cur[0] = i;
      const ca = a.charCodeAt(i - 1);
      for (let j = 1; j <= n; j++) {
        const c = ca === b.charCodeAt(j - 1) ? 0 : 1;
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + c);
      }
      const t = prev; prev = cur; cur = t;
    }
    return prev[n];
  }
  function bigrams(s) {
    const out = [];
    if (s.length === 1) return [s];
    for (let i = 0; i < s.length - 1; i++) out.push(s.slice(i, i + 2));
    return out;
  }
  function diceSim(a, b) {
    if (!a || !b) return 0;
    if (a === b) return 1;
    const A = bigrams(a), B = bigrams(b);
    if (!A.length || !B.length) return 0;
    const map = new Map();
    A.forEach(x => map.set(x, (map.get(x) || 0) + 1));
    let hit = 0;
    B.forEach(x => { const c = map.get(x); if (c > 0) { hit++; map.set(x, c - 1); } });
    return 2 * hit / (A.length + B.length);
  }
  /* 综合相似度：编辑距离 + bigram Dice 取较大值 */
  function sim(a, b) {
    a = normName(a); b = normName(b);
    if (!a || !b) return 0;
    if (a === b) return 1;
    const lev = 1 - levenshtein(a, b) / Math.max(a.length, b.length);
    return Math.max(lev, diceSim(a, b));
  }

  /* ---------- 杂项 ---------- */
  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }
  function $(s, root) { return (root || document).querySelector(s); }
  function $$(s, root) { return Array.prototype.slice.call((root || document).querySelectorAll(s)); }
  function el(tag, attrs, kids) {
    const n = document.createElement(tag);
    if (attrs) for (const k in attrs) {
      if (k === 'class') n.className = attrs[k];
      else if (k === 'html') n.innerHTML = attrs[k];
      else if (k === 'text') n.textContent = attrs[k];
      else if (k.slice(0, 2) === 'on') n.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] !== null && attrs[k] !== undefined && attrs[k] !== false) n.setAttribute(k, attrs[k]);
    }
    (kids || []).forEach(c => n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c));
    return n;
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function toast(msg, type) {
    const box = $('#toast');
    const d = el('div', { class: type || '', text: msg });
    box.appendChild(d);
    setTimeout(() => { d.style.opacity = '0'; d.style.transform = 'translateX(20px)'; }, 2600);
    setTimeout(() => d.remove(), 3000);
  }
  function download(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
  }
  /* 中位数 */
  function median(arr) {
    if (!arr.length) return null;
    const a = arr.slice().sort((x, y) => x - y);
    const i = a.length >> 1;
    return a.length % 2 ? a[i] : (a[i - 1] + a[i]) / 2;
  }
  /* 众数（找不到明显众数则返回中位数） */
  function mode(arr) {
    if (!arr.length) return null;
    const m = new Map();
    arr.forEach(v => { const k = r4(v); m.set(k, (m.get(k) || 0) + 1); });
    let best = null, bc = 0;
    m.forEach((c, k) => { if (c > bc || (c === bc && best !== null && k > best)) { bc = c; best = k; } });
    return bc >= 2 ? best : median(arr);
  }

  /* 单位归一：消除「同一计量单位的不同写法」，但绝不跨单位换算。
   *   kg/KG/千克/公斤 → kg
   *   g/克           → g
   *   ml/ML/毫升     → ml
   *   l/L/升/公升    → l
   *   其余中文单位（斤/包/箱/袋/盒/罐/瓶/支/件/个/份/套/条/只/扎/桶/两/磅…）原样保留
   */
  const UNIT_MAP = { KG: 'kg', 千克: 'kg', 公斤: 'kg', ML: 'ml', 毫升: 'ml', L: 'l', 升: 'l', 公升: 'l', g: 'g', 克: 'g' };
  function normUnit(u) {
    if (!u) return '';
    const s = String(u).trim();
    return s ? (UNIT_MAP[s] || s) : '';
  }

  g.U = {
    toNum, ok, r2, r4, fmt, money, parseDate, dateKey, guessShop, guessMonth,
    splitSheet, makeYm, normName, sim, diceSim, levenshtein, uid, $, $$, el, esc,
    toast, download, median, mode, normUnit
  };
})(window);
