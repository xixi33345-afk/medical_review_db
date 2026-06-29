# 医学内容审校工具 - 部署指南

## 项目概述

医学内容审校工具 v2 —— 支持云端同步和历史记录管理的 Web 应用。

**核心功能**：
- 医学文本审校（合规、术语、错别字等 21 条规则）
- AI 深度检查（可选）
- 用户登录/注册
- 任务自动保存到云端
- 历史记录查看和回溯
- 支持 .txt / .md / .docx / .pptx 文件上传

**技术栈**：
- 前端：纯 HTML/CSS/JS（无框架，兼容 file:// 和 HTTP）
- 后端：Cloudflare Pages Functions
- 存储：Cloudflare KV（键值对数据库）
- 认证：邮箱+密码，HMAC token（30天有效）

---

## 部署步骤

### 1. 准备 Cloudflare 账号

1. 注册 [Cloudflare](https://dash.cloudflare.com/sign-up) 账号（免费）
2. 进入 Dashboard → Workers & Pages

### 2. 创建 KV 命名空间

1. 在 Cloudflare Dashboard 左侧菜单点击 **Workers & Pages** → **KV**
2. 点击 **Create a namespace**
3. 命名为 `medical_review_db`（或其他名称）
4. 记下这个命名空间的 **ID**

### 3. 上传代码到 Cloudflare Pages

#### 方式 A：通过 Git 仓库（推荐）

1. 将项目推送到 GitHub/GitLab
2. 在 Cloudflare Dashboard：**Workers & Pages** → **Create application** → **Pages** → **Connect to Git**
3. 选择你的仓库，点击 **Begin setup**
4. 配置：
   - **Project name**: `medical-review`（或其他）
   - **Build command**: 留空（静态站点）
   - **Build output directory**: `/`（根目录）
5. 点击 **Save and Deploy**

#### 方式 B：通过 Wrangler CLI

```bash
# 安装 Wrangler
npm install -g wrangler

# 登录 Cloudflare
wrangler login

# 在项目目录下部署
cd "医学编辑"
wrangler pages deploy . --project-name=medical-review
```

### 4. 绑定 KV 命名空间

1. 部署完成后，进入 **Pages 项目设置**
2. 点击 **Settings** → **Functions** → **KV namespace bindings**
3. 点击 **Add binding**：
   - **Variable name**: `DB`（必须是 `DB`，代码中硬编码）
   - **KV namespace**: 选择刚才创建的 `medical_review_db`
4. 点击 **Save**
5. **重新部署**（Settings → Deployments → Retry deployment）

### 5. 访问和测试

1. 部署成功后，Cloudflare 会提供一个 URL，如：
   ```
   https://medical-review.pages.dev
   ```

2. 第一次访问会自动跳转到 `login.html` 登录页

3. **注册第一个用户**：
   - 点击"注册"标签
   - 填写姓名、邮箱、密码（至少6位）
   - 点击"注册"
   - 自动登录并跳转到主页

4. **测试功能**：
   - 上传文件或输入文本 → 点击"开始审校"
   - 审校完成后自动保存到云端
   - 点击"📋 历史记录"查看已保存的任务

---

## 本地开发和测试

### 通过 HTTP 服务器运行（必需，file:// 不支持云同步）

```bash
# 方式 1：使用 Python
cd "医学编辑"
python -m http.server 8080

# 方式 2：使用 Node.js
npx serve .

# 方式 3：使用 Bun
bun x serve .
```

然后访问 `http://localhost:8080`

### 本地开发时模拟 Cloudflare Functions

使用 Wrangler 在本地运行：

```bash
# 安装依赖
npm install -g wrangler

# 创建 wrangler.toml 配置文件（如果没有）
cat > wrangler.toml << 'EOF'
name = "medical-review"
compatibility_date = "2024-01-01"

[[kv_namespaces]]
binding = "DB"
id = "你的KV命名空间ID"

[build]
command = ""

[[pages_build_output_dir]]
value = "."
EOF

# 启动本地开发服务器
wrangler pages dev . --kv=DB
```

---

## 配置和自定义

### 修改 AI 接口

默认使用 `https://test.huihaohealth.com` 的 AI 接口。如需更换：

1. 打开 `index.html`
2. 找到 `<input type="text" id="aiUrl">`
3. 修改 `value` 属性为你的 API 地址

### 调整用户数量限制

当前每用户最多保存 **50 条历史记录**。修改方法：

1. 打开 `functions/api/[[path]].js`
2. 找到第 115 行：`if (tasks.length > 50) tasks.length = 50;`
3. 修改数字 `50` 为你需要的上限

### 自定义规则

规则库在 `js/rules.js`，可根据需求添加或修改规则。

---

## 安全建议

1. **生产环境必须启用 HTTPS**（Cloudflare Pages 自动提供）
2. **定期备份 KV 数据**：
   ```bash
   wrangler kv:key list --namespace-id=你的KV_ID > backup.json
   ```
3. **限制注册**：如仅限内部使用，可在后端添加邀请码验证
4. **Token 有效期**：默认 30 天，可在 `functions/api/[[path]].js` 第 97 行修改

---

## 常见问题

### Q: 登录后显示"未登录"或跳转到登录页？
**A**: 检查：
1. KV 命名空间是否正确绑定（变量名必须是 `DB`）
2. 浏览器是否阻止了 Cookie/LocalStorage
3. 控制台是否有 CORS 错误

### Q: 提示"后端存储未绑定"？
**A**: KV 命名空间绑定错误，返回步骤 4 重新绑定。

### Q: 历史记录为空？
**A**: 
1. 确认审校完成后有"任务已保存到云端"的提示
2. 检查浏览器控制台的网络请求（Network 面板）
3. 确认 `/api/tasks` 请求返回 200

### Q: file:// 打开时云同步不可用？
**A**: 这是正常的。云同步必须通过 HTTP(S) 访问。本地测试请用 HTTP 服务器。

---

## 成本估算

**Cloudflare 免费额度**（完全够用）：
- Pages: 无限请求
- Functions: 100,000 次/天
- KV: 100,000 次读取/天，1,000 次写入/天，1 GB 存储

**5 人团队预估使用量**：
- 每人每天 10 次审校 = 50 次写入
- 每人每天查看 5 次历史 = 250 次读取
- **远低于免费额度**

---

## 支持

如有问题，请检查：
1. Cloudflare Pages 部署日志
2. 浏览器控制台（F12）
3. Network 面板查看 API 请求状态

---

**部署完成后，你将拥有一个功能完整、支持多用户的医学内容审校平台！** 🎉
