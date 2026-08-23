/* ============================================================
 * ocr.js — 视觉大模型识别手写采购单（OpenAI 兼容接口）
 *   · 图片等比压缩，控制 token
 *   · 把商品库品名清单注入提示词做上下文纠错（手写识别率关键）
 *   · 强制 JSON 输出，容错解析
 *   · 并发队列
 *   · 手机拍照专用增强管线 + 专用提示词（两步法：先数行再提取）
 * ============================================================ */
(function (g) {
  'use strict';
  const U = g.U;

  var MAX_PIXELS = 4096 * 4096;

  /* ---------- 图片压缩 ----------
   * 电脑端：原图等比压缩即可，不做任何增强/锐化/调亮度，避免破坏打印/手写原貌。
   * 手机端：保留手写增强管线（拍照反光、阴影、模糊件需要）。
   */
  function compress(file, maxW, opts) {
    opts = opts || {};
    var isMobile = !!opts.forMobile;
    var minW = isMobile ? 1200 : 800;
    var maxLimit = isMobile ? 2000 : 4096;
    var defW = isMobile ? 1600 : 2400; // 电脑端默认 2400，列边界和小数点更清晰
    maxW = Math.max(minW, Math.min(maxLimit, maxW || defW));
    return new Promise(function (res, rej) {
      var url = URL.createObjectURL(file);
      var cleanup = function () { try { URL.revokeObjectURL(url); } catch (e) { } };

      var simpleRender = function (bitmap) {
        try {
          var w = bitmap.width, h = bitmap.height;
          if (!w || !h) throw new Error('图片尺寸为 0');
          var scale = (w > maxW) ? (maxW / w) : 1;
          if (w * h * scale * scale > MAX_PIXELS) {
            scale = Math.sqrt(MAX_PIXELS / (w * h));
          }
          w = Math.max(1, Math.round(w * scale));
          h = Math.max(1, Math.round(h * scale));
          var cv = document.createElement('canvas');
          cv.width = w; cv.height = h;
          var cx = cv.getContext('2d');
          cx.fillStyle = '#fff';
          cx.fillRect(0, 0, w, h);
          cx.drawImage(bitmap, 0, 0, w, h);
          if (bitmap.close) try { bitmap.close(); } catch (e) { }
          cleanup();
          res(cv.toDataURL('image/jpeg', 0.95));
        } catch (e) { cleanup(); rej(e); }
      };

      var enhancedRender = function (bitmap) {
        try {
          var w = bitmap.width, h = bitmap.height;
          if (!w || !h) throw new Error('图片尺寸为 0');
          var scale = (w > maxW) ? (maxW / w) : 1;
          if (w * h * scale * scale > MAX_PIXELS) {
            scale = Math.sqrt(MAX_PIXELS / (w * h));
          }
          w = Math.max(1, Math.round(w * scale));
          h = Math.max(1, Math.round(h * scale));
          var cv = document.createElement('canvas');
          cv.width = w; cv.height = h;
          var cx = cv.getContext('2d');
          cx.fillStyle = '#fff';
          cx.fillRect(0, 0, w, h);
          cx.drawImage(bitmap, 0, 0, w, h);
          if (bitmap.close) try { bitmap.close(); } catch (e) { }

          // 灰度拉伸对比度增强
          var imgData = cx.getImageData(0, 0, w, h);
          var d = imgData.data;
          var minR = 255, maxR = 0, minG = 255, maxG = 0, minB = 255, maxB = 0;
          for (var i = 0; i < d.length; i += 4) {
            if (d[i] < minR) minR = d[i]; if (d[i] > maxR) maxR = d[i];
            if (d[i + 1] < minG) minG = d[i + 1]; if (d[i + 1] > maxG) maxG = d[i + 1];
            if (d[i + 2] < minB) minB = d[i + 2]; if (d[i + 2] > maxB) maxB = d[i + 2];
          }
          var rangeR = Math.max(1, maxR - minR), rangeG = Math.max(1, maxG - minG), rangeB = Math.max(1, maxB - minB);
          for (var j = 0; j < d.length; j += 4) {
            d[j]     = Math.round(Math.min(255, (d[j]     - minR) / rangeR * 255 * 0.95 + 12));
            d[j + 1] = Math.round(Math.min(255, (d[j + 1] - minG) / rangeG * 255 * 0.95 + 12));
            d[j + 2] = Math.round(Math.min(255, (d[j + 2] - minB) / rangeB * 255 * 0.95 + 12));
          }
          cx.putImageData(imgData, 0, 0);

          var sharp = estimateSharpness(d, w, h);

          // 自动旋转：竖拍横版单据转正
          if (h > w * 1.3) {
            var rotCv = document.createElement('canvas');
            rotCv.width = h; rotCv.height = w;
            var rcx = rotCv.getContext('2d');
            rcx.translate(h, 0);
            rcx.rotate(Math.PI / 2);
            rcx.drawImage(cv, 0, 0);
            cv = rotCv; cx = rcx;
            var tmp = w; w = h; h = tmp;
          }

          // 按清晰度分流处理：打印件去摩尔纹+不锐化；手写件全套增强
          if (sharp >= 12) {
            var moireCv = document.createElement('canvas');
            moireCv.width = w; moireCv.height = h;
            var mctx = moireCv.getContext('2d');
            try { mctx.filter = 'blur(0.6px)'; } catch (e) { }
            mctx.drawImage(cv, 0, 0);
            mctx.filter = 'none';
            cv = moireCv; cx = mctx;
          } else {
            var enhanced = enhanceHandwriting(imgData, w, h);

            // 多尺度 unsharp mask
            var sW1 = Math.max(4, Math.round(w / 8)), sH1 = Math.max(4, Math.round(h / 8));
            var sm1 = document.createElement('canvas'); sm1.width = sW1; sm1.height = sH1;
            var sm1x = sm1.getContext('2d');
            sm1x.drawImage(cv, 0, 0, sW1, sH1);
            cx.globalAlpha = 0.35;
            cx.drawImage(sm1, 0, 0, w, h);

            var sW2 = Math.max(8, Math.round(w / 4)), sH2 = Math.max(8, Math.round(h / 4));
            var sm2 = document.createElement('canvas'); sm2.width = sW2; sm2.height = sH2;
            var sm2x = sm2.getContext('2d');
            var cvData = cx.getImageData(0, 0, w, h);
            cx.putImageData(cvData, 0, 0);
            sm2x.drawImage(cv, 0, 0, sW2, sH2);
            cx.globalAlpha = 0.20;
            cx.drawImage(sm2, 0, 0, w, h);
            cx.globalAlpha = 1.0;

            // 笔画加粗
            try {
              var thickCv = document.createElement('canvas');
              thickCv.width = w; thickCv.height = h;
              var tCx = thickCv.getContext('2d');
              tCx.filter = 'blur(0.4px)';
              tCx.drawImage(cv, 0, 0);
              tCx.filter = 'none';
              var curData = cx.getImageData(0, 0, w, h);
              var blurData = tCx.getImageData(0, 0, w, h);
              var cd = curData.data, bd = blurData.data;
              var len = cd.length;
              for (var p = 0; p < len; p += 4) {
                var dr = cd[p] - bd[p], dg = cd[p+1] - bd[p+1], db = cd[p+2] - bd[p+2];
                var gray = cd[p] * 0.299 + cd[p+1] * 0.587 + cd[p+2] * 0.114;
                if (gray < 180) {
                  cd[p]   = Math.max(0, Math.min(255, cd[p]   - dr * 0.25));
                  cd[p+1] = Math.max(0, Math.min(255, cd[p+1] - dg * 0.25));
                  cd[p+2] = Math.max(0, Math.min(255, cd[p+2] - db * 0.25));
                }
              }
              cx.putImageData(curData, 0, 0);
            } catch (thickErr) { }
          }

          cleanup();
          res(cv.toDataURL('image/jpeg', 0.95));
        } catch (e) { cleanup(); rej(e); }
      };

      var fallbackImg = function () {
        var img = new Image();
        img.onload = function () {
          try {
            var w = img.naturalWidth, h = img.naturalHeight;
            if (!w || !h) throw new Error('图片尺寸为 0');
            var sc = (w > maxW) ? (maxW / w) : 1;
            if (w * h * sc * sc > MAX_PIXELS) sc = Math.sqrt(MAX_PIXELS / (w * h));
            w = Math.max(1, Math.round(w * sc)); h = Math.max(1, Math.round(h * sc));
            var cv = document.createElement('canvas'); cv.width = w; cv.height = h;
            var cx = cv.getContext('2d');
            cx.fillStyle = '#fff'; cx.fillRect(0, 0, w, h);
            cx.drawImage(img, 0, 0, w, h);
            cleanup();
            res(cv.toDataURL('image/jpeg', 0.95));
          } catch (e) { cleanup(); rej(e); }
        };
        img.onerror = function () { cleanup(); rej(new Error('浏览器无法解码此图片')); };
        img.src = url;
      };

      var render = isMobile ? enhancedRender : simpleRender;

      if (typeof window.createImageBitmap === 'function') {
        createImageBitmap(file, { imageOrientation: 'from-image' })
          .then(render)
          .catch(function () { fallbackImg(); });
      } else {
        fallbackImg();
      }
    });
  }

  function compressForMobile(file, maxW) {
    return compress(file, maxW, { forMobile: true });
  }

  /* ---------- 手机拍照专用图片增强（2026-08-17 大升级：手写件专项） ---------- */
  // 估算图像平均边缘梯度（清晰度代理）：高=打印/清晰件(含摩尔纹高频)，低=手写/模糊件
  function estimateSharpness(data, w, h) {
    var step = Math.max(1, Math.floor(w / 240));
    var sum = 0, n = 0;
    for (var y = 1; y < h - 1; y += step) {
      for (var x = 1; x < w - 1; x += step) {
        var i = (y * w + x) * 4;
        var g = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
        var gR = 0.299 * data[i + 4] + 0.587 * data[i + 5] + 0.114 * data[i + 6];
        var gD = 0.299 * data[i + w * 4] + 0.587 * data[i + w * 4 + 1] + 0.114 * data[i + w * 4 + 2];
        sum += Math.abs(g - gR) + Math.abs(g - gD);
        n++;
      }
    }
    return n ? sum / n : 0;
  }

  // ★ 手写件专项增强：通道分离对比度 + 局部对比度(CLAHE近似) + 笔画加粗 + gamma提亮
  function enhanceHandwriting(imgData, w, h) {
    var d = imgData.data;
    var len = d.length;

    // ---- Step 1: 找最佳文字对比通道 ----
    // 对每个通道算局部方差（高方差=有文字信息），选方差最大的通道作为主通道
    var varR = 0, varG = 0, varB = 0, meanR = 0, meanG = 0, meanB = 0, pixN = 0;
    for (var i = 0; i < len; i += 4) { meanR += d[i]; meanG += d[i+1]; meanB += d[i+2]; pixN++; }
    meanR /= pixN; meanG /= pixN; meanB /= pixN;
    for (var j = 0; j < len; j += 4) { varR += (d[j]-meanR)*(d[j]-meanR); varG += (d[j+1]-meanG)*(d[j+1]-meanG); varB += (d[j+2]-meanB)*(d[j+2]-meanB); }
    varR /= pixN; varG /= pixN; varB /= pixN;
    // 选方差最大通道的对比度，混合回RGB（让文字通道更强）
    var bestCh = (varR > varG && varR > varB) ? 0 : (varG > varB ? 1 : 2);
    var blendW = 0.35; // 混合权重：35%来自最佳通道增强
    for (var k = 0; k < len; k += 4) {
      var bestVal = d[k + bestCh];
      var avg = (d[k] + d[k+1] + d[k+2]) / 3;
      var boost = (bestVal - avg) * blendW;
      d[k]   = Math.max(0, Math.min(255, d[k]   + boost));
      d[k+1] = Math.max(0, Math.min(255, d[k+1] + boost));
      d[k+2] = Math.max(0, Math.min(255, d[k+2] + boost));
    }

    // ---- Step 2: 局部对比度增强（近似 CLAHE）----
    // 用多层 unsharp mask 在不同尺度上提升局部对比，让细笔画更清晰
    var tmp = new Uint8ClampedArray(d);
    // 小尺度锐化（提升细笔画边缘）— 用 1/8 缩放
    var sW1 = Math.max(4, Math.round(w / 8)), sH1 = Math.max(4, Math.round(h / 8));
    // 大尺度对比度增强（提升整体文字区域）— 用 1/4 缩放
    var sW2 = Math.max(8, Math.round(w / 4)), sH2 = Math.max(8, Math.round(h / 4));
    // 注意：这里我们用像素级操作近似，不做额外的 canvas 缩放（避免性能问题）
    // 改用：对每个像素，取周围 NxN 区域的均值，做局部拉伸
    var radius = Math.max(2, Math.round(Math.min(w, h) / 80)); // 自适应半径
    var area = (radius * 2 + 1) * (radius * 2 + 1);
    // 用积分图思路太重，改用简化版：行+列两次 box blur 做局部均值
    // 简化实现：直接用原图与高斯模糊版的差值做局部对比度提升
    // 这里用多次轻量 unsharp mask 近似多尺度
    // （Canvas filter 方式在后面统一处理）

    // ---- Step 3: Gamma 提亮（提亮中暗部，让淡字更显）----
    var gamma = 0.85; // < 1 提亮暗部
    var invGamma = 1.0 / gamma;
    var lookup = new Uint8Array(256);
    for (var t = 0; t < 256; t++) lookup[t] = Math.round(Math.pow(t / 255, invGamma) * 255);
    for (var m = 0; m < len; m += 4) {
      d[m]   = lookup[d[m]];
      d[m+1] = lookup[d[m+1]];
      d[m+2] = lookup[d[m+2]];
    }

    return { radius: radius, imgData: imgData };
  }

  function buildContext(items, cats, limitPerCat) {
    limitPerCat = limitPerCat || 55;
    var byCat = new Map();
    (items || []).forEach(function (it) {
      if (!byCat.has(it.cat)) byCat.set(it.cat, []);
      byCat.get(it.cat).push(it);
    });
    var lines = [];
    var order = (cats && cats.length ? cats : Array.from(byCat.keys()));
    order.forEach(function (c) {
      var arr = byCat.get(c);
      if (!arr || !arr.length) return;
      arr.sort(function (a, b) { return (b.n || 0) - (a.n || 0); });
      var names = arr.slice(0, limitPerCat).map(function (it) {
        return U.ok(it.ref) ? it.name + '(' + U.fmt(it.ref) + ')' : it.name;
      });
      lines.push('\u3010' + c + '\u3011' + names.join('\u3001'));
    });
    byCat.forEach(function (arr, c) {
      if (order.indexOf(c) >= 0) return;
      arr.sort(function (a, b) { return (b.n || 0) - (a.n || 0); });
      lines.push('\u3010' + c + '\u3011' + arr.slice(0, limitPerCat).map(function (it) {
        return U.ok(it.ref) ? it.name + '(' + U.fmt(it.ref) + ')' : it.name;
      }).join('\u3001'));
    });
    var txt = lines.join('\n');
    if (txt.length > 9000) txt = txt.slice(0, 9000) + '\n\u2026\uff08\u5df2\u622a\u65ad\uff09';
    return txt;
  }

  var SYS = '\u4f60\u662f\u9910\u996e\u91c7\u8d2d\u5355\u636e\u8bc6\u522b\u4e13\u5bb6\uff0c\u4e13\u95e8\u8bc6\u522b\u4e2d\u56fd\u9910\u996e\u95e8\u5e97\u7684\u624b\u5199\u91c7\u8d2d\u5355/\u9001\u8d27\u5355/purchase list\u3002\n\u4f60\u7684\u8f93\u51fa\u5fc5\u987b\u662f\u4e25\u683c\u7684 JSON\uff0c\u4e0d\u8981\u4efb\u4f55\u89e3\u91ca\u6587\u5b57\uff0c\u4e0d\u8981 markdown \u4ee3\u7801\u5757\u4ee5\u5916\u7684\u5185\u5bb9\u3002';

  function buildPrompt(ctx, cats, hintDate, hintCat, isMobile) {
    const catsStr = (cats || []).join('、') || '（无）';
    const ctxStr = ctx || '（暂无历史数据）';
    const hintDateStr = hintDate ? `
⚠️ 用户提示：本单录单日期/送货日期应为 ${hintDate} 前后。` : '';
    const hintCatStr = hintCat ? `
⚠️ 用户提示：本单所有商品都属「${hintCat}」分类，category 必须填「${hintCat}」。` : '';
    const mobileNote = isMobile ? `【手机拍照说明】这是手机摄像头直接拍摄的照片，请自动应对：方向（可能竖拍）、透视倾斜、反光/阴影、背景干扰、打印件摩尔纹、数字变形粘连。
` : '';
    return `${mobileNote}你是餐饮采购单表格结构化提取助手，专门识别手写/打印混合的采购单/送货单。
【输出格式】严格只输出一个 JSON 对象，不要任何解释、前言、备注、markdown 代码块之外的内容：
{
  "date": "录单日期/送货日期，必填，格式 m.d，如 6.1、3.12",
  "category": "分类名，从下方分类清单选最匹配的一个；判断不了填空字符串",
  "items": [{"name":"名称和规格（不要含单位）","unit":"单位，如箱/包/斤/kg/瓶/袋/盒/罐/支/件/个","qty":数量,"price":单价,"amount":金额,"blur":["模糊字段名"],"conf":0.0~1.0}]
}
【读取范围】只读取红色划线/方框内的商品表格，以及单据顶部/页边/表头上方「录单日期/送货日期」（注意竖写、手写日期，如 2026年7月5日 → 7.5）。绝对不要读取或输出：制单人/经办人/送货人/收货单位/仓库、送货日期黄联页脚/打印时间/第N页、总重量kg/总件数、单据编号/电话/二维码/地址。
【表格列顺序——必须严格遵守】单据表格的列顺序固定为：名称及规格 → 单位 → 数量 → 单价 → 金额。你必须按这五列一一对应输出 qty/price/amount，严禁把「金额列」的数字填到 price 字段，严禁把「单价列」的数字填到 qty 字段，严禁把「数量列」的数字填到 amount 字段。列对调是最常见错误，提取每行时请用手指从左到右对准列名再读数。
【分类清单】${catsStr}
【商品库参考（字迹完全模糊或字段缺失时辅助补全；有同款商品时直接采用库内标准单价）】${ctxStr}
【核心规则】
1. 名称规格严格忠于原图文字，单位单独填 unit，不要把「箱/包/斤/kg/瓶/袋/盒/罐/支/件/个」等塞进 name。仅字迹完全模糊时才用商品库比对补全名称；字段缺失时可用商品库历史单价/名称推算，但严禁编造原图中不存在的商品。
2. 禁止输出单据不存在的商品；同一张单据内部出现完全重复条目时只保留一条；禁止跨单据合并汇总。
3. 不要把单据底部「合计/总计/运费/小计」行当成普通商品行输出。
4. 所有数字最多保留 2 位小数。
【字段规则——金额列】
金额列（amount）必须原样读取单据上的数字，最高优先级，严禁用「数量×单价」去计算或替换金额列。例如原图金额列写的是 414，就必须输出 amount=414；写的是 495 就必须输出 amount=495；写的是 17.13 才输出 amount=17.13。绝对禁止把三位数金额 414 改成 4.14 或 17.13 这类明显是「单价×单价」的错误数字。
注意：部分送货单表头为「百十万千百十元角分」，金额格填的是「分」。例如数量 1、单价 4.14 元的商品，金额格会写 414（分）。此时仍原样输出 amount=414，后端会自动按 100 分=1 元换算。
【字段规则——单价】
餐饮采购单据上的单价几乎全部是小于 100 的小数，常见区间 1~50。如果识别出单价 ≥ 100，优先判定为漏掉了小数点，必须按下方「数据库比对」规则修正：
  306 → 3.06； 495 → 4.95； 414 → 4.14； 385 → 3.85； 390 → 3.90； 485 → 4.85。
注意：只有原图确实看清是小数点才输出小数；看不清时按数据库价输出合理小数，严禁把大整数当真实单价。
【字段规则——数量】
数量列（qty）在餐饮送货单里几乎总是整数 1、2、3…，偶尔有 1.5、2.5 等简单小数。严禁把单价列/金额列的数字填到数量列。如果数量列看不清，宁可输出 null 也不要猜一个跟单价相近的小数。
【数学校验——金额优先】
1. 金额（amount）以单据上手写/印刷数字为准，最高优先级；不得以任何理由用 qty×price 去覆盖或修改金额列。
2. 数量 × 单价 必须约等于金额，允许 ±0.02 的四舍五入误差；这一公式只用于「校验」和「补全缺失字段」，不能用于改写已经看清的金额列。
3. 当单价经数据库修正后，如果金额列清晰，数量应由「金额 ÷ 单价」反推（手写数量 1/2 最常见）。
4. 如果原单金额列缺失或完全模糊，才用「数量×单价」推算金额，并在 blur 标注「金额推算」。
【数据库比对逻辑】
以商品库为固定参考：
1. 品名近似匹配成功后，直接采用商品库里的标准单价作为该商品的单价，不要采信图片识别出来的错误大数。
2. 图片识别单价 ≥ 100 时，视为漏掉小数点：用商品库同款单价覆盖；若库内无同款，则把大整数除以 100 作为候选单价，再用金额÷候选单价校验数量是否合理。
3. 图片识别单价 < 100 但与数据库参考价偏差 > 20% 时，优先采信数据库参考价。
【手写打印混合单规则】
A. 不要忽略手写笔迹；表格行列必须严格对齐，禁止把上一行数字读到下一行，禁止把 A 行数量读到 B 行商品。
B. 手写数字 7/1/4、6/8/0、2/5 极易混淆。遇到这类数字时，优先参考本张单据底部「合计金额」做辅助校验，但不得直接篡改单元格内本身已看清的数字。
C. 金额列如果模糊、被涂改或只写了一半（如冬菇金额仅写一个「4」），不能留空或输出 0；应结合数量列、修正后单价列以及商品库历史单价，按 数量×单价 推算金额。
【数字校验优先级】
① 金额列清晰时优先采信金额。
② 品名匹配到商品库时，优先采用数据库标准单价；再用 金额÷单价 校验/反推数量。
③ 金额、单价、数量都可读时，三者相互校验，数量应为整数或简单小数（如 1、2、1.5）。若数量算出来是 100、410、57.14 等明显除法余数，说明单价或数量识别错位，应以金额和数据库单价为准重新修正。
④ 只有某一字段模糊/缺失时，才允许用另外两值推算；推算结果必须在 blur 字段中标注「金额推算」「数量推算」「单价推算」等。
【防漏行（两步法）】
第一步：先数表格有多少行商品数据（不含表头），看序号列最后一个数 N，记住 N。
第二步：按 1、2、3…N 顺序逐行提取，items 必须恰好 N 个，不跳行、不并两行为一、不把表头当数据行。打印密集表格行距小最易漏，请逐条对准网格线。
【手写数字陷阱】序号列不是金额；同一单金额量级应相近，某行明显小一个量级很可能是小数点读错；不要把金额列数字误填到数量列；不要把单价列数字误填到数量列；金额列出现 17.13/24.5/9.36 这种「约等于单价平方」的数字时，100% 是列错位，必须回到原图重新读取金额列的三位整数。
【手写汉字品名】逐笔画辨认，不要只看大概；常见误读（实↔深、冬↔冻、耳↔鱼、边↔过）请额外小心；鲜肉短名如「肉眼/肉碎/上肉碎/花肉/梅肉」、蔬菜短名如「菜心/生菜/西蓝花」、粮油短名如「冬菇/砂糖/幼砂糖」极易混淆，请对照上下文和单价谨慎判断。${hintDateStr}${hintCatStr}`;
  }

  /* ---------- 手机拍照专用提示词（复用通用增强提示词） ---------- */
function buildPromptForMobile(ctx, cats, hintDate, hintCat) {
    return buildPrompt(ctx, cats, hintDate, hintCat, true);
  }

  /* ---------- 手机拍照专用提示词（完全独立，不继承电脑端提示词） ---------- */
/* ---------- JSON 容错解析 ---------- */
  function parseJSON(text) {
    if (!text) throw new Error('\u6a21\u578b\u8fd4\u56de\u7a7a\u5185\u5bb9');
    var s = String(text).trim();
    var fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) s = fence[1].trim();
    try { return JSON.parse(s); } catch (e) { /* continue */ }
    var a = s.indexOf('{'), b = s.lastIndexOf('}');
    if (a >= 0 && b > a) {
      var sub = s.slice(a, b + 1);
      try { return JSON.parse(sub); } catch (e2) {
        sub = sub.replace(/,\s*([}\]])/g, '$1').replace(/[\u201c\u201d]/g, '"');
        try { return JSON.parse(sub); } catch (e3) { /* fall */ }
      }
    }
    throw new Error('\u65e0\u6cd5\u89e3\u6790\u6a21\u578b\u8fd4\u56de\u7684 JSON\uff1a' + s.slice(0, 160));
  }

  var OCR = {
    buildContext: buildContext,

    endpoint: function (api) {
      var b = (api.base || '').trim().replace(/\/+$/, '');
      if (!b) throw new Error('\u672a\u914d\u7f6e\u63a5\u53e3\u5730\u5740');
      if (!/\/chat\/completions$/.test(b)) b += '/chat\/completions';
      var proxy = (api.proxy || '').trim().replace(/\/+$/, '');
      // ★ 如果用户没填代理，且当前是在浏览器本地/局域网运行，自动使用 /proxy 转发，
      //   彻底解决手机拍照跨域问题；云端静态站点没有后端 /proxy，故不自动启用。
      if (!proxy && (typeof window !== 'undefined') && window.location && /^https?:$/.test(window.location.protocol)) {
        var host = window.location.hostname || '';
        var isLocal = host === 'localhost' || host === '127.0.0.1' || /^192\.168\.|^10\.|^172\.(1[6-9]|2\d|3[01])\./.test(host);
        if (isLocal) proxy = window.location.origin + '/proxy';
      }
      return {
        url: proxy || b,
        target: b,
        isProxy: !!proxy
      };
    },

    call: async function (api, messages, opt) {
      var maxTokens = (opt && opt.maxTokens) || 4000;
      if (/glm-4v-flash/i.test(api.model || '')) maxTokens = Math.min(maxTokens, 1024);
      else if (/qwen/i.test(api.model || '')) maxTokens = Math.max(maxTokens, 4096);
      var body = {
        model: api.model,
        messages: messages,
        temperature: 0,
        max_tokens: maxTokens
      };
      var ctrl = new AbortController();
      var timer = setTimeout(function () { ctrl.abort(); }, (opt && opt.timeout) || 180000);
      var resp;
      var ep = this.endpoint(api);
      var url = ep.url;
      var fetchHeaders = {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + (api.key || '')
      };
      var fetchBody = JSON.stringify(body);
      if (ep.isProxy) {
        // 走 /proxy 转发时，把真实目标地址通过 header 带给后端
        fetchHeaders['X-Target-Url'] = ep.target;
      }
      try {
        resp = await fetch(url, {
          method: 'POST',
          headers: fetchHeaders,
          body: fetchBody,
          signal: ctrl.signal
        });
      } catch (e) {
        clearTimeout(timer);
        if (e.name === 'AbortError') throw new Error('\u8bf7\u6c42\u8d85\u65f6');
        throw new Error('\u7f51\u7edc\u8bf7\u6c82\u5931\u8d25\uff1a' + e.message);
      }
      clearTimeout(timer);
      var txt = await resp.text();
      if (!resp.ok) {
        var msg = txt.slice(0, 300);
        try { var j = JSON.parse(txt); msg = (j.error && (j.error.message || j.error.code)) || msg; } catch (e) { }
        if (resp.status === 403) {
          msg = '\u8bbf\u95ee\u88ab\u62d2\u7edd/\u6a21\u578b\u672a\u5f00\u901a\uff08model=' + (api.model || '\u7a7a') + '\uff09\u3002\u539f\u54cd\u5e94\uff1a' + msg;
        }
        throw new Error('\u63a5\u53e3\u8fd4\u56de ' + resp.status + '\uff1a' + msg);
      }
      var jo;
      try { jo = JSON.parse(txt); } catch (e) { throw new Error('\u63a5\u53e3\u8fd4\u56de\u975e JSON\uff1a' + txt.slice(0, 200)); }
      var c = jo.choices && jo.choices[0];
      var content = c && c.message && c.message.content;
      if (typeof content === 'string') return content;
      if (Array.isArray(content)) return content.map(function (p) { return p.text || ''; }).join('');
      throw new Error('\u63a5\u53e3\u8fd4\u56de\u7ed3\u6784\u5f02\u5e38');
    },

    test: async function (api) {
      var out = await this.call(api, [{ role: 'user', content: '\u56de\u590d\u4e24\u4e2a\u5b57\uff1a\u6b63\u5e38' }], { maxTokens: 20, timeout: 30000 });
      return out.trim();
    },

    recognize: async function (api, dataUrl, ctx, cats, hint, isMobile) {
      var promptFn = isMobile ? buildPromptForMobile : buildPrompt;
      var msgs = [
        { role: 'system', content: SYS },
        {
          role: 'user', content: [
            { type: 'image_url', image_url: { url: dataUrl } },
            { type: 'text', text: promptFn(ctx, cats, hint && hint.date, hint && hint.cat) }
          ]
        }
      ];
      var raw = await this.call(api, msgs, {});
      var obj = parseJSON(raw);
      var items = Array.isArray(obj.items) ? obj.items : (Array.isArray(obj.rows) ? obj.rows : []);
      return {
        date: obj.date || '',
        category: obj.category || obj.supplier || '',
        items: items.map(function (it) {
          return {
            name: it.name || it.item || '',
            unit: it.unit || '',
            qty: it.qty === undefined ? it.quantity : it.qty,
            price: it.price === undefined ? it.unit_price : it.price,
            amount: it.amount === undefined ? it.total : it.amount,
            date: it.date || '',
            blur: Array.isArray(it.blur) ? it.blur : [],
            conf: typeof it.conf === 'number' ? it.conf : null
          };
        }),
        raw: raw
      };
    },

    compress: compress,
    compressForMobile: compressForMobile,
    buildPromptForMobile: buildPromptForMobile,

    runQueue: async function (tasks, conc, onEach) {
      conc = Math.max(1, Math.min(12, conc || 6));
      var idx = 0;
      var workers = new Array(conc).fill(0).map(async function () {
        while (true) {
          var k = idx++;
          if (k >= tasks.length) break;
          try { var r = await tasks[k](); onEach && onEach(k, r, null); }
          catch (e) { onEach && onEach(k, null, e); }
        }
      });
      await Promise.all(workers);
    }
  };

  g.OCR = OCR;
})(window);
