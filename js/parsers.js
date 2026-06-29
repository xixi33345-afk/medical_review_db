/* ============================================================================
 * 医学内容审校 — 文件解析器 (parsers.js)
 *
 * 职责：把上传文件解析成统一的 DocModel = { fileName, fileType, blocks:[] }。
 *   每个 block 是一个「纯文本块」：{ id, kind, text, location, meta }
 *   block.text 是【唯一真相源】—— 渲染所见 = 引擎所算 = 同一份字符串。
 *
 * 支持：.txt / .md（纯前端字符串处理）/ .docx（mammoth）/ .pptx（JSZip + DOMParser）
 *
 * UMD 壳：浏览器 → window.MedParsers；Node → module.exports（txt/md 可在 node 测）。
 * 注意：docx/pptx 依赖浏览器的 mammoth/JSZip/DOMParser，node 端不可用（仅浏览器调用）。
 * ==========================================================================*/

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.MedParsers = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var BLOCK_SEQ = { n: 0 };
  function mkBlock(kind, text, location, meta) {
    BLOCK_SEQ.n += 1;
    return {
      id: 'b' + String(BLOCK_SEQ.n),
      kind: kind,
      text: text,
      location: location || {},
      meta: meta || {}
    };
  }
  function resetSeq() { BLOCK_SEQ.n = 0; }

  /* =========================================================================
   * .txt —— 按空行切段落；单行也成块
   * ======================================================================= */
  function parseTxt(rawText, fileName) {
    resetSeq();
    var blocks = [];
    var normalized = String(rawText).replace(/\r\n?/g, '\n');
    // 以「连续空行」分段
    var chunks = normalized.split(/\n\s*\n+/);
    var order = 0;
    for (var i = 0; i < chunks.length; i++) {
      var t = chunks[i].replace(/\n+/g, ' ').trim();   // 段内换行并成空格
      if (!t) continue;
      blocks.push(mkBlock('paragraph', t, {
        label: '第' + (order + 1) + '段', source: 'txt', order: order
      }));
      order++;
    }
    return { fileName: fileName, fileType: 'txt', blocks: blocks };
  }

  /* =========================================================================
   * .md —— 逐行识别标题(#)/列表(- * 1.)/引用(>)；连续普通行并成段
   * ======================================================================= */
  function parseMd(rawText, fileName) {
    resetSeq();
    var blocks = [];
    var lines = String(rawText).replace(/\r\n?/g, '\n').split('\n');
    var order = 0;
    var paraBuf = [];

    function flushPara() {
      if (!paraBuf.length) return;
      var t = paraBuf.join(' ').trim();
      paraBuf = [];
      if (t) {
        blocks.push(mkBlock('paragraph', t, {
          label: '第' + (order + 1) + '段', source: 'md', order: order
        }));
        order++;
      }
    }

    // 去除 markdown 行内标记，得到纯文本（高亮按纯文本算下标）
    function stripInline(s) {
      return s
        .replace(/`([^`]*)`/g, '$1')                 // 行内代码
        .replace(/\*\*([^*]+)\*\*/g, '$1')           // 粗体
        .replace(/\*([^*]+)\*/g, '$1')               // 斜体
        .replace(/!\[[^\]]*\]\([^)]*\)/g, '')        // 图片
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')     // 链接保留文字
        .trim();
    }

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var trimmed = line.trim();

      // 空行 → 结束当前段
      if (!trimmed) { flushPara(); continue; }

      // 代码围栏 ``` —— 整块跳过（不审校代码）
      if (/^```/.test(trimmed)) {
        flushPara();
        i++;
        while (i < lines.length && !/^```/.test(lines[i].trim())) i++;
        continue;
      }

      // 标题 # ~ ######
      var hMatch = trimmed.match(/^(#{1,6})\s+(.*)$/);
      if (hMatch) {
        flushPara();
        var level = hMatch[1].length;
        var htext = stripInline(hMatch[2]);
        if (htext) {
          blocks.push(mkBlock('heading', htext, {
            label: '标题(H' + level + ')', source: 'md', order: order
          }, { level: level }));
          order++;
        }
        continue;
      }

      // 列表项 - * + 或 有序 1.
      var liMatch = trimmed.match(/^([-*+]|\d+\.)\s+(.*)$/);
      if (liMatch) {
        flushPara();
        var ltext = stripInline(liMatch[2]);
        if (ltext) {
          blocks.push(mkBlock('listItem', ltext, {
            label: '列表项', source: 'md', order: order
          }));
          order++;
        }
        continue;
      }

      // 引用 >
      var qMatch = trimmed.match(/^>\s?(.*)$/);
      if (qMatch) { paraBuf.push(stripInline(qMatch[1])); continue; }

      // 普通行 → 累积进段
      paraBuf.push(stripInline(trimmed));
    }
    flushPara();
    return { fileName: fileName, fileType: 'md', blocks: blocks };
  }

  /* =========================================================================
   * .docx —— mammoth.convertToHtml 拿语义结构 → DOMParser 遍历 → 每块取 textContent
   *   仅浏览器可用（依赖 window.mammoth + DOMParser）。
   * ======================================================================= */
  function parseDocx(arrayBuffer, fileName) {
    resetSeq();
    if (typeof window === 'undefined' || !window.mammoth) {
      return Promise.reject(new Error('mammoth 未加载，无法解析 docx'));
    }
    return window.mammoth.convertToHtml({ arrayBuffer: arrayBuffer }).then(function (result) {
      var html = result.value || '';
      var doc = new DOMParser().parseFromString(html, 'text/html');
      var blocks = [];
      var order = { n: 0 };
      var paraIdx = { n: 0 };

      function pushBlock(kind, text, label, meta) {
        var t = (text || '').replace(/\s+/g, ' ').trim();
        if (!t) return;
        blocks.push(mkBlock(kind, t, {
          label: label, source: 'docx', order: order.n++
        }, meta || {}));
      }

      // 遍历 body 直接子节点，按语义分块
      var body = doc.body;
      walkDocxNode(body, pushBlock, paraIdx);

      return { fileName: fileName, fileType: 'docx', blocks: blocks };
    });
  }

  function walkDocxNode(parent, pushBlock, paraIdx) {
    var nodes = parent.childNodes;
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (el.nodeType !== 1) continue;  // 仅元素
      var tag = el.tagName.toLowerCase();
      if (/^h[1-6]$/.test(tag)) {
        pushBlock('heading', el.textContent, '标题(H' + tag.charAt(1) + ')', { level: +tag.charAt(1) });
      } else if (tag === 'p') {
        paraIdx.n++;
        pushBlock('paragraph', el.textContent, '第' + paraIdx.n + '段');
      } else if (tag === 'ul' || tag === 'ol') {
        var lis = el.querySelectorAll('li');
        for (var j = 0; j < lis.length; j++) pushBlock('listItem', lis[j].textContent, '列表项');
      } else if (tag === 'table') {
        var cells = el.querySelectorAll('td,th');
        for (var c = 0; c < cells.length; c++) {
          pushBlock('tableCell', cells[c].textContent, '表格单元 ' + (c + 1));
        }
      } else {
        // 其它容器递归
        walkDocxNode(el, pushBlock, paraIdx);
      }
    }
  }

  /* =========================================================================
   * .pptx —— JSZip 解压 → ppt/slides/slideN.xml → 数值排序 → <a:p> 段落成块
   *   仅浏览器可用（依赖 window.JSZip + DOMParser）。
   * ======================================================================= */
  var NS_A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
  var NS_P = 'http://schemas.openxmlformats.org/presentationml/2006/main';

  function parsePptx(arrayBuffer, fileName) {
    resetSeq();
    if (typeof window === 'undefined' || !window.JSZip) {
      return Promise.reject(new Error('JSZip 未加载，无法解析 pptx'));
    }
    return window.JSZip.loadAsync(arrayBuffer).then(function (zip) {
      // 收集所有 slideN.xml，按整数 N 数值排序（避开 slide1/slide10/slide2 字符串序坑）
      var slideFiles = [];
      zip.forEach(function (path, file) {
        var m = path.match(/^ppt\/slides\/slide(\d+)\.xml$/);
        if (m) slideFiles.push({ path: path, n: parseInt(m[1], 10), file: file });
      });
      slideFiles.sort(function (a, b) { return a.n - b.n; });

      var order = { n: 0 };
      var blocks = [];

      // 顺序读取每张幻灯片 XML
      return slideFiles.reduce(function (chain, sf, slideIdx) {
        return chain.then(function () {
          return sf.file.async('string').then(function (xmlStr) {
            parseSlideXml(xmlStr, slideIdx + 1, blocks, order);
          });
        });
      }, Promise.resolve()).then(function () {
        return { fileName: fileName, fileType: 'pptx', blocks: blocks };
      });
    });
  }

  function parseSlideXml(xmlStr, slideNo, blocks, order) {
    var xml = new DOMParser().parseFromString(xmlStr, 'application/xml');
    // 每个 <p:sp> 是一个形状；其 <p:txBody> 内每个 <a:p> 是一个段落
    var shapes = xml.getElementsByTagNameNS(NS_P, 'sp');
    for (var s = 0; s < shapes.length; s++) {
      var sp = shapes[s];
      // 判断是否标题占位符 <p:ph type="title"/ctrTitle">
      var isTitle = false;
      var phs = sp.getElementsByTagNameNS(NS_P, 'ph');
      for (var p = 0; p < phs.length; p++) {
        var ty = phs[p].getAttribute('type');
        if (ty === 'title' || ty === 'ctrTitle') { isTitle = true; break; }
      }
      // 取该形状下所有 <a:p> 段落
      var paras = sp.getElementsByTagNameNS(NS_A, 'p');
      for (var q = 0; q < paras.length; q++) {
        var texts = paras[q].getElementsByTagNameNS(NS_A, 't');
        var buf = '';
        for (var t = 0; t < texts.length; t++) buf += texts[t].textContent;
        buf = buf.replace(/\s+/g, ' ').trim();
        if (!buf) continue;
        var kind = isTitle ? 'slideTitle' : 'slideBody';
        var label = '幻灯片' + slideNo + (isTitle ? '·标题' : '·正文');
        blocks.push(mkBlock(kind, buf, {
          label: label, source: 'pptx', order: order.n++, page: slideNo
        }));
      }
    }
  }

  /* =========================================================================
   * 统一分派入口
   * ======================================================================= */
  function detectType(fileName) {
    var m = String(fileName).toLowerCase().match(/\.([a-z0-9]+)$/);
    return m ? m[1] : '';
  }

  return {
    parseTxt: parseTxt,
    parseMd: parseMd,
    parseDocx: parseDocx,
    parsePptx: parsePptx,
    detectType: detectType,
    _mkBlock: mkBlock
  };
}));
