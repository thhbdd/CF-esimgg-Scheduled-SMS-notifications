const TASK_PREFIX = "task:";
const LOG_PREFIX = "log:";
const SEND_PREFIX = "sendts:";
const DEFAULT_TIMEZONE = "Asia/Shanghai";
const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store"
};

export default {
  async fetch(request, env, ctx) {
    return handleRequest(request, env, ctx);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(processDueTasks(env, { trigger: "cron", limit: 50 }));
  }
};

async function handleRequest(request, env, ctx) {
  const url = new URL(request.url);

  if (url.pathname === "/" && request.method === "GET") {
    return htmlResponse(renderAppHtml(env));
  }

  if (url.pathname === "/health" && request.method === "GET") {
    return jsonResponse({
      ok: true,
      storage: Boolean(env.TASKS_KV),
      timezone: appTimezone(env)
    });
  }

  if (!url.pathname.startsWith("/api/")) {
    return notFound();
  }

  if (url.pathname === "/api/login" && request.method === "POST") {
    const payload = await readJson(request);
    if (areCredentialsValid(payload.username, payload.password, env)) {
      return jsonResponse({ ok: true });
    }
    return jsonResponse({ ok: false, error: "unauthorized" }, 401);
  }

  if (!isAuthorized(request, env)) {
    return jsonResponse({ ok: false, error: "unauthorized" }, 401);
  }

  try {
    if (url.pathname === "/api/me" && request.method === "GET") {
      return jsonResponse(await getMeta(env));
    }

    if (url.pathname === "/api/tasks" && request.method === "GET") {
      return jsonResponse({ ok: true, tasks: await listTasks(env) });
    }

    if (url.pathname === "/api/tasks" && request.method === "POST") {
      const payload = await readJson(request);
      const task = normalizeTask(payload);
      await putTask(env, task);
      await writeLog(env, {
        type: "task_created",
        taskId: task.id,
        title: task.title,
        message: "任务已创建"
      });
      return jsonResponse({ ok: true, task }, 201);
    }

    const taskMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)$/);
    if (taskMatch && request.method === "PUT") {
      const existing = await getTask(env, taskMatch[1]);
      if (!existing) return notFound("task_not_found");
      const payload = await readJson(request);
      const scheduleChanged = payload.scheduleType !== existing.scheduleType
        || payload.runAt !== existing.runAt
        || Number(payload.intervalDays) !== Number(existing.intervalDays);
      const merged = { ...existing, ...payload, id: existing.id, createdAt: existing.createdAt };
      if (scheduleChanged) {
        delete merged.nextRunAt;
      }
      const task = normalizeTask(merged);
      await putTask(env, task);
      await writeLog(env, {
        type: "task_updated",
        taskId: task.id,
        title: task.title,
        message: "任务已更新"
      });
      return jsonResponse({ ok: true, task });
    }

    if (taskMatch && request.method === "DELETE") {
      const existing = await getTask(env, taskMatch[1]);
      if (!existing) return notFound("task_not_found");
      await env.TASKS_KV.delete(taskKey(existing.id));
      await writeLog(env, {
        type: "task_deleted",
        taskId: existing.id,
        title: existing.title,
        message: "任务已删除"
      });
      return jsonResponse({ ok: true });
    }

    const toggleMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/toggle$/);
    if (toggleMatch && request.method === "POST") {
      const existing = await getTask(env, toggleMatch[1]);
      if (!existing) return notFound("task_not_found");
      const payload = await readJson(request);
      existing.enabled = Boolean(payload.enabled);
      existing.updatedAt = new Date().toISOString();
      if (existing.enabled && Number(new Date(existing.nextRunAt)) < Date.now()) {
        existing.nextRunAt = computeInitialNextRun(existing, new Date());
      }
      await putTask(env, existing);
      return jsonResponse({ ok: true, task: existing });
    }

    const sendMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/send$/);
    if (sendMatch && request.method === "POST") {
      const task = await getTask(env, sendMatch[1]);
      if (!task) return notFound("task_not_found");
      const result = await deliverTask(env, task, { manual: true });
      return jsonResponse({ ok: result.ok, result }, result.ok ? 200 : result.status || 500);
    }

    if (url.pathname === "/api/logs" && request.method === "GET") {
      const limit = clampInteger(Number(url.searchParams.get("limit") || 80), 1, 200);
      return jsonResponse({ ok: true, logs: await listLogs(env, limit) });
    }

    if (url.pathname === "/api/quota" && request.method === "GET") {
      return jsonResponse({ ok: true, quota: await getQuota(env) });
    }

    if (url.pathname === "/api/run-due" && request.method === "POST") {
      const result = await processDueTasks(env, { trigger: "manual", limit: 50 });
      return jsonResponse({ ok: true, result });
    }

    return notFound();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return jsonResponse({ ok: false, error: message }, 500);
  }
}

async function getMeta(env) {
  return {
    ok: true,
    timezone: appTimezone(env),
    configured: {
      apiKey: Boolean(env.ESIMGG_API_KEY),
      targetNumber: maskNumber(env.ESIMGG_TARGET_NUMBER),
      defaultFrom: env.DEFAULT_FROM || ""
    },
    quota: await getQuota(env)
  };
}

async function processDueTasks(env, options = {}) {
  const now = new Date();
  const tasks = await listTasks(env);
  const due = tasks
    .filter((task) => task.enabled && task.nextRunAt && Number(new Date(task.nextRunAt)) <= now.getTime())
    .sort((a, b) => Number(new Date(a.nextRunAt)) - Number(new Date(b.nextRunAt)))
    .slice(0, options.limit || 50);

  const results = [];
  for (const task of due) {
    const result = await deliverTask(env, task, { manual: false, trigger: options.trigger || "cron" });
    results.push({ taskId: task.id, title: task.title, ok: result.ok, type: result.type });
  }

  return { checked: tasks.length, due: due.length, results };
}

async function deliverTask(env, task, options = {}) {
  const quota = await getQuota(env);
  if (quota.used >= quota.limit) {
    const result = {
      ok: false,
      type: "quota_blocked",
      status: 429,
      message: `72小时发送量已达到 ${quota.used}/${quota.limit}，本次未调用短信接口`
    };
    await updateTaskAfterSend(env, task, result, options);
    await writeLog(env, {
      type: result.type,
      taskId: task.id,
      title: task.title,
      message: result.message
    });
    return result;
  }

  if (!env.ESIMGG_API_KEY || !env.ESIMGG_TARGET_NUMBER) {
    const missing = !env.ESIMGG_TARGET_NUMBER ? "缺少接收短信号码" : "缺少短信接口配置";
    const result = {
      ok: false,
      type: "config_missing",
      status: 500,
      message: missing
    };
    await updateTaskAfterSend(env, task, result, options);
    await writeLog(env, {
      type: result.type,
      taskId: task.id,
      title: task.title,
      message: result.message
    });
    return result;
  }

  const smsUrl = buildSmsUrl(env, task);
  let response;
  let responseText = "";

  try {
    response = await fetch(smsUrl, { method: "GET" });
    responseText = await response.text();
  } catch (error) {
    responseText = error instanceof Error ? error.message : String(error);
  }

  const ok = Boolean(response && response.ok);
  const result = {
    ok,
    type: ok ? "sms_sent" : "sms_failed",
    status: response ? response.status : 502,
    message: ok ? "短信发送成功" : "短信发送失败",
    responseText: responseText.slice(0, 500)
  };

  if (ok) {
    await markSend(env);
  }

  await updateTaskAfterSend(env, task, result, options);
  await writeLog(env, {
    type: result.type,
    taskId: task.id,
    title: task.title,
    message: result.message,
    status: result.status,
    responseText: result.responseText
  });

  return result;
}

function buildSmsUrl(env, task) {
  const target = encodeURIComponent(env.ESIMGG_TARGET_NUMBER);
  const from = task.from || env.DEFAULT_FROM || "Anonymous";
  const body = formatMessage(env, task);
  const url = new URL(`https://api.nekoko.tel/sms/send/${target}`);
  url.searchParams.set("apikey", env.ESIMGG_API_KEY);
  url.searchParams.set("from", from);
  url.searchParams.set("body", body);
  return url.toString();
}

function formatMessage(env, task) {
  return (task.message || "")
    .replaceAll("{{title}}", task.title || "")
    .replaceAll("{{date}}", formatDateTime(new Date(), appTimezone(env)));
}

async function updateTaskAfterSend(env, task, result, options = {}) {
  const now = new Date();
  const nextTask = { ...task };
  nextTask.updatedAt = now.toISOString();
  nextTask.lastAttemptAt = now.toISOString();
  nextTask.lastResult = {
    ok: result.ok,
    type: result.type,
    status: result.status,
    message: result.message,
    at: now.toISOString()
  };

  if (result.ok) {
    nextTask.lastSentAt = now.toISOString();
    nextTask.sentCount = (Number(nextTask.sentCount) || 0) + 1;
    nextTask.failureCount = Number(nextTask.failureCount) || 0;

    if (!options.manual) {
      if (nextTask.scheduleType === "once") {
        if (nextTask.autoDeleteOnComplete) {
          await env.TASKS_KV.delete(taskKey(nextTask.id));
          return;
        }
        nextTask.enabled = false;
        nextTask.completedAt = now.toISOString();
      } else {
        nextTask.nextRunAt = computeNextIntervalRun(nextTask, now);
      }
    }
  } else {
    nextTask.failureCount = (Number(nextTask.failureCount) || 0) + 1;
    if (!options.manual) {
      nextTask.nextRunAt = new Date(now.getTime() + 60 * 60 * 1000).toISOString();
    }
  }

  await putTask(env, nextTask);
}

async function getQuota(env) {
  const limit = clampInteger(Number(env.SMS_QUOTA_LIMIT || 72), 1, 10000);
  const windowHours = clampInteger(Number(env.QUOTA_WINDOW_HOURS || 72), 1, 24 * 30);
  const windowMs = windowHours * 60 * 60 * 1000;
  const now = Date.now();
  const entries = await listKeys(env, SEND_PREFIX);
  const active = entries.filter((key) => {
    const timestamp = Number(key.name.slice(SEND_PREFIX.length).split(":")[0]);
    return Number.isFinite(timestamp) && now - timestamp <= windowMs;
  });
  const oldest = active
    .map((key) => Number(key.name.slice(SEND_PREFIX.length).split(":")[0]))
    .sort((a, b) => a - b)[0];

  return {
    limit,
    used: active.length,
    remaining: Math.max(limit - active.length, 0),
    windowHours,
    resetAt: oldest ? new Date(oldest + windowMs).toISOString() : null
  };
}

async function markSend(env) {
  const windowHours = clampInteger(Number(env.QUOTA_WINDOW_HOURS || 72), 1, 24 * 30);
  const key = `${SEND_PREFIX}${Date.now()}:${crypto.randomUUID()}`;
  await env.TASKS_KV.put(key, "1", { expirationTtl: windowHours * 60 * 60 });
}

async function listTasks(env) {
  const keys = await listKeys(env, TASK_PREFIX);
  const tasks = await Promise.all(keys.map((key) => env.TASKS_KV.get(key.name, "json")));
  return tasks
    .filter(Boolean)
    .sort((a, b) => Number(new Date(a.nextRunAt || a.createdAt)) - Number(new Date(b.nextRunAt || b.createdAt)));
}

async function getTask(env, id) {
  return env.TASKS_KV.get(taskKey(id), "json");
}

async function putTask(env, task) {
  await env.TASKS_KV.put(taskKey(task.id), JSON.stringify(task));
}

async function listLogs(env, limit) {
  const keys = await listKeys(env, LOG_PREFIX);
  const sorted = keys
    .sort((a, b) => b.name.localeCompare(a.name))
    .slice(0, limit);
  const logs = await Promise.all(sorted.map((key) => env.TASKS_KV.get(key.name, "json")));
  return logs.filter(Boolean);
}

async function writeLog(env, log) {
  const entry = {
    id: crypto.randomUUID(),
    at: new Date().toISOString(),
    ...log
  };
  await env.TASKS_KV.put(`${LOG_PREFIX}${Date.now()}:${entry.id}`, JSON.stringify(entry), {
    expirationTtl: 60 * 60 * 24 * 30
  });
}

async function listKeys(env, prefix) {
  const keys = [];
  let cursor;
  do {
    const page = await env.TASKS_KV.list({ prefix, cursor, limit: 1000 });
    keys.push(...page.keys);
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return keys;
}

function normalizeTask(input) {
  const now = new Date();
  const id = input.id || crypto.randomUUID();
  const scheduleType = input.scheduleType === "once" ? "once" : "interval";
  const intervalDays = clampInteger(Number(input.intervalDays || 25), 1, 3650);
  const enabled = input.enabled !== false;
  const autoDeleteOnComplete = scheduleType === "once" && input.autoDeleteOnComplete === true;
  const task = {
    id,
    title: cleanText(input.title, 80) || "未命名提醒",
    message: cleanText(input.message, 500),
    from: cleanText(input.from, 80),
    scheduleType,
    runAt: input.runAt || null,
    intervalDays,
    autoDeleteOnComplete,
    enabled,
    createdAt: input.createdAt || now.toISOString(),
    updatedAt: now.toISOString(),
    sentCount: Number(input.sentCount) || 0,
    failureCount: Number(input.failureCount) || 0,
    lastSentAt: input.lastSentAt || null,
    lastAttemptAt: input.lastAttemptAt || null,
    lastResult: input.lastResult || null,
    completedAt: input.completedAt || null
  };

  if (!task.message) {
    throw new Error("短信内容不能为空");
  }

  task.nextRunAt = computeInitialNextRun({ ...input, ...task }, now);
  return task;
}

function computeInitialNextRun(task, now) {
  if (task.scheduleType === "once") {
    const runAt = parseDate(task.runAt);
    if (!runAt) throw new Error("指定时间无效");
    return runAt.toISOString();
  }

  const existingNext = parseDate(task.nextRunAt);
  if (existingNext && existingNext.getTime() > now.getTime()) {
    return existingNext.toISOString();
  }

  const runAt = parseDate(task.runAt);
  if (runAt && runAt.getTime() > now.getTime()) {
    return runAt.toISOString();
  }

  return new Date(now.getTime() + task.intervalDays * 24 * 60 * 60 * 1000).toISOString();
}

function computeNextIntervalRun(task, now) {
  const intervalMs = clampInteger(Number(task.intervalDays || 1), 1, 3650) * 24 * 60 * 60 * 1000;
  let next = parseDate(task.nextRunAt) || now;
  do {
    next = new Date(next.getTime() + intervalMs);
  } while (next.getTime() <= now.getTime());
  return next.toISOString();
}

function parseDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function cleanText(value, maxLength) {
  return String(value || "").trim().slice(0, maxLength);
}

function taskKey(id) {
  return `${TASK_PREFIX}${id}`;
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    throw new Error("请求体必须是 JSON");
  }
}

function isAuthorized(request, env) {
  const auth = request.headers.get("Authorization") || "";
  if (!auth.startsWith("Basic ")) return false;

  try {
    const decoded = decodeBase64Utf8(auth.slice(6));
    const separator = decoded.indexOf(":");
    if (separator < 0) return false;
    const username = decoded.slice(0, separator);
    const password = decoded.slice(separator + 1);
    return areCredentialsValid(username, password, env);
  } catch {
    return false;
  }
}

function areCredentialsValid(username, password, env) {
  const expectedUsername = String(env.ADMIN_USERNAME || "");
  const expectedPassword = String(env.ADMIN_PASSWORD || "");
  if (!expectedUsername || !expectedPassword) return false;
  return String(username || "") === expectedUsername && String(password || "") === expectedPassword;
}

function decodeBase64Utf8(value) {
  const binary = atob(value);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function appTimezone(env) {
  return DEFAULT_TIMEZONE;
}

function maskNumber(number) {
  const text = String(number || "");
  if (!text) return "";
  if (text.length <= 5) return "***";
  return `${text.slice(0, 3)}***${text.slice(-3)}`;
}

function clampInteger(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(Math.floor(value), min), max);
}

function formatDateTime(value, timezone) {
  if (!value) return "-";
  try {
    return new Intl.DateTimeFormat("zh-CN", {
      timeZone: timezone || DEFAULT_TIMEZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    }).format(new Date(value));
  } catch {
    return new Date(value).toISOString();
  }
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

function htmlResponse(html) {
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}

function notFound(error = "not_found") {
  return jsonResponse({ ok: false, error }, 404);
}

function renderAppHtml(env) {
  const timezone = appTimezone(env);
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>乌龟卡短信提醒</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f6f8f7;
      --surface: #ffffff;
      --surface-soft: #f1f6f3;
      --surface-strong: #e6f3eb;
      --line: #dce4df;
      --line-strong: #c7d4cd;
      --text: #17201b;
      --muted: #65726b;
      --subtle: #8b978f;
      --green: #0f8b4d;
      --green-dark: #08713d;
      --green-soft: #e4f6eb;
      --amber: #b7791f;
      --amber-soft: #fff5dc;
      --red: #c2413b;
      --red-soft: #fff1ef;
      --blue: #256e9e;
      --blue-soft: #eaf5fb;
      --shadow: 0 12px 34px rgba(22, 32, 27, .08);
      --radius: 8px;
      --sidebar: 228px;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
    }

    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      min-height: 100vh;
      letter-spacing: 0;
    }

    button, input, textarea, select {
      font: inherit;
    }

    button {
      border: 0;
    }

    .app {
      min-height: 100vh;
      display: grid;
      grid-template-columns: var(--sidebar) minmax(0, 1fr);
    }

    .sidebar {
      position: sticky;
      top: 0;
      height: 100vh;
      display: flex;
      flex-direction: column;
      border-right: 1px solid var(--line);
      background: rgba(255, 255, 255, .86);
      backdrop-filter: blur(16px);
      z-index: 3;
    }

    .brand {
      height: 68px;
      display: flex;
      align-items: center;
      gap: 11px;
      padding: 0 22px;
      border-bottom: 1px solid var(--line);
      font-weight: 800;
      font-size: 20px;
      white-space: nowrap;
    }

    .brand-mark {
      width: 30px;
      height: 30px;
      display: grid;
      place-items: center;
      color: var(--green);
    }

    .nav {
      padding: 18px 14px;
      display: grid;
      gap: 8px;
    }

    .nav button {
      display: flex;
      align-items: center;
      gap: 10px;
      width: 100%;
      height: 42px;
      padding: 0 13px;
      border-radius: var(--radius);
      background: transparent;
      color: var(--muted);
      text-align: left;
      cursor: pointer;
      font-size: 15px;
      font-weight: 650;
    }

    .nav button:hover {
      background: #f3f6f4;
      color: var(--text);
    }

    .nav button.active {
      background: var(--surface-strong);
      color: var(--green-dark);
    }

    .nav svg, .icon {
      width: 18px;
      height: 18px;
      stroke-width: 2;
      flex: 0 0 auto;
    }

    .status-card {
      margin: auto 14px 18px;
      border: 1px solid var(--line);
      border-radius: var(--radius);
      background: var(--surface);
      padding: 14px;
      display: grid;
      gap: 12px;
      box-shadow: 0 8px 22px rgba(22, 32, 27, .05);
    }

    .status-line {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      font-size: 13px;
      color: var(--muted);
    }

    .status-line strong {
      color: var(--green);
    }

    .dot {
      width: 9px;
      height: 9px;
      border-radius: 50%;
      background: var(--green);
      display: inline-block;
      margin-right: 7px;
    }

    .main {
      min-width: 0;
      display: grid;
      grid-template-rows: 68px minmax(0, 1fr);
    }

    .topbar {
      position: sticky;
      top: 0;
      z-index: 2;
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: 18px;
      padding: 0 24px;
      border-bottom: 1px solid var(--line);
      background: rgba(255, 255, 255, .86);
      backdrop-filter: blur(16px);
    }

    .top-item {
      display: flex;
      align-items: center;
      gap: 8px;
      color: var(--muted);
      font-size: 14px;
      white-space: nowrap;
    }

    .top-item strong {
      color: var(--text);
      font-weight: 780;
    }

    .content {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 380px;
      gap: 0;
      min-height: 0;
    }

    .workspace {
      padding: 20px 24px 24px;
      min-width: 0;
    }

    .quota-strip {
      border: 1px solid var(--line);
      border-radius: var(--radius);
      background: var(--surface);
      box-shadow: 0 10px 28px rgba(22, 32, 27, .045);
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      overflow: hidden;
    }

    .metric {
      min-height: 92px;
      padding: 18px 22px;
      display: grid;
      gap: 6px;
      border-right: 1px solid var(--line);
    }

    .metric:last-child {
      border-right: 0;
    }

    .metric-label {
      display: flex;
      align-items: center;
      gap: 8px;
      color: var(--muted);
      font-size: 13px;
      font-weight: 650;
    }

    .metric-value {
      font-size: 30px;
      line-height: 1;
      font-weight: 840;
      color: var(--green);
    }

    .metric-value.small {
      font-size: 17px;
      color: var(--text);
      line-height: 1.35;
    }

    .controls {
      margin: 18px 0 16px;
      display: grid;
      grid-template-columns: minmax(180px, 1fr) 150px 150px auto;
      gap: 12px;
      align-items: center;
    }

    .field-shell {
      position: relative;
    }

    .field-shell svg {
      position: absolute;
      left: 13px;
      top: 50%;
      transform: translateY(-50%);
      color: var(--subtle);
      pointer-events: none;
    }

    input, textarea, select {
      width: 100%;
      border: 1px solid var(--line-strong);
      background: var(--surface);
      color: var(--text);
      border-radius: var(--radius);
      outline: none;
      transition: border-color .16s ease, box-shadow .16s ease;
    }

    input, select {
      height: 42px;
      padding: 0 12px;
      font-size: 14px;
    }

    textarea {
      min-height: 118px;
      resize: vertical;
      padding: 12px;
      line-height: 1.5;
      font-size: 14px;
    }

    .field-shell input {
      padding-left: 40px;
    }

    input:focus, textarea:focus, select:focus {
      border-color: var(--green);
      box-shadow: 0 0 0 3px rgba(15, 139, 77, .13);
    }

    .button {
      min-height: 42px;
      border-radius: var(--radius);
      padding: 0 14px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      cursor: pointer;
      font-size: 14px;
      font-weight: 750;
      border: 1px solid var(--line-strong);
      background: var(--surface);
      color: var(--text);
    }

    .button:hover {
      border-color: #aebdb5;
      background: #fbfcfb;
    }

    .button.primary {
      color: #fff;
      background: linear-gradient(180deg, #149657 0%, #08733f 100%);
      border-color: #08733f;
      box-shadow: 0 10px 22px rgba(15, 139, 77, .24);
    }

    .button.danger {
      color: var(--red);
      background: var(--red-soft);
      border-color: #f0c2bd;
    }

    .button.icon-only {
      width: 38px;
      min-height: 38px;
      padding: 0;
    }

    .panel {
      border: 1px solid var(--line);
      border-radius: var(--radius);
      background: var(--surface);
      overflow: hidden;
      box-shadow: 0 10px 28px rgba(22, 32, 27, .045);
    }

    .table {
      width: 100%;
      border-collapse: collapse;
      table-layout: fixed;
    }

    th, td {
      border-bottom: 1px solid var(--line);
      padding: 14px 16px;
      text-align: left;
      vertical-align: middle;
      font-size: 14px;
    }

    th {
      color: var(--muted);
      font-size: 13px;
      font-weight: 750;
      background: #fbfcfb;
    }

    tbody tr {
      transition: background .15s ease;
    }

    tbody tr:hover {
      background: #fbfdfb;
    }

    .task-cell {
      display: flex;
      align-items: center;
      gap: 14px;
      min-width: 0;
    }

    .task-title {
      font-weight: 780;
      color: var(--text);
      margin-bottom: 4px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .task-subtitle {
      color: var(--muted);
      font-size: 13px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .switch {
      width: 34px;
      height: 20px;
      border-radius: 999px;
      background: #b9c3bd;
      position: relative;
      flex: 0 0 auto;
      cursor: pointer;
      transition: background .16s ease;
    }

    .switch::after {
      content: "";
      position: absolute;
      width: 16px;
      height: 16px;
      border-radius: 50%;
      top: 2px;
      left: 2px;
      background: #fff;
      box-shadow: 0 1px 3px rgba(0, 0, 0, .18);
      transition: transform .16s ease;
    }

    .switch.on {
      background: var(--green);
    }

    .switch.on::after {
      transform: translateX(14px);
    }

    .badge {
      display: inline-flex;
      align-items: center;
      min-height: 26px;
      padding: 0 9px;
      border-radius: 6px;
      font-size: 13px;
      font-weight: 750;
      border: 1px solid transparent;
      white-space: nowrap;
    }

    .badge.green {
      background: var(--green-soft);
      color: var(--green-dark);
      border-color: #bde8cd;
    }

    .badge.gray {
      background: #f1f3f2;
      color: var(--muted);
      border-color: #d8dfdb;
    }

    .badge.blue {
      background: var(--blue-soft);
      color: var(--blue);
      border-color: #c3dfef;
    }

    .badge.amber {
      background: var(--amber-soft);
      color: var(--amber);
      border-color: #f4d78a;
    }

    .actions {
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .form-panel {
      border-left: 1px solid var(--line);
      background: rgba(255, 255, 255, .75);
      padding: 24px 22px;
      min-width: 0;
    }

    .form-card {
      position: sticky;
      top: 92px;
      display: grid;
      gap: 16px;
    }

    .form-card h2 {
      margin: 0 0 4px;
      color: var(--green-dark);
      font-size: 22px;
      line-height: 1.2;
    }

    .form-row {
      display: grid;
      gap: 8px;
    }

    label {
      color: #314039;
      font-size: 14px;
      font-weight: 760;
    }

    .counter {
      float: right;
      color: var(--subtle);
      font-weight: 600;
    }

    .radio-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
    }

    .radio-card {
      min-height: 42px;
      border: 1px solid var(--line-strong);
      border-radius: var(--radius);
      background: var(--surface);
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 0 11px;
      cursor: pointer;
      color: var(--muted);
      font-size: 14px;
      font-weight: 720;
    }

    .radio-card input {
      width: 16px;
      height: 16px;
      accent-color: var(--green);
    }

    .radio-card:has(input:checked) {
      color: var(--green-dark);
      border-color: #8fd4aa;
      background: #f3fbf6;
    }

    .stepper {
      display: grid;
      grid-template-columns: 42px 1fr 42px;
    }

    .stepper input {
      border-radius: 0;
      text-align: center;
      border-left: 0;
      border-right: 0;
    }

    .stepper button {
      border: 1px solid var(--line-strong);
      background: var(--surface);
      color: var(--text);
      cursor: pointer;
      font-size: 20px;
    }

    .stepper button:first-child {
      border-radius: var(--radius) 0 0 var(--radius);
    }

    .stepper button:last-child {
      border-radius: 0 var(--radius) var(--radius) 0;
    }

    .datetime-shell {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 58px;
      align-items: center;
      height: 42px;
      border: 1px solid var(--line-strong);
      border-radius: var(--radius);
      background: var(--surface);
      overflow: hidden;
      transition: border-color .16s ease, box-shadow .16s ease;
    }

    .datetime-shell:focus-within {
      border-color: var(--green);
      box-shadow: 0 0 0 3px rgba(15, 139, 77, .13);
    }

    .datetime-shell input {
      min-width: 0;
      height: 40px;
      border: 0;
      border-radius: 0;
      background: transparent;
      box-shadow: none;
    }

    .datetime-shell input:focus {
      box-shadow: none;
    }

    .period-toggle {
      height: 100%;
      border-left: 1px solid var(--line);
      background: var(--surface-soft);
      color: var(--green-dark);
      cursor: pointer;
      font-size: 14px;
      font-weight: 750;
    }

    .period-toggle:hover {
      color: var(--text);
      background: #f3fbf6;
    }

    .toggle-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }

    .form-actions {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
      padding-top: 2px;
    }

    .empty-state {
      min-height: 260px;
      display: grid;
      place-items: center;
      text-align: center;
      color: var(--muted);
      gap: 8px;
      padding: 36px 20px;
    }

    .empty-state strong {
      color: var(--text);
      font-size: 18px;
    }

    .logs {
      display: grid;
      gap: 10px;
    }

    .log-row {
      display: grid;
      grid-template-columns: 150px 120px 1fr;
      gap: 12px;
      align-items: center;
      padding: 13px 14px;
      border: 1px solid var(--line);
      border-radius: var(--radius);
      background: var(--surface);
      font-size: 14px;
    }

    .settings {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 14px;
    }

    .setting-item {
      border: 1px solid var(--line);
      border-radius: var(--radius);
      background: var(--surface);
      padding: 16px;
      display: grid;
      gap: 6px;
    }

    .setting-item span {
      color: var(--muted);
      font-size: 13px;
      font-weight: 720;
    }

    .setting-item strong {
      font-size: 16px;
      overflow-wrap: anywhere;
    }

    .toast {
      position: fixed;
      right: 24px;
      bottom: 24px;
      z-index: 20;
      background: #17201b;
      color: #fff;
      border-radius: var(--radius);
      padding: 12px 14px;
      font-size: 14px;
      box-shadow: var(--shadow);
      display: none;
    }

    .toast.show {
      display: block;
      animation: toast-in .18s ease-out;
    }

    .login {
      position: fixed;
      inset: 0;
      background: rgba(246, 248, 247, .88);
      backdrop-filter: blur(16px);
      z-index: 30;
      display: none;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }

    .login.show {
      display: flex;
    }

    .login-card {
      width: min(420px, 100%);
      border: 1px solid var(--line);
      border-radius: var(--radius);
      background: var(--surface);
      box-shadow: var(--shadow);
      padding: 24px;
      display: grid;
      gap: 14px;
    }

    .login-card h1 {
      margin: 0;
      font-size: 24px;
      line-height: 1.2;
    }

    .login-card p {
      margin: 0;
      color: var(--muted);
      line-height: 1.6;
      font-size: 14px;
    }

    .muted {
      color: var(--muted);
    }

    .mobile-action {
      display: none;
    }

    @keyframes toast-in {
      from { transform: translateY(8px); opacity: 0; }
      to { transform: translateY(0); opacity: 1; }
    }

    @media (max-width: 1180px) {
      .content {
        grid-template-columns: 1fr;
      }

      .form-panel {
        border-left: 0;
        border-top: 1px solid var(--line);
      }

      .form-card {
        position: static;
        max-width: 760px;
      }
    }

    @media (max-width: 880px) {
      .app {
        grid-template-columns: 1fr;
      }

      .sidebar {
        position: static;
        height: auto;
        border-right: 0;
      }

      .brand {
        height: 62px;
      }

      .nav {
        grid-template-columns: repeat(3, 1fr);
        padding: 10px 12px;
      }

      .nav button {
        justify-content: center;
        padding: 0 10px;
      }

      .status-card {
        display: none;
      }

      .main {
        grid-template-rows: auto minmax(0, 1fr);
      }

      .topbar {
        position: static;
        justify-content: space-between;
        overflow-x: auto;
        height: 58px;
        padding: 0 14px;
      }

      .workspace {
        padding: 14px;
      }

      .quota-strip {
        grid-template-columns: 1fr;
      }

      .metric {
        min-height: 72px;
        border-right: 0;
        border-bottom: 1px solid var(--line);
      }

      .metric:last-child {
        border-bottom: 0;
      }

      .controls {
        grid-template-columns: 1fr;
      }

      .panel {
        border: 0;
        background: transparent;
        box-shadow: none;
      }

      table, thead, tbody, tr, td {
        display: block;
      }

      thead {
        display: none;
      }

      tbody {
        display: grid;
        gap: 10px;
      }

      tbody tr {
        border: 1px solid var(--line);
        border-radius: var(--radius);
        background: var(--surface);
        box-shadow: 0 8px 22px rgba(22, 32, 27, .045);
      }

      td {
        border-bottom: 0;
        padding: 12px 14px;
      }

      td::before {
        content: attr(data-label);
        display: block;
        margin-bottom: 4px;
        color: var(--muted);
        font-size: 12px;
        font-weight: 760;
      }

      td:first-child::before, td:last-child::before {
        display: none;
      }

      .log-row, .settings {
        grid-template-columns: 1fr;
      }

      .form-panel {
        padding: 18px 14px 24px;
      }

      .mobile-action {
        display: inline-flex;
      }
    }
  </style>
</head>
<body>
  <div class="app">
    <aside class="sidebar">
      <div class="brand">
        <span class="brand-mark">${svgTurtle()}</span>
        <span>乌龟卡短信提醒</span>
      </div>
      <nav class="nav" aria-label="主导航">
        <button class="active" data-tab="tasks">${icon("calendar")}任务列表</button>
        <button data-tab="logs">${icon("mail")}发送记录</button>
        <button data-tab="settings">${icon("settings")}设置</button>
      </nav>
      <div class="status-card">
        <div class="status-line"><span><span class="dot"></span>服务状态</span><strong id="sideStatus">检查中</strong></div>
        <div class="status-line"><span>当前时区</span><span>北京时间</span></div>
        <div class="status-line"><span>扫描频率</span><span>5 分钟</span></div>
      </div>
    </aside>

    <main class="main">
      <header class="topbar">
        <div class="top-item">${icon("settings")}<strong>短信配置</strong></div>
        <div class="top-item">${icon("user")}<strong id="targetNumber">Nekoko</strong></div>
        <div class="top-item"><span class="dot"></span><span>配额使用</span><strong id="quotaTop">-</strong></div>
        <div class="top-item">${icon("clock")}<span>下一次重置</span><strong id="resetTop">-</strong></div>
      </header>

      <section class="content">
        <div class="workspace">
          <section class="quota-strip" aria-label="短信配额">
            <div class="metric">
              <div class="metric-label">${icon("shield")}72 小时限制</div>
              <div class="metric-value" id="quotaLimit">72 条</div>
            </div>
            <div class="metric">
              <div class="metric-label">${icon("send")}已发送（72小时）</div>
              <div class="metric-value" id="quotaUsed">0 条</div>
            </div>
            <div class="metric">
              <div class="metric-label">${icon("clock")}最近到期任务</div>
              <div class="metric-value small" id="nextTask">-</div>
            </div>
          </section>

          <div id="tasksView">
            <div class="controls">
              <div class="field-shell">${icon("search")}<input id="searchInput" type="search" placeholder="搜索任务标题或内容"></div>
              <select id="statusFilter" aria-label="状态筛选">
                <option value="all">全部状态</option>
                <option value="enabled">启用中</option>
                <option value="disabled">已暂停</option>
              </select>
              <select id="typeFilter" aria-label="方式筛选">
                <option value="all">全部方式</option>
                <option value="interval">间隔提醒</option>
                <option value="once">指定时间</option>
              </select>
              <button class="button" id="refreshBtn">${icon("refresh")}刷新</button>
            </div>

            <div class="panel">
              <table class="table">
                <thead>
                  <tr>
                    <th style="width: 38%;">任务</th>
                    <th style="width: 18%;">提醒方式 / 时间</th>
                    <th style="width: 18%;">下次提醒</th>
                    <th style="width: 12%;">状态</th>
                    <th style="width: 14%;">操作</th>
                  </tr>
                </thead>
                <tbody id="taskRows"></tbody>
              </table>
              <div id="taskEmpty" class="empty-state" hidden>
                <div>${icon("calendar")}</div>
                <span>在右侧新建一个 GV 续期、网站检查或任意短信提醒。</span>
              </div>
            </div>
          </div>

          <div id="logsView" hidden>
            <div class="controls" style="grid-template-columns: 1fr auto;">
              <div class="muted">最近 30 天的发送、失败、配额拦截和任务变更记录。</div>
              <button class="button" id="refreshLogsBtn">${icon("refresh")}刷新</button>
            </div>
            <div class="logs" id="logRows"></div>
            <div id="logEmpty" class="empty-state" hidden>
            </div>
          </div>

          <div id="settingsView" hidden>
            <div class="controls" style="grid-template-columns: 1fr auto;">
              <div class="muted">查看当前短信提醒配置和运行状态。</div>
              <button class="button" id="runDueBtn">${icon("send")}立即扫描到期任务</button>
            </div>
            <div class="settings">
              <div class="setting-item"><span>接收短信号码</span><strong id="settingTarget">-</strong></div>
              <div class="setting-item"><span>默认来自号码（显示用）</span><strong id="settingFrom">-</strong></div>
              <div class="setting-item"><span>短信接口</span><strong id="settingApiKey">-</strong></div>
              <div class="setting-item"><span>时区</span><strong id="settingTimezone">${escapeHtml(timezone)}</strong></div>
              <div class="setting-item"><span>Cron</span><strong>每 5 分钟扫描一次</strong></div>
              <div class="setting-item"><span>运行状态</span><strong>自动扫描</strong></div>
            </div>
          </div>
        </div>

        <aside class="form-panel" id="formPanel">
          <form class="form-card" id="taskForm">
            <h2 id="formTitle">新建提醒</h2>
            <input type="hidden" id="taskId">

            <div class="form-row">
              <label for="title">提醒标题 <span class="counter" id="titleCounter">0/80</span></label>
              <input id="title" maxlength="80" placeholder="例如：GV 续期提醒" required>
            </div>

            <div class="form-row">
              <label for="message">短信内容 <span class="counter" id="messageCounter">0/500</span></label>
              <textarea id="message" maxlength="500" placeholder="请输入短信内容，例如：该续期 Google Voice 号码了。" required></textarea>
            </div>

            <div class="form-row">
              <label for="from">来自号码</label>
              <input id="from" placeholder="默认来自号码">
            </div>

            <div class="form-row">
              <label>提醒方式</label>
              <div class="radio-grid">
                <label class="radio-card"><input type="radio" name="scheduleType" value="once">指定时间</label>
                <label class="radio-card"><input type="radio" name="scheduleType" value="interval" checked>间隔提醒</label>
              </div>
            </div>

            <div class="form-row">
              <label for="runAt">指定时间</label>
              <div class="datetime-shell">
                <input id="runAt" type="datetime-local" required>
                <button class="period-toggle" type="button" id="periodToggle">上午</button>
              </div>
            </div>

            <div class="form-row" id="intervalRow">
              <label for="intervalDays">间隔天数</label>
              <div class="stepper">
                <button type="button" id="minusDay" aria-label="减少天数">-</button>
                <input id="intervalDays" type="number" min="1" max="3650" value="25">
                <button type="button" id="plusDay" aria-label="增加天数">+</button>
              </div>
            </div>

            <div class="toggle-row" id="autoDeleteRow">
              <label for="autoDeleteSwitch">完成后自动删除</label>
              <div id="autoDeleteSwitch" class="switch" role="switch" aria-checked="false" tabindex="0"></div>
            </div>

            <div class="toggle-row">
              <label for="enabledSwitch">启用任务</label>
              <div id="enabledSwitch" class="switch on" role="switch" aria-checked="true" tabindex="0"></div>
            </div>

            <div class="form-actions">
              <button class="button" type="button" id="resetFormBtn">重置</button>
              <button class="button primary" type="submit">${icon("save")}保存提醒</button>
            </div>
          </form>
        </aside>
      </section>
    </main>
  </div>

  <div class="login" id="login">
    <form class="login-card" id="loginForm">
      <h1>登录管理面板</h1>
      <input id="usernameInput" autocomplete="username" placeholder="用户名">
      <input id="passwordInput" type="password" autocomplete="current-password" placeholder="密码">
      <button class="button primary" type="submit">进入面板</button>
    </form>
  </div>

  <div class="toast" id="toast"></div>

  <script>
    const state = {
      username: sessionStorage.getItem("turtle_sms_username") || "",
      password: sessionStorage.getItem("turtle_sms_password") || "",
      tasks: [],
      logs: [],
      meta: null,
      tab: "tasks",
      enabled: true,
      autoDeleteOnComplete: false,
      editingId: ""
    };

    const els = {};
    const iconMap = {
      edit: '${inlineIcon("edit")}',
      copy: '${inlineIcon("copy")}',
      send: '${inlineIcon("send")}',
      trash: '${inlineIcon("trash")}'
    };

    document.addEventListener("DOMContentLoaded", init);

    function init() {
      [
        "login", "loginForm", "usernameInput", "passwordInput", "taskRows", "taskEmpty", "logRows", "logEmpty",
        "tasksView", "logsView", "settingsView", "searchInput", "statusFilter", "typeFilter",
        "refreshBtn", "refreshLogsBtn", "runDueBtn", "taskForm", "taskId", "title",
        "message", "from", "runAt", "periodToggle", "intervalDays", "intervalRow", "autoDeleteRow", "autoDeleteSwitch", "enabledSwitch",
        "resetFormBtn", "titleCounter", "messageCounter", "formTitle", "quotaTop",
        "resetTop", "quotaLimit", "quotaUsed", "nextTask", "sideStatus", "targetNumber",
        "settingTarget", "settingFrom", "settingApiKey", "settingTimezone", "minusDay",
        "plusDay", "toast"
      ].forEach((id) => els[id] = document.getElementById(id));

      document.querySelectorAll(".nav button").forEach((button) => {
        button.addEventListener("click", () => setTab(button.dataset.tab));
      });

      els.loginForm.addEventListener("submit", async (event) => {
        event.preventDefault();
        state.username = els.usernameInput.value.trim();
        state.password = els.passwordInput.value;
        try {
          await login();
          sessionStorage.setItem("turtle_sms_username", state.username);
          sessionStorage.setItem("turtle_sms_password", state.password);
          await loadAll();
        } catch (error) {
          toast(error.message);
        }
      });

      els.taskForm.addEventListener("submit", saveTask);
      els.resetFormBtn.addEventListener("click", resetForm);
      els.refreshBtn.addEventListener("click", loadAll);
      els.refreshLogsBtn.addEventListener("click", loadLogs);
      els.runDueBtn.addEventListener("click", runDue);
      els.searchInput.addEventListener("input", renderTasks);
      els.statusFilter.addEventListener("change", renderTasks);
      els.typeFilter.addEventListener("change", renderTasks);
      els.title.addEventListener("input", updateCounters);
      els.message.addEventListener("input", updateCounters);
      els.runAt.addEventListener("input", syncPeriodToggle);
      els.minusDay.addEventListener("click", () => adjustDays(-1));
      els.plusDay.addEventListener("click", () => adjustDays(1));
      els.periodToggle.addEventListener("click", toggleTimePeriod);

      document.querySelectorAll("input[name='scheduleType']").forEach((input) => {
        input.addEventListener("change", updateScheduleVisibility);
      });

      els.enabledSwitch.addEventListener("click", () => setEnabled(!state.enabled));
      els.enabledSwitch.addEventListener("keydown", (event) => {
        if (event.key === " " || event.key === "Enter") {
          event.preventDefault();
          setEnabled(!state.enabled);
        }
      });
      els.autoDeleteSwitch.addEventListener("click", () => setAutoDelete(!state.autoDeleteOnComplete));
      els.autoDeleteSwitch.addEventListener("keydown", (event) => {
        if (event.key === " " || event.key === "Enter") {
          event.preventDefault();
          setAutoDelete(!state.autoDeleteOnComplete);
        }
      });

      setDefaultRunAt();
      updateCounters();
      updateScheduleVisibility();
      syncPeriodToggle();

      if (!state.username || !state.password) {
        showLogin();
      } else {
        loadAll();
      }
    }

    async function login() {
      const response = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: state.username, password: state.password })
      });
      const data = await response.json().catch(() => ({ ok: false, error: "invalid_json" }));
      if (!response.ok || data.ok === false) {
        throw new Error("用户名或密码错误");
      }
      return data;
    }

    async function api(path, options = {}) {
      const response = await fetch(path, {
        ...options,
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Basic " + encodeBasicAuth(state.username, state.password),
          ...(options.headers || {})
        }
      });
      const data = await response.json().catch(() => ({ ok: false, error: "invalid_json" }));
      if (response.status === 401) {
        sessionStorage.removeItem("turtle_sms_username");
        sessionStorage.removeItem("turtle_sms_password");
        showLogin();
        throw new Error("登录已失效，请重新登录");
      }
      if (!response.ok || data.ok === false) {
        throw new Error(data.error || data.message || "请求失败");
      }
      return data;
    }

    async function loadAll() {
      try {
        const [meta, tasks, logs] = await Promise.all([
          api("/api/me"),
          api("/api/tasks"),
          api("/api/logs?limit=80")
        ]);
        state.meta = meta;
        state.tasks = tasks.tasks || [];
        state.logs = logs.logs || [];
        hideLogin();
        renderAll();
        toast("已刷新");
      } catch (error) {
        toast(error.message);
      }
    }

    async function loadLogs() {
      try {
        const data = await api("/api/logs?limit=100");
        state.logs = data.logs || [];
        renderLogs();
        toast("记录已刷新");
      } catch (error) {
        toast(error.message);
      }
    }

    async function saveTask(event) {
      event.preventDefault();
      const task = taskFromForm();
      const isEditing = Boolean(state.editingId);
      try {
        const data = await api(isEditing ? "/api/tasks/" + state.editingId : "/api/tasks", {
          method: isEditing ? "PUT" : "POST",
          body: JSON.stringify(task)
        });
        const saved = data.task;
        const index = state.tasks.findIndex((item) => item.id === saved.id);
        if (index >= 0) state.tasks.splice(index, 1, saved);
        else state.tasks.push(saved);
        resetForm();
        renderAll();
        toast(isEditing ? "提醒已更新" : "提醒已创建");
      } catch (error) {
        toast(error.message);
      }
    }

    function taskFromForm() {
      const scheduleType = document.querySelector("input[name='scheduleType']:checked").value;
      return {
        title: els.title.value.trim(),
        message: els.message.value.trim(),
        from: els.from.value.trim(),
        scheduleType,
        runAt: localDateTimeToIso(els.runAt.value),
        intervalDays: Number(els.intervalDays.value || 25),
        autoDeleteOnComplete: state.autoDeleteOnComplete,
        enabled: state.enabled
      };
    }

    async function toggleTask(id, enabled) {
      try {
        const data = await api("/api/tasks/" + id + "/toggle", {
          method: "POST",
          body: JSON.stringify({ enabled })
        });
        replaceTask(data.task);
        renderAll();
      } catch (error) {
        toast(error.message);
      }
    }

    async function sendTask(id) {
      const task = state.tasks.find((item) => item.id === id);
      if (!task || !confirm("立即发送《" + task.title + "》这条短信？")) return;
      try {
        const data = await api("/api/tasks/" + id + "/send", { method: "POST", body: "{}" });
        await loadAll();
        toast(data.result.message || "已发送");
      } catch (error) {
        await loadAll();
        toast(error.message);
      }
    }

    async function deleteTask(id) {
      const task = state.tasks.find((item) => item.id === id);
      if (!task || !confirm("删除《" + task.title + "》？")) return;
      try {
        await api("/api/tasks/" + id, { method: "DELETE" });
        state.tasks = state.tasks.filter((item) => item.id !== id);
        renderAll();
        toast("任务已删除");
      } catch (error) {
        toast(error.message);
      }
    }

    async function runDue() {
      try {
        const data = await api("/api/run-due", { method: "POST", body: "{}" });
        await loadAll();
        toast("已扫描：" + data.result.due + " 个到期任务");
      } catch (error) {
        toast(error.message);
      }
    }

    function editTask(id) {
      const task = state.tasks.find((item) => item.id === id);
      if (!task) return;
      state.editingId = id;
      els.formTitle.textContent = "编辑提醒";
      els.title.value = task.title || "";
      els.message.value = task.message || "";
      els.from.value = task.from || "";
      els.runAt.value = isoToLocalDateTime(task.runAt || task.nextRunAt);
      els.intervalDays.value = task.intervalDays || 25;
      setEnabled(task.enabled !== false);
      setAutoDelete(task.autoDeleteOnComplete === true);
      document.querySelector("input[name='scheduleType'][value='" + task.scheduleType + "']").checked = true;
      updateCounters();
      updateScheduleVisibility();
      syncPeriodToggle();
      document.getElementById("formPanel").scrollIntoView({ behavior: "smooth", block: "start" });
    }

    function duplicateTask(id) {
      const task = state.tasks.find((item) => item.id === id);
      if (!task) return;
      state.editingId = "";
      els.formTitle.textContent = "复制提醒";
      els.title.value = task.title + " 副本";
      els.message.value = task.message || "";
      els.from.value = task.from || "";
      setDefaultRunAt();
      els.intervalDays.value = task.intervalDays || 25;
      setEnabled(true);
      setAutoDelete(task.autoDeleteOnComplete === true);
      document.querySelector("input[name='scheduleType'][value='" + task.scheduleType + "']").checked = true;
      updateCounters();
      updateScheduleVisibility();
      syncPeriodToggle();
    }

    function replaceTask(task) {
      const index = state.tasks.findIndex((item) => item.id === task.id);
      if (index >= 0) state.tasks.splice(index, 1, task);
      else state.tasks.push(task);
    }

    function resetForm() {
      state.editingId = "";
      els.formTitle.textContent = "新建提醒";
      els.taskForm.reset();
      document.querySelector("input[name='scheduleType'][value='interval']").checked = true;
      els.intervalDays.value = 25;
      setEnabled(true);
      setAutoDelete(false);
      setDefaultRunAt();
      updateCounters();
      updateScheduleVisibility();
      syncPeriodToggle();
    }

    function renderAll() {
      renderMeta();
      renderTasks();
      renderLogs();
      renderSettings();
      setTab(state.tab);
    }

    function renderMeta() {
      const quota = state.meta?.quota || {};
      els.quotaTop.textContent = (quota.used ?? 0) + " / " + (quota.limit ?? 72);
      els.resetTop.textContent = quota.resetAt ? formatDate(quota.resetAt) : "暂无";
      els.quotaLimit.textContent = (quota.limit ?? 72) + " 条";
      els.quotaUsed.textContent = (quota.used ?? 0) + " 条";
      els.targetNumber.textContent = state.meta?.configured?.targetNumber || "接收号码未配置";
      els.sideStatus.textContent = state.meta?.configured?.apiKey && state.meta?.configured?.targetNumber ? "正常运行" : "待配置";
      const next = state.tasks
        .filter((task) => task.enabled && task.nextRunAt)
        .sort((a, b) => new Date(a.nextRunAt) - new Date(b.nextRunAt))[0];
      els.nextTask.textContent = next ? next.title + " · " + formatDate(next.nextRunAt) : "暂无到期任务";
    }

    function renderTasks() {
      const query = els.searchInput.value.trim().toLowerCase();
      const status = els.statusFilter.value;
      const type = els.typeFilter.value;
      const tasks = state.tasks.filter((task) => {
        const text = (task.title + " " + task.message).toLowerCase();
        const matchesQuery = !query || text.includes(query);
        const matchesStatus = status === "all" || (status === "enabled" ? task.enabled !== false : task.enabled === false);
        const matchesType = type === "all" || task.scheduleType === type;
        return matchesQuery && matchesStatus && matchesType;
      });

      els.taskRows.innerHTML = tasks.map(taskRow).join("");
      els.taskEmpty.hidden = state.tasks.length > 0;
    }

    function taskRow(task) {
      const enabled = task.enabled !== false;
      const status = task.completedAt ? badge("已完成", "blue") : enabled ? badge("启用中", "green") : badge("已暂停", "gray");
      const onceNote = task.autoDeleteOnComplete ? "完成后删除" : "一次性";
      const mode = task.scheduleType === "once" ? "指定时间<br><span class='muted'>" + onceNote + "</span>" : "间隔提醒<br><span class='muted'>每 " + escapeHtml(task.intervalDays) + " 天</span>";
      return "<tr>" +
        "<td data-label='任务'><div class='task-cell'><div class='switch " + (enabled ? "on" : "") + "' role='switch' tabindex='0' aria-checked='" + enabled + "' onclick='toggleTask(\\\"" + task.id + "\\\", " + !enabled + ")'></div><div style='min-width:0;'><div class='task-title'>" + escapeHtml(task.title) + "</div><div class='task-subtitle'>" + escapeHtml(task.message) + "</div></div></div></td>" +
        "<td data-label='提醒方式'>" + mode + "</td>" +
        "<td data-label='下次提醒'>" + escapeHtml(formatDate(task.nextRunAt)) + "</td>" +
        "<td data-label='状态'>" + status + "</td>" +
        "<td data-label='操作'><div class='actions'>" +
          iconButton("editTask", task.id, "编辑", "edit") +
          iconButton("duplicateTask", task.id, "复制", "copy") +
          iconButton("sendTask", task.id, "立即发送", "send") +
          iconButton("deleteTask", task.id, "删除", "trash", "danger") +
        "</div></td>" +
      "</tr>";
    }

    function renderLogs() {
      els.logRows.innerHTML = state.logs.map((log) => {
        const kind = log.type === "sms_sent" ? badge("成功", "green")
          : log.type === "sms_failed" ? badge("失败", "amber")
          : log.type === "quota_blocked" ? badge("限额拦截", "amber")
          : badge(log.type || "记录", "gray");
        return "<div class='log-row'><div>" + escapeHtml(formatDate(log.at)) + "</div><div>" + kind + "</div><div><strong>" + escapeHtml(log.title || "-") + "</strong><div class='muted'>" + escapeHtml(log.message || "") + "</div></div></div>";
      }).join("");
      els.logEmpty.hidden = state.logs.length > 0;
    }

    function renderSettings() {
      const configured = state.meta?.configured || {};
      els.settingTarget.textContent = configured.targetNumber || "未配置";
      els.settingFrom.textContent = configured.defaultFrom || "未配置";
      els.settingApiKey.textContent = configured.apiKey ? "已配置" : "未配置";
      els.settingTimezone.textContent = state.meta?.timezone || "${escapeHtml(timezone)}";
    }

    function setTab(tab) {
      state.tab = tab;
      document.querySelectorAll(".nav button").forEach((button) => {
        button.classList.toggle("active", button.dataset.tab === tab);
      });
      els.tasksView.hidden = tab !== "tasks";
      els.logsView.hidden = tab !== "logs";
      els.settingsView.hidden = tab !== "settings";
    }

    function updateScheduleVisibility() {
      const type = document.querySelector("input[name='scheduleType']:checked").value;
      els.intervalRow.style.display = type === "interval" ? "grid" : "none";
      els.autoDeleteRow.style.display = type === "once" ? "flex" : "none";
    }

    function setEnabled(enabled) {
      state.enabled = enabled;
      els.enabledSwitch.classList.toggle("on", enabled);
      els.enabledSwitch.setAttribute("aria-checked", String(enabled));
    }

    function setAutoDelete(enabled) {
      state.autoDeleteOnComplete = enabled;
      els.autoDeleteSwitch.classList.toggle("on", enabled);
      els.autoDeleteSwitch.setAttribute("aria-checked", String(enabled));
    }

    function adjustDays(delta) {
      const next = Math.max(1, Math.min(3650, Number(els.intervalDays.value || 1) + delta));
      els.intervalDays.value = next;
    }

    function updateCounters() {
      els.titleCounter.textContent = els.title.value.length + "/80";
      els.messageCounter.textContent = els.message.value.length + "/500";
    }

    function setDefaultRunAt() {
      const date = new Date(Date.now() + 24 * 60 * 60 * 1000);
      const beijing = new Date(date.getTime() + 8 * 60 * 60 * 1000);
      beijing.setUTCHours(9, 0, 0, 0);
      els.runAt.value = isoToLocalDateTime(new Date(beijing.getTime() - 8 * 60 * 60 * 1000).toISOString());
      syncPeriodToggle();
    }

    function toggleTimePeriod() {
      let parts = parseBeijingInput(els.runAt.value);
      if (!parts) {
        setDefaultRunAt();
        parts = parseBeijingInput(els.runAt.value);
      }
      if (!parts) return;

      if (parts.hour >= 12) {
        parts.hour -= 12;
      } else {
        parts.hour += 12;
      }

      els.runAt.value = formatBeijingInput(parts);
      syncPeriodToggle();
    }

    function syncPeriodToggle() {
      const parts = parseBeijingInput(els.runAt.value);
      const isPm = parts ? parts.hour >= 12 : false;
      els.periodToggle.textContent = isPm ? "下午" : "上午";
      els.periodToggle.setAttribute("aria-label", isPm ? "切换为上午" : "切换为下午");
    }

    function localDateTimeToIso(value) {
      if (!value) return null;
      const parts = parseBeijingInput(value);
      if (!parts) return null;
      const { year, month, day, hour, minute } = parts;
      const utc = Date.UTC(year, month - 1, day, hour - 8, minute, 0, 0);
      return new Date(utc).toISOString();
    }

    function isoToLocalDateTime(value) {
      if (!value) return "";
      const date = new Date(value);
      const beijing = new Date(date.getTime() + 8 * 60 * 60 * 1000);
      const pad = (number) => String(number).padStart(2, "0");
      return beijing.getUTCFullYear() + "-" + pad(beijing.getUTCMonth() + 1) + "-" + pad(beijing.getUTCDate()) + "T" + pad(beijing.getUTCHours()) + ":" + pad(beijing.getUTCMinutes());
    }

    function parseBeijingInput(value) {
      const match = String(value || "").match(/^(\\d{4})-(\\d{2})-(\\d{2})T(\\d{2}):(\\d{2})$/);
      if (!match) return null;
      const year = Number(match[1]);
      const month = Number(match[2]);
      const day = Number(match[3]);
      const hour = Number(match[4]);
      const minute = Number(match[5]);
      if (![year, month, day, hour, minute].every(Number.isFinite)) return null;
      return { year, month, day, hour, minute };
    }

    function formatBeijingInput(parts) {
      const pad = (number) => String(number).padStart(2, "0");
      return parts.year + "-" + pad(parts.month) + "-" + pad(parts.day) + "T" + pad(parts.hour) + ":" + pad(parts.minute);
    }

    function formatDate(value) {
      if (!value) return "-";
      return new Intl.DateTimeFormat("zh-CN", {
        timeZone: state.meta?.timezone || "${escapeJs(timezone)}",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false
      }).format(new Date(value));
    }

    function badge(text, color) {
      return "<span class='badge " + color + "'>" + escapeHtml(text) + "</span>";
    }

    function iconButton(fn, id, label, icon, tone = "") {
      return "<button class='button icon-only " + tone + "' type='button' title='" + label + "' aria-label='" + label + "' onclick='" + fn + "(\\\"" + id + "\\\")'>" + iconMap[icon] + "</button>";
    }

    function showLogin() {
      els.login.classList.add("show");
      els.usernameInput.value = state.username;
      els.passwordInput.value = "";
      els.usernameInput.focus();
    }

    function hideLogin() {
      els.login.classList.remove("show");
    }

    let toastTimer;
    function toast(message) {
      els.toast.textContent = message;
      els.toast.classList.add("show");
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => els.toast.classList.remove("show"), 2600);
    }

    function escapeHtml(value) {
      return String(value ?? "").replace(/[&<>"']/g, (char) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
      })[char]);
    }

    function encodeBasicAuth(username, password) {
      const bytes = new TextEncoder().encode(username + ":" + password);
      let binary = "";
      bytes.forEach((byte) => {
        binary += String.fromCharCode(byte);
      });
      return btoa(binary);
    }

    window.toggleTask = toggleTask;
    window.editTask = editTask;
    window.duplicateTask = duplicateTask;
    window.sendTask = sendTask;
    window.deleteTask = deleteTask;
  </script>
</body>
</html>`;
}

function svgTurtle() {
  return `<svg viewBox="0 0 32 32" fill="none" aria-hidden="true">
    <path d="M9 18c0-5.1 3.9-9 9-9 4.6 0 8 3.4 8 7.5 0 4.7-4.2 8.5-9.6 8.5H9.7A5.7 5.7 0 0 1 4 19.3c0-2.1 1.5-3.9 3.5-4.3" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M25.5 16.2h2.2c1.7 0 3 1.3 3 3v.3h-4.9M8.4 24.8 5.7 28M14 25v3.2M22.3 23.6l2.4 3.2M12 13.6h10M10.5 18.4h14" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
    <circle cx="28.2" cy="14.5" r="1" fill="currentColor"/>
  </svg>`;
}

function icon(name) {
  return inlineIcon(name);
}

function inlineIcon(name) {
  const icons = {
    calendar: `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><path d="M8 2v4M16 2v4M3.5 9h17M5 5.5h14a1.5 1.5 0 0 1 1.5 1.5v14A1.5 1.5 0 0 1 19 22.5H5A1.5 1.5 0 0 1 3.5 21V7A1.5 1.5 0 0 1 5 5.5Z"/><path d="M8 13h4M8 17h8"/></svg>`,
    mail: `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><path d="M4 6.5h16v12H4z"/><path d="m4 7 8 6 8-6"/></svg>`,
    settings: `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><path d="M12 8.2a3.8 3.8 0 1 0 0 7.6 3.8 3.8 0 0 0 0-7.6Z"/><path d="m19 12.8 1.7 1.3-1.8 3.1-2-.8a7.8 7.8 0 0 1-1.7 1l-.3 2.1H11l-.3-2.1a7.8 7.8 0 0 1-1.7-1l-2 .8-1.8-3.1 1.7-1.3a7.3 7.3 0 0 1 0-2L5.2 9.7 7 6.6l2 .8a7.8 7.8 0 0 1 1.7-1L11 4.3h3.8l.3 2.1a7.8 7.8 0 0 1 1.7 1l2-.8 1.8 3.1-1.7 1.3c.1.7.1 1.3 0 1.8Z"/></svg>`,
    user: `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z"/><path d="M4 21a8 8 0 0 1 16 0"/></svg>`,
    clock: `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>`,
    shield: `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><path d="M12 3 5 6v5c0 4.4 2.8 8.2 7 10 4.2-1.8 7-5.6 7-10V6l-7-3Z"/><path d="m9 12 2 2 4-5"/></svg>`,
    send: `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><path d="M21 3 10 14"/><path d="m21 3-7 19-4-8-8-4 19-7Z"/></svg>`,
    search: `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m16.5 16.5 4 4"/></svg>`,
    refresh: `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><path d="M20 6v5h-5"/><path d="M4 18v-5h5"/><path d="M18.5 9A7 7 0 0 0 6.2 6.8L4 9m16 6-2.2 2.2A7 7 0 0 1 5.5 15"/></svg>`,
    save: `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><path d="M5 3.5h13l1.5 1.5v15.5h-15v-17Z"/><path d="M8 3.5v6h9"/><path d="M8 20.5v-6h8v6"/></svg>`,
    edit: `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><path d="M4 20h4l11-11-4-4L4 16v4Z"/><path d="m13.5 6.5 4 4"/></svg>`,
    copy: `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><path d="M8 8h11v11H8z"/><path d="M5 15H4V4h11v1"/></svg>`,
    trash: `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><path d="M5 7h14"/><path d="M9 7V5h6v2"/><path d="M7 7l1 14h8l1-14"/><path d="M10.5 11v6M14.5 11v6"/></svg>`
  };
  return icons[name] || "";
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[char]);
}

function escapeJs(value) {
  return String(value ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
