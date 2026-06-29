/* ============================================================================
 * 引擎单元测试 v2 (test/run.js)  —  运行： node test/run.js
 *
 * 测 engine.js + rules.js v2（语境感知）。
 * 重点：v2 的语境感知（白名单、促销升级、来源抑制）回归。
 * ==========================================================================*/

var RULES = require('../js/rules.js');
var Engine = require('../js/engine.js');

var pass = 0, fail = 0;
function assert(cond, name) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ FAIL: ' + name); }
}

var BID = 0;
function mkBlocks(textOrLines) {
  var lines = Array.isArray(textOrLines) ? textOrLines : [textOrLines];
  return lines.map(function (t, i) {
    return {
      id: 'b' + (BID++), kind: 'paragraph', text: t,
      location: { label: '第' + (i + 1) + '段', source: 'txt', order: i }, meta: {}
    };
  });
}
function lint(textOrLines) { return Engine.lint(mkBlocks(textOrLines), RULES); }
function hasRule(issues, ruleId) { return issues.some(function (i) { return i.ruleId === ruleId; }); }
function levelOf(issues, ruleId) {
  var it = issues.filter(function (i) { return i.ruleId === ruleId; })[0];
  return it ? it.level : null;
}

console.log('\n=== 1.1-A 强违规词（默认🔴）===');
(function () {
  var iss = lint('本品能根治高血压，无副作用，绝对安全。');
  assert(hasRule(iss, 'C1-001a'), '"根治/无副作用" 命中强违规词 C1-001a');
  assert(levelOf(iss, 'C1-001a') === 'red', '强违规词默认🔴');
})();

console.log('\n=== 1.1-B 语境敏感词（白名单 + 促销升级）===');
(function () {
  // 白名单：学术用法不报
  var iss = lint('本研究综述了最新进展和最大耐受剂量，疗效最持久。');
  assert(!hasRule(iss, 'C1-001b'), '"最新进展/最大耐受剂量/最持久" 白名单不报（v2核心）');
})();
(function () {
  // 非白名单 + 无促销 → 🟡
  var iss = lint('该药物疗效最佳。');
  assert(hasRule(iss, 'C1-001b'), '"最佳"（非白名单）命中 C1-001b');
  assert(levelOf(iss, 'C1-001b') === 'yellow', '无促销语境时为🟡（请人工判断）');
})();
(function () {
  // 非白名单 + 促销语境 → 🔴
  var iss = lint('本品疗效最佳，限时优惠，立即购买！');
  assert(levelOf(iss, 'C1-001b') === 'red', '促销语境（购买/优惠）升级为🔴');
})();

console.log('\n=== 1.5 疗效数据（来源抑制）===');
(function () {
  // 有 NCT 来源 → 不报
  var iss = lint('复合完全缓解率高达50%（NCT06325748）。');
  assert(!hasRule(iss, 'C1-005'), '"缓解率50%(NCT...)" 有来源标记不报（v2核心）');
})();
(function () {
  // 无来源 → 🔵 提醒
  var iss = lint('该方案有效率达到85%。');
  assert(hasRule(iss, 'C1-005'), '"有效率85%"（无来源）命中 C1-005');
  assert(levelOf(iss, 'C1-005') === 'blue', '无来源时为🔵（建议标注来源）');
})();

console.log('\n=== 专有名词白名单（避免误报）===');
(function () {
  var iss = lint('CAR-NK 细胞靶向 CD19，在 MOLM-13 细胞系中表现出活性。');
  // 不应有缩写/单位误报（v2 专有名词保护）
  var c3 = iss.filter(function (i) { return i.category === 3; });
  assert(c3.length === 0, 'CD19/MOLM-13 等专有名词不误报单位/缩写');
})();

console.log('\n=== 2类 药名 + 5/7类 术语错别字 ===');
(function () {
  var iss = lint('患者服用络活喜，有老年痴呆病史，出现粘膜充血。');
  assert(hasRule(iss, 'C2-001'), '"络活喜" 命中商品名→通用名 C2-001');
  assert(hasRule(iss, 'C5-001'), '"老年痴呆" 命中旧称 C5-001');
  assert(hasRule(iss, 'C7-001'), '"粘膜" 命中易错字 C7-001');
})();
(function () {
  // 全词匹配：中风险不误伤
  var iss = lint('这是一个中风险因素。');
  assert(!hasRule(iss, 'C5-001'), '"中风险" 不误伤为"中风"（v2全词/语境）');
})();
(function () {
  // 粘连不误伤
  var iss = lint('术后出现肠粘连。');
  assert(!hasRule(iss, 'C7-001'), '"粘连" 不误伤为"粘膜"错别字（ignoreContext）');
})();

console.log('\n=== 9类 隐私 ===');
(function () {
  var iss = lint('患者电话 13812345678，身份证 110101199001011234。');
  assert(hasRule(iss, 'C9-002'), '手机号命中隐私 C9-002');
  assert(hasRule(iss, 'C9-001'), '身份证号命中隐私 C9-001');
  assert(levelOf(iss, 'C9-001') === 'red', '隐私问题为🔴');
})();

console.log('\n=== 来源标记 source 字段 ===');
(function () {
  var iss = lint('本品能根治高血压。');
  assert(iss[0] && iss[0].source === 'rule', '规则触发的 issue 标记 source=rule');
})();

console.log('\n=== 反例：正常文本零误报 ===');
(function () {
  var iss = lint('该疗法可以改善症状、缓解疼痛，请遵医嘱使用。最新研究显示其安全性较好。');
  assert(iss.length === 0, '正常医学/学术句子零误报');
})();

console.log('\n=== 健壮性 ===');
(function () {
  var iss = Engine.lint([], RULES);
  assert(Array.isArray(iss) && iss.length === 0, '空文档不崩溃');
})();

console.log('\n----------------------------------------');
console.log('通过 ' + pass + ' / 失败 ' + fail);
console.log('----------------------------------------\n');
process.exit(fail > 0 ? 1 : 0);
