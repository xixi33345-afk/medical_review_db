/* ============================================================================
 * 医学内容审校 — 规则引擎 (engine.js)
 *
 * 职责：输入「结构化块数组 blocks」+「规则数组 rules」，输出「问题数组 issues」。
 * 设计铁律：
 *   - 纯函数，不碰 DOM、不碰网络、不依赖浏览器 API（可在 Node 直接跑测试）。
 *   - 只认 block.text 的【字符下标】。命中区间 [start,end) 永远是对 block.text 而言。
 *   - 两遍扫描：PASS1 逐块（单块规则）+ 收集全局索引；PASS2 跨块回填（一致性/缩写）。
 *
 * UMD 壳：浏览器 → window.MedEngine；Node → module.exports。
 * ==========================================================================*/

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.MedEngine = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* -------------------------------------------------------------------------
   * 工具函数
   * ----------------------------------------------------------------------- */

  // 取命中位置前后 window 个字符的上下文窗口文本
  function ctxWindow(text, start, end, win) {
    var w = win || 6;
    var a = Math.max(0, start - w);
    var b = Math.min(text.length, end + w);
    return text.slice(a, b);
  }

  // 命中是否应被忽略：上下文落入 ignoreContext 任一 → 忽略
  function hitIgnored(rule, text, start, end) {
    var ig = rule.ignoreContext;
    if (!ig || !ig.length) return false;
    var ctx = ctxWindow(text, start, end, rule.contextWindow);
    for (var i = 0; i < ig.length; i++) {
      if (ig[i] && ctx.indexOf(ig[i]) !== -1) return true;
    }
    return false;
  }

  // 命中是否满足 requireContext：若设置了，则上下文必须含其中任一才算有效
  function hitRequireOK(rule, text, start, end) {
    var rq = rule.requireContext;
    if (!rq || !rq.length) return true;
    var ctx = ctxWindow(text, start, end, rule.contextWindow);
    for (var i = 0; i < rq.length; i++) {
      if (rq[i] && ctx.indexOf(rq[i]) !== -1) return true;
    }
    return false;
  }

  // v2 新增：检测促销语境（用于升级黄→红）
  function hasPromoContext(rule, text, start, end) {
    if (!rule.requirePromo || !rule.requirePromo.length) return false;
    var ctx = ctxWindow(text, start, end, rule.contextWindow || 120);
    for (var i = 0; i < rule.requirePromo.length; i++) {
      if (ctx.indexOf(rule.requirePromo[i]) !== -1) return true;
    }
    return false;
  }

  // 是否满足词边界（仅对含拉丁字母的词有意义；纯中文恒为 true）
  function boundaryOK(rule, text, start, end) {
    if (!rule.wordBoundary) return true;
    var before = start > 0 ? text.charAt(start - 1) : '';
    var after = end < text.length ? text.charAt(end) : '';
    var isWord = function (c) { return /[A-Za-z0-9_]/.test(c); };
    var firstC = text.charAt(start);
    var lastC = text.charAt(end - 1);
    // 仅当词的首/尾本身是拉丁数字时，才要求外侧不是同类字符
    var leftOK = !isWord(firstC) || !isWord(before);
    var rightOK = !isWord(lastC) || !isWord(after);
    return leftOK && rightOK;
  }

  // 模板填充：{match}{mapValue}{canonical}{forms}
  function fillTpl(tpl, data) {
    if (!tpl) return '';
    return tpl
      .replace(/\{match\}/g, data.match != null ? data.match : '')
      .replace(/\{mapValue\}/g, data.mapValue != null ? data.mapValue : '')
      .replace(/\{canonical\}/g, data.canonical != null ? data.canonical : '')
      .replace(/\{forms\}/g, data.forms != null ? data.forms : '');
  }

  // 查找 needle 在 text 中的全部出现位置 [start,end)
  function findAll(text, needle) {
    var out = [];
    if (!needle) return out;
    var from = 0, idx;
    while ((idx = text.indexOf(needle, from)) !== -1) {
      out.push([idx, idx + needle.length]);
      from = idx + needle.length;   // 不重叠推进
    }
    return out;
  }

  var ISSUE_SEQ = { n: 0 };
  function newIssue(rule, block, start, end, match, extra) {
    ISSUE_SEQ.n += 1;
    var data = {
      match: match,
      mapValue: extra && extra.mapValue,
      canonical: extra && extra.canonical,
      forms: extra && extra.forms
    };

    // v2：语境感知分级 - 促销语境可能升级 yellow→red
    var finalLevel = rule.level;
    if (rule.requirePromo && hasPromoContext(rule, block.text, start, end)) {
      if (rule.level === 'yellow') finalLevel = 'red';
    }

    return {
      id: 'iss_' + String(ISSUE_SEQ.n),
      ruleId: rule.id,
      category: rule.category,
      level: finalLevel,
      source: 'rule',  // v2新增：标记来源（rule/ai）
      blockId: block.id,
      start: start,
      end: end,
      match: match,
      message: fillTpl(rule.message, data),
      suggestion: fillTpl(rule.suggestion, data),
      related: (extra && extra.related) || [],
      context: ctxWindow(block.text, start, end, 12)
    };
  }

  /* -------------------------------------------------------------------------
   * PASS 0 — 预编译 & 分桶
   * ----------------------------------------------------------------------- */

  function compileRules(rules) {
    var enabled = [];
    for (var i = 0; i < rules.length; i++) {
      var r = rules[i];
      if (r.enabled === false) continue;
      // 编译正则（容错：坏正则跳过该规则而非崩溃）
      if ((r.type === 'regex' || r.type === 'privacy') && r.pattern) {
        try { r._re = new RegExp(r.pattern, r.flags || 'g'); }
        catch (e) { r._re = null; r._reError = String(e); }
      }
      enabled.push(r);
    }
    return enabled;
  }

  /* -------------------------------------------------------------------------
   * PASS 1 — 单块规则匹配 + 全局索引收集
   * ----------------------------------------------------------------------- */

  // 单块上对单条规则求 issue（仅处理"单块类"type）
  function applyRuleToBlock(rule, block, issues) {
    var text = block.text;
    if (!text) return;
    var i, hits, h, m;

    switch (rule.type) {

      case 'keyword':
        var kws = rule.keywords || [];
        for (i = 0; i < kws.length; i++) {
          hits = findAll(text, kws[i]);
          for (h = 0; h < hits.length; h++) {
            var s = hits[h][0], e = hits[h][1];
            if (!boundaryOK(rule, text, s, e)) continue;
            if (hitIgnored(rule, text, s, e)) continue;
            if (!hitRequireOK(rule, text, s, e)) continue;
            issues.push(newIssue(rule, block, s, e, text.slice(s, e)));
          }
        }
        break;

      case 'regex':
      case 'privacy':
        if (!rule._re) break;
        rule._re.lastIndex = 0;
        var guard = 0;
        while ((m = rule._re.exec(text)) !== null) {
          var ms = m.index, me = m.index + m[0].length;
          if (m[0].length === 0) { rule._re.lastIndex++; continue; } // 防零宽死循环
          if (!hitIgnored(rule, text, ms, me) && hitRequireOK(rule, text, ms, me)) {
            issues.push(newIssue(rule, block, ms, me, m[0]));
          }
          if (!rule._re.global) break;
          if (++guard > 10000) break;
        }
        break;

      case 'map':
        var map = rule.map || {};
        for (var key in map) {
          if (!Object.prototype.hasOwnProperty.call(map, key)) continue;
          hits = findAll(text, key);
          for (h = 0; h < hits.length; h++) {
            var ms2 = hits[h][0], me2 = hits[h][1];
            if (hitIgnored(rule, text, ms2, me2)) continue;
            issues.push(newIssue(rule, block, ms2, me2, key, { mapValue: map[key] }));
          }
        }
        break;

      case 'cooccur':
        applyCooccur(rule, block, issues);
        break;

      // punct / readability 在后续阶段实现
      default:
        break;
    }
  }

  // 共现规则：块内 all 全含 且 any 任含 且 absentInBlock 全不含 → 在首个触发词处报
  function applyCooccur(rule, block, issues) {
    var text = block.text;
    var co = rule.cooccur || {};
    var all = co.all || [], any = co.any || [], absent = co.absentInBlock || [];
    var i;
    for (i = 0; i < all.length; i++) { if (text.indexOf(all[i]) === -1) return; }
    var anyOK = any.length === 0;
    for (i = 0; i < any.length; i++) { if (text.indexOf(any[i]) !== -1) { anyOK = true; break; } }
    if (!anyOK) return;
    for (i = 0; i < absent.length; i++) {
      // absent 支持正则片段（如 "\\["）；简单用 RegExp 测，失败则按字面
      var hit = false;
      try { hit = new RegExp(absent[i]).test(text); }
      catch (e) { hit = text.indexOf(absent[i]) !== -1; }
      if (hit) return;
    }
    // 触发点：定位首个 all 词位置
    var anchor = all.length ? text.indexOf(all[0]) : 0;
    if (anchor < 0) anchor = 0;
    var anchorWord = all.length ? all[0] : (text.slice(0, 4));
    issues.push(newIssue(rule, block, anchor, anchor + anchorWord.length, anchorWord));
  }

  /* -------------------------------------------------------------------------
   * 主入口 — lint(blocks, rules) → issues[]
   *   onProgress(done,total) 可选；异步让出在 lintAsync 中
   * ----------------------------------------------------------------------- */

  function lint(blocks, rules) {
    ISSUE_SEQ.n = 0;
    var compiled = compileRules(rules);
    var singleBlock = [], crossBlock = [];
    for (var i = 0; i < compiled.length; i++) {
      var t = compiled[i].type;
      if (t === 'consistency' || t === 'abbrev') crossBlock.push(compiled[i]);
      else singleBlock.push(compiled[i]);
    }

    var issues = [];

    // PASS 1
    for (var b = 0; b < blocks.length; b++) {
      for (var r = 0; r < singleBlock.length; r++) {
        applyRuleToBlock(singleBlock[r], blocks[b], issues);
      }
    }

    // PASS 2（一致性/缩写）——后续阶段实现，先留接口
    // crossBlock.forEach(...) → 追加到 issues

    // 排序：按块顺序 order，再按块内 start
    var orderOf = {};
    for (var k = 0; k < blocks.length; k++) {
      orderOf[blocks[k].id] = (blocks[k].location && blocks[k].location.order != null)
        ? blocks[k].location.order : k;
    }
    issues.sort(function (x, y) {
      var ox = orderOf[x.blockId], oy = orderOf[y.blockId];
      if (ox !== oy) return ox - oy;
      return x.start - y.start;
    });

    return issues;
  }

  return {
    lint: lint,
    compileRules: compileRules,
    _internal: {
      findAll: findAll,
      hitIgnored: hitIgnored,
      ctxWindow: ctxWindow,
      hasPromoContext: hasPromoContext
    }
  };
}));
