// Cloudflare Pages Functions —— 医学编辑工具云同步后端
// 路由：/api/ping  /api/signup  /api/login  /api/tasks  /api/tasks/:id
// 存储：KV 命名空间，需在 Pages 设置里绑定为变量名 DB
// 账号：邮箱 + 密码（密码加盐 SHA-256 存储），登录返回 HMAC 签名 token（30 天有效）

export async function onRequest(context) {
  const { request, env, params } = context;
  const route = '/' + ((params.path || []).join('/'));
  const method = request.method;
  const json = (obj, status = 200) =>
    new Response(JSON.stringify(obj), {
      status,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
        'access-control-allow-headers': 'Content-Type, Authorization'
      }
    });

  // CORS 预检
  if (method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
      'access-control-allow-headers': 'Content-Type, Authorization'
    }});
  }

  if (!env.DB) {
    return json({ error: '后端存储未绑定：请在 Cloudflare Pages 设置里把 KV 命名空间绑定为 DB' }, 500);
  }

  try {
    if (route === '/ping') return json({ ok: true });

    // 用户注册
    if (route === '/signup' && method === 'POST') {
      const { email, password, name } = await request.json();
      if (!email || !password || password.length < 6) {
        return json({ error: '邮箱/密码格式错误（密码至少6位）' }, 400);
      }
      const userKey = 'user:' + email;
      const exists = await env.DB.get(userKey);
      if (exists) return json({ error: '该邮箱已注册' }, 409);

      const salt = crypto.randomUUID();
      const hash = await sha256(salt + password);
      await env.DB.put(userKey, JSON.stringify({ salt, hash, created: Date.now(), name: name || email }));
      const token = await makeToken(email, env);
      return json({ ok: true, token, email, name: name || email });
    }

    // 用户登录
    if (route === '/login' && method === 'POST') {
      const { email, password } = await request.json();
      const userKey = 'user:' + email;
      const raw = await env.DB.get(userKey);
      if (!raw) return json({ error: '邮箱或密码错误' }, 401);
      const user = JSON.parse(raw);
      const hash = await sha256(user.salt + password);
      if (hash !== user.hash) return json({ error: '邮箱或密码错误' }, 401);

      const token = await makeToken(email, env);
      return json({ ok: true, token, email, name: user.name || email });
    }

    // 获取任务列表
    if (route === '/tasks' && method === 'GET') {
      const email = await auth(request, env);
      if (!email) return json({ error: '未登录' }, 401);

      const tasksKey = 'tasks:' + email;
      const raw = await env.DB.get(tasksKey);
      const tasks = raw ? JSON.parse(raw) : [];
      // 返回任务列表（不含完整 issues，只含摘要）
      const list = tasks.map(t => ({
        id: t.id,
        name: t.name,
        createdAt: t.createdAt,
        issueCount: (t.issues || []).length + (t.aiIssues || []).length,
        preview: (t.content || '').slice(0, 100)
      }));
      return json({ ok: true, tasks: list });
    }

    // 提交新任务
    if (route === '/tasks' && method === 'POST') {
      const email = await auth(request, env);
      if (!email) return json({ error: '未登录' }, 401);

      const { name, content, issues, aiIssues, docModel } = await request.json();
      if (!content) return json({ error: '任务内容不能为空' }, 400);

      const tasksKey = 'tasks:' + email;
      const raw = await env.DB.get(tasksKey);
      const tasks = raw ? JSON.parse(raw) : [];

      const task = {
        id: 'task_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
        name: name || '未命名任务',
        content,
        issues: issues || [],
        aiIssues: aiIssues || [],
        docModel: docModel || null,
        createdAt: Date.now()
      };

      tasks.unshift(task);  // 最新的在前
      // 限制每用户最多保存 50 个任务
      if (tasks.length > 50) tasks.length = 50;

      await env.DB.put(tasksKey, JSON.stringify(tasks));
      return json({ ok: true, taskId: task.id });
    }

    // 获取单个任务详情
    if (route.startsWith('/tasks/') && method === 'GET') {
      const email = await auth(request, env);
      if (!email) return json({ error: '未登录' }, 401);

      const taskId = route.slice(7);  // /tasks/{id}
      const tasksKey = 'tasks:' + email;
      const raw = await env.DB.get(tasksKey);
      const tasks = raw ? JSON.parse(raw) : [];
      const task = tasks.find(t => t.id === taskId);

      if (!task) return json({ error: '任务不存在' }, 404);
      return json({ ok: true, task });
    }

    // 删除任务
    if (route.startsWith('/tasks/') && method === 'DELETE') {
      const email = await auth(request, env);
      if (!email) return json({ error: '未登录' }, 401);

      const taskId = route.slice(7);
      const tasksKey = 'tasks:' + email;
      const raw = await env.DB.get(tasksKey);
      const tasks = raw ? JSON.parse(raw) : [];
      const filtered = tasks.filter(t => t.id !== taskId);

      if (filtered.length === tasks.length) {
        return json({ error: '任务不存在' }, 404);
      }

      await env.DB.put(tasksKey, JSON.stringify(filtered));
      return json({ ok: true });
    }

    return json({ error: '未知路由: ' + route }, 404);
  } catch (err) {
    console.error('API Error:', err);
    return json({ error: err.message || '服务器错误' }, 500);
  }
}

// ==================== 工具函数 ====================
function b64url(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlStr(s) { return b64url(new TextEncoder().encode(s)); }
function b64urlDecode(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return atob(s);
}

async function sha256(message) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(message));
  return b64url(buf);
}

async function getSecret(env) {
  let s = await env.DB.get('__secret');
  if (!s) {
    s = crypto.randomUUID() + crypto.randomUUID();
    await env.DB.put('__secret', s);
  }
  return s;
}

async function hmac(msg, secret) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg));
  return b64url(sig);
}

async function makeToken(email, env) {
  const secret = await getSecret(env);
  const payload = b64urlStr(JSON.stringify({ e: email, x: Date.now() + 1000 * 60 * 60 * 24 * 30 }));
  return payload + '.' + (await hmac(payload, secret));
}

async function auth(request, env) {
  const h = request.headers.get('Authorization') || '';
  const tok = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (!tok || !tok.includes('.')) return null;
  const [payload, sig] = tok.split('.');
  const secret = await getSecret(env);
  if (sig !== (await hmac(payload, secret))) return null;
  try {
    const obj = JSON.parse(b64urlDecode(payload));
    if (!obj.x || Date.now() > obj.x) return null;
    return obj.e;
  } catch { return null; }
}
