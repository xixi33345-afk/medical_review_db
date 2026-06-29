# 医学内容审校工具 v2 - 项目结构

```
医学编辑/
├── index.html                  # 主页面（审校工具界面）
├── login.html                  # 登录/注册页面
├── README.md                   # 项目说明
├── DEPLOYMENT.md               # 部署指南（详细步骤）
│
├── css/
│   └── style.css               # 全局样式
│
├── js/
│   ├── app.js                  # 主程序（UI逻辑、云同步集成）
│   ├── cloud-sync.js           # 云同步模块（用户认证、任务管理）
│   ├── engine.js               # 规则引擎（审校逻辑）
│   ├── parsers.js              # 文件解析器（txt/md/docx/pptx）
│   └── rules.js                # 规则库（21条审校规则）
│
├── functions/
│   └── api/
│       └── [[path]].js         # Cloudflare Pages Functions 后端
│                               # 路由：/api/signup, /api/login, /api/tasks
│
├── vendor/                     # 第三方库
│   ├── jszip.min.js            # ZIP 解压（处理 docx/pptx）
│   └── mammoth.browser.min.js # docx 转换
│
├── samples/                    # 测试样本文件
│   └── sample2_高血压科普.md
│
└── test/
    └── run.js                  # 单元测试（Node.js 环境）
```

## 核心模块说明

### 前端

1. **index.html** - 主界面
   - 文件上传 / 文本输入 / 历史记录 三个标签页
   - 审校结果展示（预览区 + 问题清单）
   - 用户信息显示（右上角）

2. **login.html** - 认证页面
   - 登录/注册表单
   - 自动检测云同步可用性（file:// 下显示提示）

3. **js/cloud-sync.js** - 云同步客户端
   - 用户认证（signup/login/logout）
   - 任务管理（保存/查询/删除）
   - LocalStorage 管理 token

4. **js/app.js** - 主程序
   - 文件上传和解析
   - 调用规则引擎审校
   - 结果渲染（高亮 + 清单）
   - 云同步集成（自动保存、历史记录加载）
   - 标签页切换

5. **js/engine.js** - 规则引擎
   - 21 条规则执行
   - 语境感知（白名单过滤、促销检测）
   - 多 PASS 分析（一致性、缩写）

6. **js/parsers.js** - 文件解析
   - txt/md: 按空行分段
   - docx/pptx: 使用 mammoth + jszip

7. **js/rules.js** - 规则库
   - 10 大类规则（合规、术语、标点等）
   - v2 特性：语境感知、来源抑制

### 后端

**functions/api/[[path]].js** - Cloudflare Pages Functions
- 使用 Cloudflare KV 存储数据
- HMAC token 认证（30天有效期）
- 密码 SHA-256 加盐存储

**API 端点**：
- `POST /api/signup` - 注册
- `POST /api/login` - 登录
- `GET /api/tasks` - 获取任务列表
- `POST /api/tasks` - 保存任务
- `GET /api/tasks/:id` - 获取任务详情
- `DELETE /api/tasks/:id` - 删除任务

**数据结构（KV）**：
```
user:{email} → {salt, hash, created, name}
tasks:{email} → [{id, name, content, createdAt, issues, aiIssues, docModel}]
__secret → HMAC 密钥（自动生成）
```

## 使用流程

### 开发模式（本地测试）
```bash
cd "医学编辑"
python -m http.server 8080
# 访问 http://localhost:8080
```

### 生产部署
参考 `DEPLOYMENT.md` 详细步骤：
1. 创建 Cloudflare KV 命名空间
2. 推送代码到 GitHub 并连接 Cloudflare Pages
3. 绑定 KV 命名空间（变量名必须是 `DB`）
4. 访问 Pages 提供的 URL

## 功能特性

✅ **规则审校**（离线）
- 21 条规则，覆盖合规、术语、标点等
- 语境感知，减少误报
- 三级问题（🔴必改 / 🟡建议 / 🔵提示）

✅ **AI 深度检查**（可选）
- 调用外部 AI API
- 检查错别字、语病
- 与规则检查结果分开显示

✅ **云同步**
- 邮箱+密码登录（5人内部团队）
- 审校完成自动保存
- 历史记录查看和回溯
- 每用户最多 50 条记录

✅ **文件格式**
- .txt / .md（纯文本）
- .docx / .pptx（Office 文档）

## 技术亮点

1. **纯前端架构** - 无构建工具，兼容 file:// 和 HTTP
2. **UMD 模块** - 所有 JS 模块支持 Node.js 和浏览器
3. **增量保存** - 只保存审校结果，不重复存储规则
4. **零成本运行** - Cloudflare 免费额度完全够用
5. **渐进增强** - file:// 可离线审校，HTTP 启用云同步

## 维护和扩展

### 添加新规则
编辑 `js/rules.js`，参考现有规则格式。

### 修改 AI 接口
编辑 `index.html` 中的 `<input id="aiUrl">`。

### 调整存储上限
编辑 `functions/api/[[path]].js` 第 115 行。

### 自定义样式
编辑 `css/style.css`。

---

**完整的 Web 应用，支持多用户、云同步、历史记录！** 🎉
