/* ============================================================================
 * 云同步模块 (cloud-sync.js) —— 用户认证 + 任务持久化
 * ==========================================================================*/

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.CloudSync = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var CloudSync = {
    base: (typeof location !== 'undefined' ? location.origin : '') + '/api',
    available: (typeof location !== 'undefined') && /^https?:$/.test(location.protocol),

    init: function () {
      if (!this.available) {
        console.warn('[CloudSync] 不可用：需要通过 HTTP(S) 访问');
        return false;
      }
      return true;
    },

    // ==================== 本地存储 ====================
    token: function () { return localStorage.getItem('med_token'); },
    user: function () {
      var t = this.token();
      if (!t) return null;
      return {
        email: localStorage.getItem('med_email') || '已登录',
        name: localStorage.getItem('med_name') || '已登录'
      };
    },
    setAuth: function (token, email, name) {
      localStorage.setItem('med_token', token);
      localStorage.setItem('med_email', email);
      localStorage.setItem('med_name', name || email);
    },
    clearAuth: function () {
      localStorage.removeItem('med_token');
      localStorage.removeItem('med_email');
      localStorage.removeItem('med_name');
    },

    // ==================== API 调用 ====================
    _req: function (path, opts) {
      opts = opts || {};
      var headers = { 'Content-Type': 'application/json' };
      var token = this.token();
      if (token) headers['Authorization'] = 'Bearer ' + token;

      return fetch(this.base + path, {
        method: opts.method || 'GET',
        headers: headers,
        body: opts.body ? JSON.stringify(opts.body) : undefined
      }).then(function (res) {
        if (!res.ok && res.status === 401) {
          // token 过期，清除本地认证
          CloudSync.clearAuth();
          throw new Error('登录已过期，请重新登录');
        }
        return res.json();
      }).then(function (data) {
        if (!data.ok && data.error) throw new Error(data.error);
        return data;
      });
    },

    // ==================== 认证 API ====================
    signup: function (email, password, name) {
      return this._req('/signup', {
        method: 'POST',
        body: { email: email, password: password, name: name }
      }).then(function (data) {
        CloudSync.setAuth(data.token, data.email, data.name);
        return data;
      });
    },

    login: function (email, password) {
      return this._req('/login', {
        method: 'POST',
        body: { email: email, password: password }
      }).then(function (data) {
        CloudSync.setAuth(data.token, data.email, data.name);
        return data;
      });
    },

    logout: function () {
      this.clearAuth();
    },

    // ==================== 任务 API ====================
    getTasks: function () {
      return this._req('/tasks').then(function (data) {
        return data.tasks || [];
      });
    },

    saveTask: function (name, content, issues, aiIssues, docModel) {
      return this._req('/tasks', {
        method: 'POST',
        body: {
          name: name,
          content: content,
          issues: issues,
          aiIssues: aiIssues,
          docModel: docModel
        }
      }).then(function (data) {
        return data.taskId;
      });
    },

    getTask: function (taskId) {
      return this._req('/tasks/' + taskId).then(function (data) {
        return data.task;
      });
    },

    deleteTask: function (taskId) {
      return this._req('/tasks/' + taskId, { method: 'DELETE' });
    }
  };

  return CloudSync;
}));
