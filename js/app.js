/* ============================================================================
 * 医学内容审校 — 主程序 (app.js)
 *
 * 职责：上传编排 → 调 parsers 拆块 → 调 engine 扫描 → 渲染（高亮 + 清单 + 概览）。
 *   - 渲染铁律：以 block.text 为单位，自己用 line-sweep 包 <mark>，绝不复用上游 HTML 偏移。
 *   - 多文件：每个文件存为一个 doc，下拉切换。
 *   - 仅浏览器运行（依赖 DOM）。
 * ==========================================================================*/

(function () {
  'use strict';

  var Parsers = window.MedParsers;
  var Engine = window.MedEngine;
  var RULES = window.MedRules;

  // 等级元数据
  var LEVEL_META = {
    red:    { label: '必改', icon: '🔴', cls: 'lvl-red' },
    yellow: { label: '建议', icon: '🟡', cls: 'lvl-yellow' },
    blue:   { label: '提示', icon: '🔵', cls: 'lvl-blue' }
  };
  var LEVEL_RANK = { red: 3, yellow: 2, blue: 1 };

  // 类别中文名（对应规则库十大类 + AI）
  var CATEGORY_NAME = {
    1: '合规与夸大用语', 2: '药品名称', 3: '数字单位', 4: '缩写',
    5: '医学术语', 6: '标点符号', 7: '易错字', 8: '科普可读性',
    9: '隐私伦理', 10: '数据来源', 11: 'AI 深度检查'
  };

  // 应用状态
  var state = {
    docs: [],          // [{ docModel, issues }]
    activeIdx: -1,
    levelFilter: 'all',
    sourceFilter: 'all'  // v2新增：按来源筛选（all/rule/ai）
  };

  /* ---------- 云同步和登录检测 ---------- */
  var CloudSync = window.CloudSync;
  var cloudAvailable = CloudSync && CloudSync.init();

  // 检查登录状态
  function checkAuth() {
    if (!cloudAvailable) return;
    var user = CloudSync.user();
    if (!user) {
      // 未登录，跳转到登录页
      if (location.pathname.indexOf('login.html') === -1) {
        location.href = 'login.html';
      }
      return;
    }
    // 已登录，显示用户信息
    if ($('headerUser')) {
      $('headerUser').style.display = 'flex';
      $('userName').textContent = user.name || user.email;
    }
  }

  // 退出登录
  function setupLogout() {
    if ($('logoutBtn')) {
      $('logoutBtn').addEventListener('click', function () {
        if (confirm('确定要退出登录吗？')) {
          CloudSync.logout();
          location.href = 'login.html';
        }
      });
    }
  }

  // 保存当前任务到云端
  function saveTaskToCloud() {
    if (!cloudAvailable || state.activeIdx < 0) return;
    var doc = state.docs[state.activeIdx];
    if (!doc) return;

    var name = doc.docModel.filename || '未命名任务';
    var content = doc.docModel.blocks.map(function (b) { return b.text; }).join('\n\n');
    var issues = doc.issues.filter(function (i) { return i.source === 'rule'; });
    var aiIssues = doc.issues.filter(function (i) { return i.source === 'ai'; });

    CloudSync.saveTask(name, content, issues, aiIssues, doc.docModel)
      .then(function (taskId) {
        toast('✅ 任务已保存到云端（ID: ' + taskId.slice(-6) + '）');
      })
      .catch(function (err) {
        console.error('保存失败:', err);
        toast('保存失败: ' + err.message, true);
      });
  }

  /* ---------- DOM 工具 ---------- */
  function $(id) { return document.getElementById(id); }
  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function show(el) { el.classList.remove('hidden'); }
  function hide(el) { el.classList.add('hidden'); }

  function toast(msg, isError) {
    var t = $('toast');
    t.textContent = msg;
    t.className = 'toast' + (isError ? ' toast-error' : '');
    setTimeout(function () { hide(t); }, 4000);
  }

  /* =========================================================================
   * 上传处理
   * ======================================================================= */
  function setupUpload() {
    var zone = $('uploadZone');
    var input = $('fileInput');

    input.addEventListener('change', function (e) {
      handleFiles(e.target.files);
      input.value = '';  // 允许重复上传同名文件
    });

    ['dragenter', 'dragover'].forEach(function (ev) {
      zone.addEventListener(ev, function (e) {
        e.preventDefault(); e.stopPropagation();
        zone.classList.add('dragging');
      });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      zone.addEventListener(ev, function (e) {
        e.preventDefault(); e.stopPropagation();
        zone.classList.remove('dragging');
      });
    });
    zone.addEventListener('drop', function (e) {
      handleFiles(e.dataTransfer.files);
    });
  }

  /* =========================================================================
   * 标签页切换 + 文本输入
   * ======================================================================= */
  function setupTextInput() {
    // 标签页切换
    document.querySelectorAll('.tab-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var tab = btn.getAttribute('data-tab');
        // 切换按钮状态
        document.querySelectorAll('.tab-btn').forEach(function (b) { b.classList.remove('active'); });
        btn.classList.add('active');
        // 切换内容区
        document.querySelectorAll('.tab-content').forEach(function (c) { c.classList.remove('active'); });
        document.querySelector('.tab-content[data-content="' + tab + '"]').classList.add('active');
      });
    });

    // 清空按钮
    $('clearTextBtn').addEventListener('click', function () {
      $('textInput').value = '';
      $('textInput').focus();
    });

    // 开始审校按钮
    $('checkTextBtn').addEventListener('click', function () {
      var text = $('textInput').value.trim();
      if (!text) {
        toast('请先输入要审校的文本', true);
        return;
      }
      processTextInput(text);
    });
  }

  function processTextInput(text) {
    showProgress(20, '解析文本');
    // textarea 里每个换行都当段落分隔（parseTxt 按空行切段，故把单换行升为双换行）
    var normalized = text.replace(/\n+/g, '\n\n');
    var docModel = Parsers.parseTxt(normalized, '文本输入.txt');
    if (!docModel || !docModel.blocks.length) {
      toast('未提取到可审校的文字内容', true);
      hideProgress();
      return;
    }
    showProgress(60, '审校中');
    var issues = Engine.lint(docModel.blocks, RULES);
    state.docs.push({ docModel: docModel, issues: issues });
    state.activeIdx = state.docs.length - 1;
    showProgress(90, '完成');
    setTimeout(function () {
      hideProgress();
      renderDocSelect();
      renderActive();
      show($('results'));
      toast('审校完成，检出 ' + issues.length + ' 个问题');
      // 自动保存到云端
      if (cloudAvailable) {
        setTimeout(saveTaskToCloud, 500);
      }
    }, 200);
  }

  function handleFiles(fileList) {
    var files = Array.prototype.slice.call(fileList);
    if (!files.length) return;
    var queue = files.slice();

    function next() {
      if (!queue.length) { finishAll(); return; }
      var file = queue.shift();
      processOne(file).then(function () {
        next();
      }).catch(function (err) {
        toast('「' + file.name + '」解析失败：' + err.message, true);
        next();
      });
    }
    showProgress(0, '正在解析…');
    next();
  }

  function processOne(file) {
    var type = Parsers.detectType(file.name);
    showProgress(20, '解析 ' + file.name);

    return readAndParse(file, type).then(function (docModel) {
      if (!docModel || !docModel.blocks.length) {
        throw new Error('未提取到可审校的文字内容');
      }
      showProgress(60, '审校中 ' + file.name);
      var issues = Engine.lint(docModel.blocks, RULES);
      state.docs.push({ docModel: docModel, issues: issues });
      showProgress(90, '完成 ' + file.name);
    });
  }

  function readAndParse(file, type) {
    if (type === 'txt') {
      return readText(file).then(function (txt) { return Parsers.parseTxt(txt, file.name); });
    }
    if (type === 'md' || type === 'markdown') {
      return readText(file).then(function (txt) { return Parsers.parseMd(txt, file.name); });
    }
    if (type === 'docx') {
      return readArrayBuffer(file).then(function (ab) { return Parsers.parseDocx(ab, file.name); });
    }
    if (type === 'pptx') {
      return readArrayBuffer(file).then(function (ab) { return Parsers.parsePptx(ab, file.name); });
    }
    return Promise.reject(new Error('不支持的文件类型 .' + type));
  }

  function readText(file) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(r.result); };
      r.onerror = function () { reject(new Error('读取失败')); };
      r.readAsText(file, 'utf-8');
    });
  }
  function readArrayBuffer(file) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(r.result); };
      r.onerror = function () { reject(new Error('读取失败')); };
      r.readAsArrayBuffer(file);
    });
  }

  function finishAll() {
    hideProgress();
    if (!state.docs.length) return;
    state.activeIdx = state.docs.length - 1;  // 切到最新上传的
    renderDocSelect();
    renderActive();
    show($('results'));
    // 自动保存到云端
    if (cloudAvailable) {
      setTimeout(saveTaskToCloud, 500);
    }
  }

  /* ---------- 进度条 ---------- */
  function showProgress(pct, text) {
    var p = $('progress');
    show(p);
    $('progressFill').style.width = pct + '%';
    $('progressText').textContent = text || '';
  }
  function hideProgress() { hide($('progress')); }

  /* =========================================================================
   * 渲染：文件下拉
   * ======================================================================= */
  function renderDocSelect() {
    var sel = $('docSelect');
    sel.innerHTML = '';
    state.docs.forEach(function (d, i) {
      var opt = document.createElement('option');
      opt.value = String(i);
      opt.textContent = d.docModel.fileName + '（' + d.issues.length + ' 个问题）';
      sel.appendChild(opt);
    });
    sel.value = String(state.activeIdx);
    sel.onchange = function () {
      state.activeIdx = parseInt(sel.value, 10);
      renderActive();
    };
  }

  function activeDoc() { return state.docs[state.activeIdx]; }

  /* =========================================================================
   * 渲染：概览 + 预览 + 清单
   * ======================================================================= */
  function renderActive() {
    var doc = activeDoc();
    if (!doc) return;
    renderOverview(doc.issues);
    renderPreview(doc.docModel.blocks, doc.issues);
    renderIssueList(doc.issues, doc.docModel.blocks);
  }

  function filteredIssues(issues) {
    var filtered = issues;
    if (state.levelFilter !== 'all') {
      filtered = filtered.filter(function (i) { return i.level === state.levelFilter; });
    }
    if (state.sourceFilter !== 'all') {
      filtered = filtered.filter(function (i) { return i.source === state.sourceFilter; });
    }
    return filtered;
  }

  /* ---------- 概览统计 ---------- */
  function renderOverview(issues) {
    var byLevel = { red: 0, yellow: 0, blue: 0 };
    var byCat = {};
    var bySource = { rule: 0, ai: 0 };
    issues.forEach(function (i) {
      byLevel[i.level] = (byLevel[i.level] || 0) + 1;
      byCat[i.category] = (byCat[i.category] || 0) + 1;
      bySource[i.source || 'rule'] = (bySource[i.source || 'rule'] || 0) + 1;
    });

    var html = '';
    html += '<div class="ov-total">共 <strong>' + issues.length + '</strong> 个问题</div>';
    html += '<div class="ov-levels">';
    ['red', 'yellow', 'blue'].forEach(function (lv) {
      var m = LEVEL_META[lv];
      html += '<div class="ov-level ' + m.cls + '">' + m.icon + ' ' + m.label +
              ' <strong>' + (byLevel[lv] || 0) + '</strong></div>';
    });
    html += '</div>';

    // 来源区分（规则 vs AI）
    html += '<div class="ov-sources">';
    html += '<span class="ov-source ov-source-rule">🔧 规则 <strong>' + (bySource.rule || 0) + '</strong></span>';
    html += '<span class="ov-source ov-source-ai">🤖 AI <strong>' + (bySource.ai || 0) + '</strong></span>';
    html += '</div>';

    if (issues.length) {
      html += '<div class="ov-cats">';
      Object.keys(byCat).sort(function (a, b) { return a - b; }).forEach(function (c) {
        html += '<span class="ov-cat">' + (CATEGORY_NAME[c] || ('类' + c)) +
                ' <em>' + byCat[c] + '</em></span>';
      });
      html += '</div>';
    } else {
      html += '<div class="ov-clean">✅ 未发现明显问题（仍建议人工复核）</div>';
    }
    $('overview').innerHTML = html;
  }

  /* ---------- 原文预览（line-sweep 高亮）---------- */
  function renderPreview(blocks, issues) {
    var shown = filteredIssues(issues);
    // 按 blockId 归组 issue
    var byBlock = {};
    shown.forEach(function (i) {
      (byBlock[i.blockId] = byBlock[i.blockId] || []).push(i);
    });

    var html = '';
    blocks.forEach(function (b) {
      var blockIssues = byBlock[b.id] || [];
      var kindCls = 'blk-' + b.kind;
      html += '<div class="block ' + kindCls + '" data-block="' + b.id + '">';
      html += '<span class="block-loc">' + escapeHtml(b.location.label || '') + '</span>';
      html += '<div class="block-text">' + renderBlockText(b.text, blockIssues) + '</div>';
      html += '</div>';
    });
    $('previewBody').innerHTML = html || '<p class="empty">（无内容）</p>';
  }

  // line-sweep：把 text 按所有 issue 的边界切片，重叠片段取最高级颜色
  function renderBlockText(text, blockIssues) {
    if (!blockIssues.length) return escapeHtml(text);

    // 收集切点
    var points = {};
    blockIssues.forEach(function (i) {
      // 跳过整块级（start==end）issue 的区间高亮，但仍可在清单显示
      if (i.start < i.end) { points[i.start] = true; points[i.end] = true; }
    });
    points[0] = true; points[text.length] = true;
    var cuts = Object.keys(points).map(Number).sort(function (a, b) { return a - b; });

    var out = '';
    for (var k = 0; k < cuts.length - 1; k++) {
      var s = cuts[k], e = cuts[k + 1];
      if (s >= e) continue;
      var seg = text.slice(s, e);
      // 覆盖该片段的 issue
      var covering = blockIssues.filter(function (i) {
        return i.start <= s && i.end >= e && i.start < i.end;
      });
      if (!covering.length) {
        out += escapeHtml(seg);
      } else {
        // 取最高级
        var top = covering.reduce(function (a, b) {
          return LEVEL_RANK[b.level] > LEVEL_RANK[a.level] ? b : a;
        });
        var ids = covering.map(function (i) { return i.id; }).join(',');
        out += '<mark class="' + LEVEL_META[top.level].cls + '" data-issues="' + ids +
               '" title="' + escapeHtml(stripTags(covering[0].message)) + '">' +
               escapeHtml(seg) + '</mark>';
      }
    }
    return out;
  }
  function stripTags(s) { return String(s).replace(/<[^>]*>/g, ''); }

  /* ---------- 问题清单 ---------- */
  function renderIssueList(issues, blocks) {
    var shown = filteredIssues(issues);
    $('issueCount').textContent = '(' + shown.length + ')';

    if (!shown.length) {
      $('issueBody').innerHTML = '<p class="empty">当前筛选下没有问题。</p>';
      return;
    }

    var blockLabel = {};
    blocks.forEach(function (b) { blockLabel[b.id] = b.location.label || ''; });

    var html = '';
    shown.forEach(function (i) {
      var m = LEVEL_META[i.level];
      var srcBadge = i.source === 'ai'
        ? '<span class="issue-src issue-src-ai">🤖 AI</span>'
        : '<span class="issue-src issue-src-rule">🔧 规则</span>';
      html += '<div class="issue-item ' + m.cls + (i.source === 'ai' ? ' is-ai' : '') +
              '" data-issue="' + i.id + '" data-block="' + i.blockId + '">';
      html += '<div class="issue-head">';
      html += '<span class="issue-badge">' + m.icon + ' ' + m.label + '</span>';
      html += srcBadge;
      html += '<span class="issue-cat">' + (CATEGORY_NAME[i.category] || '') + '</span>';
      html += '<span class="issue-loc">' + escapeHtml(blockLabel[i.blockId] || '') + '</span>';
      html += '</div>';
      html += '<div class="issue-msg">' + escapeHtml(stripTags(i.message)) + '</div>';
      if (i.match) {
        html += '<div class="issue-match">命中："<b>' + escapeHtml(i.match) + '</b>"</div>';
      }
      if (i.suggestion) {
        html += '<div class="issue-sugg">建议：' + escapeHtml(stripTags(i.suggestion)) + '</div>';
      }
      html += '</div>';
    });
    $('issueBody').innerHTML = html;
  }

  /* =========================================================================
   * 交互：清单 ↔ 原文 联动 + 筛选 + 导出 + AI检查
   * ======================================================================= */
  function setupInteractions() {
    // 点击清单项 → 滚到原文对应块并高亮闪烁
    $('issueBody').addEventListener('click', function (e) {
      var item = e.target.closest('.issue-item');
      if (!item) return;
      var blockId = item.getAttribute('data-block');
      var issueId = item.getAttribute('data-issue');
      scrollToBlock(blockId, issueId);
    });

    // 点击原文 mark → 滚到清单对应项
    $('previewBody').addEventListener('click', function (e) {
      var mk = e.target.closest('mark');
      if (!mk) return;
      var ids = (mk.getAttribute('data-issues') || '').split(',');
      if (ids[0]) scrollToIssue(ids[0]);
    });

    // 等级筛选
    $('filters').addEventListener('click', function (e) {
      var chip = e.target.closest('.chip-level');
      if (chip) {
        document.querySelectorAll('.chip-level').forEach(function (c) { c.classList.remove('active'); });
        chip.classList.add('active');
        state.levelFilter = chip.getAttribute('data-level');
        renderActive();
        return;
      }
      // 来源筛选
      var sourceChip = e.target.closest('.chip-source');
      if (sourceChip) {
        document.querySelectorAll('.chip-source').forEach(function (c) { c.classList.remove('active'); });
        sourceChip.classList.add('active');
        state.sourceFilter = sourceChip.getAttribute('data-source');
        renderActive();
      }
    });

    // AI 深度检查
    $('aiCheckBtn').addEventListener('click', runAICheck);

    // 导出
    $('exportBtn').addEventListener('click', exportIssues);
  }

  /* =========================================================================
   * AI 深度检查（v2 新增）
   * ======================================================================= */
  var AI_CHECKING = false;

  function getAIConfig() {
    return {
      url: ($('aiUrl') && $('aiUrl').value.trim()) || 'http://127.0.0.1:12654/v1/chat/completions',
      model: ($('aiModel') && $('aiModel').value.trim()) || 'Claude-Haiku-4.5',
      key: ($('aiKey') && $('aiKey').value.trim()) || ''
    };
  }

  function runAICheck() {
    var doc = activeDoc();
    if (!doc) return;
    if (AI_CHECKING) { toast('AI 检查进行中，请稍候', true); return; }

    var btn = $('aiCheckBtn');
    btn.disabled = true;
    btn.textContent = '🤖 检查中...';
    AI_CHECKING = true;
    showProgress(10, 'AI 深度检查中');

    // 移除上次 AI 结果，避免重复
    doc.issues = doc.issues.filter(function (i) { return i.source !== 'ai'; });

    var protectedTerms = buildProtectedTerms();
    var aiConfig = getAIConfig();
    var blocks = doc.docModel.blocks;
    var aiIssues = [];
    var seq = 0;

    function checkNextBlock(idx) {
      if (idx >= blocks.length) {
        hideProgress();
        btn.disabled = false;
        btn.textContent = '🤖 AI 深度检查';
        AI_CHECKING = false;
        doc.issues = doc.issues.concat(aiIssues);
        renderDocSelect();
        renderActive();
        toast('AI 深度检查完成，新增 ' + aiIssues.length + ' 条建议');
        return;
      }

      var block = blocks[idx];
      if (!block.text || block.text.length < 10) {
        checkNextBlock(idx + 1);
        return;
      }

      showProgress(10 + Math.floor((idx / blocks.length) * 80), 'AI 检查第 ' + (idx + 1) + '/' + blocks.length + ' 块');

      callAIForBlock(block, protectedTerms, aiConfig).then(function (findings) {
        findings.forEach(function (f) {
          seq++;
          // 在块内定位 AI 返回的原文片段
          var pos = block.text.indexOf(f.original);
          var s = pos >= 0 ? pos : 0;
          var e = pos >= 0 ? pos + f.original.length : 0;
          aiIssues.push({
            id: 'ai_' + seq,
            ruleId: 'AI-' + (f.type || '其他'),
            category: 11,
            level: f.confidence === '高' ? 'yellow' : 'blue',
            source: 'ai',
            blockId: block.id,
            start: s,
            end: e,
            match: f.original || '',
            message: 'AI 发现：' + (f.type || '') + ' — ' + (f.reason || ''),
            suggestion: f.suggestion || '',
            related: [],
            context: f.original || ''
          });
        });
        checkNextBlock(idx + 1);
      }).catch(function (err) {
        console.error('AI 检查第 ' + (idx + 1) + ' 块出错:', err);
        // 第一块就失败 → 很可能是 API 不通，提示用户
        if (idx === 0 && aiIssues.length === 0) {
          hideProgress();
          btn.disabled = false;
          btn.textContent = '🤖 AI 深度检查';
          AI_CHECKING = false;
          toast('AI 接口调用失败，请确认本地服务 (127.0.0.1:12654) 是否运行', true);
          return;
        }
        checkNextBlock(idx + 1);
      });
    }

    checkNextBlock(0);
  }

  function buildProtectedTerms() {
    var terms = [];
    if (window.MedRules) {
      window.MedRules.forEach(function (r) {
        if (r.map) {
          Object.keys(r.map).forEach(function (k) { terms.push(k); });
          Object.keys(r.map).forEach(function (k) { terms.push(r.map[k]); });
        }
      });
    }
    terms = terms.concat([
      'CAR-NK', 'CAR-T', 'CD19', 'CD33', 'CD123', 'IL-7', 'IL-15', 'IFN-γ', 'TNF-α',
      'MOLM-13', 'MV4-11', 'K562', 'NSG', 'NCT', 'FDA', 'NMPA', 'WHO', 'HIV',
      'DNA', 'RNA', 'PCR', 'ELISA', 'CT', 'MRI', 'ICU', 'AML', 'CLL', 'CRS'
    ]);
    // 去重
    var seen = {}, uniq = [];
    terms.forEach(function (t) { if (t && !seen[t]) { seen[t] = 1; uniq.push(t); } });
    return uniq.join('、');
  }

  function callAIForBlock(block, protectedTerms, aiConfig) {
    var prompt = '你是资深医学编辑，只做"校对"不做"改写"。请检查下面这段医学文本，找出：\n' +
      '(1) 错别字（如"液体"误写为"液休"）\n' +
      '(2) 语病、成分残缺、搭配不当\n' +
      '(3) 明显的逻辑或指代错误\n' +
      '(4) 数字/单位的笔误\n\n' +
      '【绝对禁止】下列为专业术语，一律视为正确，不得标记、不得"纠正"：\n' +
      protectedTerms + '\n（以及所有形如 大写字母+数字 的基因/细胞系名）\n\n' +
      '【要求】\n' +
      '- 不确定是否为专业术语的，默认放过，不要标记。\n' +
      '- 只报你有把握的错误；宁可漏报，不要误报。\n' +
      '- 不要改写句子风格，不要润色，只挑错。\n' +
      '- 严格按下面 JSON 数组输出，无错误则返回 []。\n\n' +
      '【输出格式】\n' +
      '[{"original":"命中的最小片段","type":"错别字|语病|逻辑|单位","suggestion":"改为……","reason":"一句话","confidence":"高|中"}]\n\n' +
      '【待检查文本】\n' + block.text;

    var headers = { 'Content-Type': 'application/json' };
    if (aiConfig.key) headers['Authorization'] = 'Bearer ' + aiConfig.key;

    return fetch(aiConfig.url, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify({
        model: aiConfig.model,
        max_tokens: 1500,
        messages: [{ role: 'user', content: prompt }]
      })
    }).then(function (res) {
      if (!res.ok) throw new Error('AI API 返回错误: ' + res.status);
      return res.json();
    }).then(function (data) {
      // 兼容多种响应格式：
      // 1. 标准 OpenAI: data.choices[0].message.content
      // 2. huihaohealth: data.result（直接是 JSON 字符串）
      var text = '';
      if (data.result) {
        // huihaohealth 格式：result 字段直接是内容
        text = String(data.result).trim();
      } else if (data.choices && data.choices[0] && data.choices[0].message) {
        text = (data.choices[0].message.content || '').trim();
      }
      if (!text) return [];

      // 提取 JSON 数组（可能被包裹在 ```json``` 或其他文字里）
      var m = text.match(/\[[\s\S]*?\]/);
      if (!m) return [];
      try { return JSON.parse(m[0]); }
      catch (e) { console.error('AI JSON 解析失败:', text); return []; }
    });
  }

  function scrollToBlock(blockId, issueId) {
    var blk = document.querySelector('.block[data-block="' + blockId + '"]');
    if (!blk) return;
    // 优先滚到块内具体高亮的 mark（否则错字可能仍在视口外）
    var mark = null;
    if (issueId) {
      var marks = blk.querySelectorAll('mark[data-issues]');
      for (var i = 0; i < marks.length; i++) {
        var ids = (marks[i].getAttribute('data-issues') || '').split(',');
        if (ids.indexOf(issueId) !== -1) { mark = marks[i]; break; }
      }
    }
    var target = mark || blk;
    target.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
    // 只让命中的错字闪烁，不给整段加黄色背景
    if (mark) {
      mark.classList.add('mark-flash');
      setTimeout(function () { mark.classList.remove('mark-flash'); }, 1200);
    } else {
      // 没有具体 mark（整块级问题）时，给块描边提示，不填充背景
      blk.classList.add('block-outline');
      setTimeout(function () { blk.classList.remove('block-outline'); }, 1200);
    }
  }
  function scrollToIssue(issueId) {
    var it = document.querySelector('.issue-item[data-issue="' + issueId + '"]');
    if (!it) return;
    it.scrollIntoView({ behavior: 'smooth', block: 'center' });
    it.classList.add('flash');
    setTimeout(function () { it.classList.remove('flash'); }, 1200);
  }

  function exportIssues() {
    var doc = activeDoc();
    if (!doc) return;
    var lines = [];
    lines.push('# 审校问题清单 — ' + doc.docModel.fileName);
    lines.push('生成时间：' + new Date().toLocaleString('zh-CN'));
    lines.push('共 ' + doc.issues.length + ' 个问题\n');
    var blockLabel = {};
    doc.docModel.blocks.forEach(function (b) { blockLabel[b.id] = b.location.label || ''; });
    doc.issues.forEach(function (i, n) {
      var m = LEVEL_META[i.level];
      lines.push((n + 1) + '. [' + m.label + '] ' + (CATEGORY_NAME[i.category] || '') +
                 ' · ' + (blockLabel[i.blockId] || ''));
      lines.push('   问题：' + stripTags(i.message));
      if (i.match) lines.push('   命中："' + i.match + '"');
      if (i.suggestion) lines.push('   建议：' + stripTags(i.suggestion));
      lines.push('');
    });
    var blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = doc.docModel.fileName.replace(/\.[^.]+$/, '') + '_审校清单.txt';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  /* ---------- 标签切换 ---------- */
  function setupTabs() {
    var tabs = document.querySelectorAll('.tab-btn');
    var contents = document.querySelectorAll('.tab-content');

    tabs.forEach(function (tab) {
      tab.addEventListener('click', function () {
        var target = tab.getAttribute('data-tab');

        tabs.forEach(function (t) { t.classList.remove('active'); });
        contents.forEach(function (c) { c.style.display = 'none'; });

        tab.classList.add('active');
        var content = document.querySelector('[data-content="' + target + '"]');
        if (content) content.style.display = 'block';

        // 切换到历史记录时加载
        if (target === 'history') loadHistory();
      });
    });
  }

  /* ---------- 历史记录 ---------- */
  function loadHistory() {
    if (!cloudAvailable) {
      $('historyList').innerHTML = '<p class="empty">⚠️ 云同步不可用，需通过 HTTP(S) 访问</p>';
      return;
    }

    $('historyList').innerHTML = '<p class="empty">加载中...</p>';

    CloudSync.getTasks().then(function (tasks) {
      if (!tasks || tasks.length === 0) {
        $('historyList').innerHTML = '<p class="empty">暂无历史记录</p>';
        return;
      }

      var html = '';
      tasks.forEach(function (task) {
        var date = new Date(task.createdAt).toLocaleString('zh-CN');
        html += '<div class="history-item" data-task-id="' + task.id + '">';
        html += '<div class="history-item-header">';
        html += '<span class="history-item-name">' + escapeHtml(task.name) + '</span>';
        html += '<span class="history-item-date">' + date + '</span>';
        html += '</div>';
        html += '<div class="history-item-meta">';
        html += '<span>📋 ' + task.issueCount + ' 个问题</span>';
        html += '</div>';
        html += '<div class="history-item-preview">' + escapeHtml(task.preview) + '</div>';
        html += '<div class="history-item-actions" onclick="event.stopPropagation();">';
        html += '<button class="btn-view" onclick="viewTask(\'' + task.id + '\')">查看</button>';
        html += '<button class="btn-delete" onclick="deleteTask(\'' + task.id + '\')">删除</button>';
        html += '</div>';
        html += '</div>';
      });
      $('historyList').innerHTML = html;
    }).catch(function (err) {
      $('historyList').innerHTML = '<p class="empty">❌ 加载失败: ' + escapeHtml(err.message) + '</p>';
    });
  }

  // 查看历史任务
  window.viewTask = function (taskId) {
    CloudSync.getTask(taskId).then(function (task) {
      // 重建 docModel 和 issues
      var docModel = task.docModel || Parsers.parseTxt(task.content, task.name);
      var issues = (task.issues || []).concat(task.aiIssues || []);

      state.docs = [{ docModel: docModel, issues: issues }];
      state.activeIdx = 0;

      // 切换到上传标签页显示结果
      document.querySelector('[data-tab="upload"]').click();
      renderDocSelect();
      renderActive();
      show($('results'));
      toast('已加载历史任务: ' + task.name);
    }).catch(function (err) {
      toast('加载失败: ' + err.message, true);
    });
  };

  // 删除历史任务
  window.deleteTask = function (taskId) {
    if (!confirm('确定要删除这条记录吗？')) return;

    CloudSync.deleteTask(taskId).then(function () {
      toast('✅ 已删除');
      loadHistory();
    }).catch(function (err) {
      toast('删除失败: ' + err.message, true);
    });
  };

  /* ---------- 启动 ---------- */
  document.addEventListener('DOMContentLoaded', function () {
    if (!Parsers || !Engine || !RULES) {
      toast('脚本未正确加载，请检查 js/ 目录', true);
      return;
    }

    // 登录检测
    checkAuth();
    setupLogout();

    // 功能初始化
    setupTabs();
    setupUpload();
    setupTextInput();
    setupInteractions();

    // 历史记录刷新按钮
    if ($('refreshHistoryBtn')) {
      $('refreshHistoryBtn').addEventListener('click', loadHistory);
    }
  });

})();
