// ==UserScript==
// @name         IVE Tixcraft Bot
// @namespace    https://tixcraft.com/
// @version      0.4.0
// @description  在 Tampermonkey 中輔助處理拓元活動頁、場次頁、區域頁與訂單頁流程；可排程到秒啟動，遇到驗證碼與風控會停下等待人工操作。
// @match        https://tixcraft.com/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  "use strict";

  if (window.__TIXCRAFT_TICKET_BOT__) {
    console.log("[IVE BOT] duplicate userscript ignored");
    return;
  }
  window.__TIXCRAFT_TICKET_BOT__ = true;

  const STORAGE_KEY = "ive_ticket_bot_config_v1";
  const PANEL_ID = "itzy-ticket-bot-panel";
  const STYLE_ID = "itzy-ticket-bot-style";
  const DEFAULT_CONFIG = {
    activityUrl: "https://tixcraft.com/activity/detail/26_ive",
    targetDate: "2026/09/12",
    targetTime: "18:00",
    scheduledStartAt: "2026-04-03T10:59:58",
    ticketQty: 2,
    checkIntervalMs: 1000,
    reloadCooldownMs: 1500,
    actionCooldownMs: 600,
    autoStart: true,
    autoRefresh: true,
    autoSwitchAssignMode: true,
    priorityRules: [
      { keyword: "", price: "5800" },
      { keyword: "", price: "4800" },
      { keyword: "", price: "3800" },
      { keyword: "", price: "2800" },
      { keyword: "", price: "2300" },
      { keyword: "", price: "800" },
    ],
  };

  const state = {
    config: null,
    paused: false,
    intervalId: null,
    startTimerId: null,
    overlay: null,
    lastReloadAt: 0,
    lastActionAt: 0,
    lastLogAtByKey: new Map(),
    startedAt: Date.now(),
    lastStatus: "初始化中",
    memberState: "檢查中",
    lastActionText: "尚未操作",
    settingsOpen: false,
    danger: false,
  };

  const cleanText = (value) => (value || "").replace(/\s+/g, " ").trim();
  const normalizeComparableText = (value) =>
    cleanText(value)
      .toLowerCase()
      .replace(/nt\$/g, "")
      .replace(/[,\s　（）()【】[\]]/g, "");
  const toInt = (value, fallback) => {
    const next = Number.parseInt(String(value), 10);
    return Number.isFinite(next) && next > 0 ? next : fallback;
  };

  const normalizeDate = (value) => {
    const parts = String(value || "")
      .trim()
      .replace(/[.-]/g, "/")
      .split("/")
      .map((part) => part.trim())
      .filter(Boolean);

    if (parts.length !== 3) return "";
    const [year, month, day] = parts;
    if (!year || !month || !day) return "";
    return `${year}/${month.padStart(2, "0")}/${day.padStart(2, "0")}`;
  };

  const normalizeTime = (value) => {
    const text = String(value || "").trim();
    const match = text.match(/^(\d{1,2}):(\d{2})$/);
    if (!match) return text;
    return `${match[1].padStart(2, "0")}:${match[2]}`;
  };

  const normalizeDateTimeLocal = (value) => {
    const text = String(value || "")
      .trim()
      .replace(/\//g, "-")
      .replace(" ", "T");
    if (!text) return "";

    const match = text.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/);
    if (!match) return "";
    return `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6] || "00"}`;
  };

  const sanitizePriorityRules = (rules) => {
    if (!Array.isArray(rules)) return DEFAULT_CONFIG.priorityRules.slice();

    const sanitized = rules
      .map((rule) => ({
        keyword: cleanText(rule?.keyword),
        price: cleanText(rule?.price),
      }))
      .filter((rule) => rule.keyword || rule.price);

    return sanitized.length > 0 ? sanitized : DEFAULT_CONFIG.priorityRules.slice();
  };

  const sanitizeConfig = (raw) => ({
    activityUrl: cleanText(raw?.activityUrl || DEFAULT_CONFIG.activityUrl),
    targetDate: normalizeDate(raw?.targetDate || DEFAULT_CONFIG.targetDate),
    targetTime: normalizeTime(raw?.targetTime || DEFAULT_CONFIG.targetTime),
    scheduledStartAt: normalizeDateTimeLocal(raw?.scheduledStartAt || DEFAULT_CONFIG.scheduledStartAt),
    ticketQty: toInt(raw?.ticketQty, DEFAULT_CONFIG.ticketQty),
    checkIntervalMs: Math.max(150, toInt(raw?.checkIntervalMs, DEFAULT_CONFIG.checkIntervalMs)),
    reloadCooldownMs: Math.max(500, toInt(raw?.reloadCooldownMs, DEFAULT_CONFIG.reloadCooldownMs)),
    actionCooldownMs: Math.max(150, toInt(raw?.actionCooldownMs, DEFAULT_CONFIG.actionCooldownMs)),
    autoStart: raw?.autoStart !== false,
    autoRefresh: raw?.autoRefresh !== false,
    autoSwitchAssignMode: raw?.autoSwitchAssignMode !== false,
    priorityRules: sanitizePriorityRules(raw?.priorityRules),
  });

  const loadConfig = () => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return sanitizeConfig(DEFAULT_CONFIG);
      return sanitizeConfig(JSON.parse(raw));
    } catch (error) {
      console.warn("[IVE BOT] failed to load config", error);
      return sanitizeConfig(DEFAULT_CONFIG);
    }
  };

  const saveConfig = (config) => {
    const sanitized = sanitizeConfig(config);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(sanitized));
    state.config = sanitized;
    return sanitized;
  };

  const xFirst = (xpath, root = document) =>
    document.evaluate(
      xpath,
      root,
      null,
      XPathResult.FIRST_ORDERED_NODE_TYPE,
      null,
    ).singleNodeValue;

  const canAct = () => Date.now() - state.lastActionAt >= state.config.actionCooldownMs;
  const canReload = () => Date.now() - state.lastReloadAt >= state.config.reloadCooldownMs;

  const markAction = (message) => {
    state.lastActionAt = Date.now();
    if (message) state.lastActionText = message;
  };

  const markReload = (message) => {
    state.lastReloadAt = Date.now();
    if (message) state.lastActionText = message;
  };

  const formatRules = (rules) =>
    rules
      .map((rule) => `${rule.keyword || "*"} | ${rule.price || "*"}`)
      .join("\n");

  const parseRulesText = (text) => {
    const rules = String(text || "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [keyword = "", price = ""] = line.split("|");
        return {
          keyword: cleanText(keyword),
          price: cleanText(price),
        };
      })
      .filter((rule) => rule.keyword || rule.price);

    return sanitizePriorityRules(rules);
  };

  const formatElapsed = () => {
    const seconds = Math.floor((Date.now() - state.startedAt) / 1000);
    const hh = String(Math.floor(seconds / 3600)).padStart(2, "0");
    const mm = String(Math.floor((seconds % 3600) / 60)).padStart(2, "0");
    const ss = String(seconds % 60).padStart(2, "0");
    return `${hh}:${mm}:${ss}`;
  };

  const formatCountdown = (diffMs) => {
    const totalSeconds = Math.max(0, Math.ceil(diffMs / 1000));
    const hh = String(Math.floor(totalSeconds / 3600)).padStart(2, "0");
    const mm = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, "0");
    const ss = String(totalSeconds % 60).padStart(2, "0");
    return `${hh}:${mm}:${ss}`;
  };

  const formatScheduledStart = (value) => {
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return value || "未設定";
    const year = parsed.getFullYear();
    const month = String(parsed.getMonth() + 1).padStart(2, "0");
    const day = String(parsed.getDate()).padStart(2, "0");
    const hour = String(parsed.getHours()).padStart(2, "0");
    const minute = String(parsed.getMinutes()).padStart(2, "0");
    const second = String(parsed.getSeconds()).padStart(2, "0");
    return `${year}/${month}/${day} ${hour}:${minute}:${second}`;
  };

  const getScheduleState = () => {
    const value = state.config?.scheduledStartAt || "";
    if (!value) {
      return { enabled: false, reached: true, diffMs: 0, value: "" };
    }

    const startAt = new Date(value);
    if (Number.isNaN(startAt.getTime())) {
      return { enabled: false, reached: true, diffMs: 0, value: "" };
    }

    const diffMs = startAt.getTime() - Date.now();
    return {
      enabled: true,
      reached: diffMs <= 0,
      diffMs,
      value,
    };
  };

  const ensureStyles = () => {
    if (document.getElementById(STYLE_ID)) return;

    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      #${PANEL_ID} {
        position: fixed;
        top: 12px;
        right: 12px;
        z-index: 2147483647;
        width: 320px;
        max-width: calc(100vw - 24px);
        background: rgba(15, 23, 42, 0.96);
        color: #f8fafc;
        border: 1px solid rgba(148, 163, 184, 0.35);
        border-radius: 14px;
        box-shadow: 0 12px 30px rgba(0, 0, 0, 0.35);
        font: 12px/1.45 Consolas, "Courier New", monospace;
        overflow: hidden;
        backdrop-filter: blur(10px);
      }
      #${PANEL_ID}[data-danger="true"] {
        border-color: rgba(248, 113, 113, 0.75);
        box-shadow: 0 12px 34px rgba(127, 29, 29, 0.4);
      }
      #${PANEL_ID} * {
        box-sizing: border-box;
      }
      #${PANEL_ID} button,
      #${PANEL_ID} input,
      #${PANEL_ID} textarea {
        font: inherit;
      }
      #${PANEL_ID} button {
        border: 1px solid rgba(148, 163, 184, 0.35);
        background: rgba(30, 41, 59, 0.95);
        color: #f8fafc;
        border-radius: 8px;
        padding: 6px 8px;
        cursor: pointer;
      }
      #${PANEL_ID} button:hover {
        background: rgba(51, 65, 85, 0.98);
      }
      #${PANEL_ID} input,
      #${PANEL_ID} textarea {
        width: 100%;
        border: 1px solid rgba(148, 163, 184, 0.35);
        background: rgba(2, 6, 23, 0.85);
        color: #f8fafc;
        border-radius: 8px;
        padding: 6px 8px;
      }
      #${PANEL_ID} textarea {
        min-height: 112px;
        resize: vertical;
      }
      #${PANEL_ID} .itzy-bot-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        padding: 10px 12px 0;
      }
      #${PANEL_ID} .itzy-bot-title {
        font-weight: 700;
        letter-spacing: 0.04em;
      }
      #${PANEL_ID} .itzy-bot-badge {
        padding: 2px 8px;
        border-radius: 999px;
        background: rgba(34, 197, 94, 0.18);
        color: #bbf7d0;
      }
      #${PANEL_ID}[data-paused="true"] .itzy-bot-badge {
        background: rgba(250, 204, 21, 0.18);
        color: #fde68a;
      }
      #${PANEL_ID}[data-danger="true"] .itzy-bot-badge {
        background: rgba(239, 68, 68, 0.18);
        color: #fecaca;
      }
      #${PANEL_ID} .itzy-bot-body {
        padding: 10px 12px 12px;
      }
      #${PANEL_ID} .itzy-bot-status {
        white-space: pre-wrap;
        word-break: break-word;
        padding: 8px 10px;
        border-radius: 10px;
        background: rgba(2, 6, 23, 0.55);
        margin-bottom: 10px;
      }
      #${PANEL_ID} .itzy-bot-grid {
        display: grid;
        grid-template-columns: 66px 1fr;
        gap: 4px 10px;
        margin-bottom: 10px;
      }
      #${PANEL_ID} .itzy-bot-label {
        color: #94a3b8;
      }
      #${PANEL_ID} .itzy-bot-actions {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 8px;
        margin-bottom: 10px;
      }
      #${PANEL_ID} .itzy-bot-settings {
        display: none;
        gap: 8px;
        padding-top: 8px;
        border-top: 1px solid rgba(148, 163, 184, 0.2);
      }
      #${PANEL_ID}[data-settings-open="true"] .itzy-bot-settings {
        display: grid;
      }
      #${PANEL_ID} .itzy-bot-row {
        display: grid;
        gap: 4px;
      }
      #${PANEL_ID} .itzy-bot-hint {
        color: #94a3b8;
        white-space: pre-wrap;
      }
    `;
    document.head.appendChild(style);
  };

  const ensureOverlay = () => {
    if (state.overlay?.root?.isConnected) return state.overlay;

    ensureStyles();

    const root = document.createElement("section");
    root.id = PANEL_ID;
    root.innerHTML = `
      <div class="itzy-bot-head">
        <div class="itzy-bot-title">IVE BOT</div>
        <div class="itzy-bot-badge" data-role="badge">RUNNING</div>
      </div>
      <div class="itzy-bot-body">
        <div class="itzy-bot-status" data-role="status">初始化中</div>
        <div class="itzy-bot-grid">
          <div class="itzy-bot-label">會員</div><div data-role="member">檢查中</div>
          <div class="itzy-bot-label">路徑</div><div data-role="path">${location.pathname}</div>
          <div class="itzy-bot-label">執行</div><div data-role="uptime">00:00:00</div>
          <div class="itzy-bot-label">上次動作</div><div data-role="last-action">尚未操作</div>
        </div>
        <div class="itzy-bot-actions">
          <button type="button" data-role="toggle">暫停</button>
          <button type="button" data-role="tick">立即檢查</button>
          <button type="button" data-role="settings">設定</button>
        </div>
        <div class="itzy-bot-settings">
          <label class="itzy-bot-row">
            <span>活動網址</span>
            <input type="text" data-role="activity-url" />
          </label>
          <label class="itzy-bot-row">
            <span>目標日期</span>
            <input type="text" data-role="target-date" placeholder="YYYY/MM/DD" />
          </label>
          <label class="itzy-bot-row">
            <span>目標時間</span>
            <input type="text" data-role="target-time" placeholder="HH:mm" />
          </label>
          <label class="itzy-bot-row">
            <span>開始時間</span>
            <input type="datetime-local" step="1" data-role="scheduled-start-at" />
          </label>
          <label class="itzy-bot-row">
            <span>票數</span>
            <input type="number" min="1" max="8" data-role="ticket-qty" />
          </label>
          <label class="itzy-bot-row">
            <span>檢查間隔 (ms)</span>
            <input type="number" min="150" step="50" data-role="check-interval" />
          </label>
          <label class="itzy-bot-row">
            <span>區域優先清單</span>
            <textarea data-role="priority-rules"></textarea>
          </label>
          <div class="itzy-bot-hint">每行一筆，格式為「關鍵字|價格」。留空的一側可省略，例如：
|5800
|4800
看台A區|2800</div>
          <div class="itzy-bot-actions">
            <button type="button" data-role="save">儲存設定</button>
            <button type="button" data-role="reset">恢復預設</button>
            <button type="button" data-role="close">收合</button>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(root);

    const refs = {
      root,
      badge: root.querySelector('[data-role="badge"]'),
      status: root.querySelector('[data-role="status"]'),
      member: root.querySelector('[data-role="member"]'),
      path: root.querySelector('[data-role="path"]'),
      uptime: root.querySelector('[data-role="uptime"]'),
      lastAction: root.querySelector('[data-role="last-action"]'),
      toggleButton: root.querySelector('[data-role="toggle"]'),
      tickButton: root.querySelector('[data-role="tick"]'),
      settingsButton: root.querySelector('[data-role="settings"]'),
      activityUrlInput: root.querySelector('[data-role="activity-url"]'),
      targetDateInput: root.querySelector('[data-role="target-date"]'),
      targetTimeInput: root.querySelector('[data-role="target-time"]'),
      scheduledStartAtInput: root.querySelector('[data-role="scheduled-start-at"]'),
      ticketQtyInput: root.querySelector('[data-role="ticket-qty"]'),
      checkIntervalInput: root.querySelector('[data-role="check-interval"]'),
      priorityRulesInput: root.querySelector('[data-role="priority-rules"]'),
      saveButton: root.querySelector('[data-role="save"]'),
      resetButton: root.querySelector('[data-role="reset"]'),
      closeButton: root.querySelector('[data-role="close"]'),
    };

    refs.toggleButton.addEventListener("click", () => togglePause());
    refs.tickButton.addEventListener("click", () => tick({ manual: true }));
    refs.settingsButton.addEventListener("click", () => toggleSettings());
    refs.saveButton.addEventListener("click", () => handleSaveFromForm());
    refs.resetButton.addEventListener("click", () => handleResetConfig());
    refs.closeButton.addEventListener("click", () => toggleSettings(false));

    state.overlay = refs;
    syncFormFromConfig();
    updateOverlay();
    return refs;
  };

  const syncFormFromConfig = () => {
    const overlay = ensureOverlay();
    const { config } = state;
    overlay.activityUrlInput.value = config.activityUrl;
    overlay.targetDateInput.value = config.targetDate;
    overlay.targetTimeInput.value = config.targetTime;
    overlay.scheduledStartAtInput.value = config.scheduledStartAt;
    overlay.ticketQtyInput.value = String(config.ticketQty);
    overlay.checkIntervalInput.value = String(config.checkIntervalMs);
    overlay.priorityRulesInput.value = formatRules(config.priorityRules);
  };

  const setStatus = (message, danger = false) => {
    state.lastStatus = message;
    state.danger = danger;
    updateOverlay();
  };

  const updateOverlay = () => {
    const overlay = ensureOverlay();
    overlay.root.dataset.paused = String(state.paused);
    overlay.root.dataset.settingsOpen = String(state.settingsOpen);
    overlay.root.dataset.danger = String(state.danger);

    overlay.badge.textContent = state.danger ? "STOP" : state.paused ? "PAUSED" : "RUNNING";
    overlay.status.textContent = state.lastStatus;
    overlay.member.textContent = state.memberState;
    overlay.path.textContent = location.pathname;
    overlay.uptime.textContent = formatElapsed();
    overlay.lastAction.textContent = state.lastActionText;
    overlay.toggleButton.textContent = state.paused ? "繼續" : "暫停";
  };

  const log = (key, message, cooldownMs = 3000, danger = false) => {
    const now = Date.now();
    const last = state.lastLogAtByKey.get(key) || 0;
    if (now - last < cooldownMs) return;
    state.lastLogAtByKey.set(key, now);
    setStatus(message, danger);
    console.log(`[IVE BOT ${new Date().toLocaleTimeString()}] ${message}`);
  };

  const toggleSettings = (open = !state.settingsOpen) => {
    state.settingsOpen = open;
    if (open) syncFormFromConfig();
    updateOverlay();
  };

  const togglePause = (nextValue = !state.paused) => {
    state.paused = nextValue;
    state.lastActionText = state.paused ? "已由使用者手動暫停" : "已由使用者恢復執行";
    setStatus(state.paused ? "腳本已暫停" : "腳本已恢復執行");
  };

  const handleSaveFromForm = () => {
    const overlay = ensureOverlay();
    const nextConfig = {
      ...state.config,
      activityUrl: overlay.activityUrlInput.value,
      targetDate: overlay.targetDateInput.value,
      targetTime: overlay.targetTimeInput.value,
      scheduledStartAt: overlay.scheduledStartAtInput.value,
      ticketQty: overlay.ticketQtyInput.value,
      checkIntervalMs: overlay.checkIntervalInput.value,
      priorityRules: parseRulesText(overlay.priorityRulesInput.value),
    };

    saveConfig(nextConfig);
    restartLoop();
    syncFormFromConfig();
    state.lastActionText = "設定已儲存";
    setStatus("設定已儲存並重新套用");
  };

  const handleResetConfig = () => {
    state.config = saveConfig(DEFAULT_CONFIG);
    state.paused = !state.config.autoStart;
    restartLoop();
    syncFormFromConfig();
    state.lastActionText = "已恢復預設設定";
    setStatus("已恢復預設設定");
  };

  const isVisible = (element) => {
    if (!element) return false;
    const style = window.getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden" && style.pointerEvents !== "none";
  };

  const isDisabled = (element) => {
    if (!element) return true;
    const ariaDisabled = element.getAttribute("aria-disabled");
    const className = `${element.className || ""} ${element.parentElement?.className || ""}`;
    const text = cleanText(element.innerText || element.textContent);
    return (
      element.disabled ||
      ariaDisabled === "true" ||
      /disabled|off|inactive/i.test(className) ||
      /暫無票|售完|Sold out|Unavailable|已售完|整理中/i.test(text)
    );
  };

  const clickElement = (element, reason) => {
    if (!element || !canAct() || !isVisible(element) || isDisabled(element)) return false;
    markAction(reason || "點擊元素");
    element.click();
    return true;
  };

  const navigateTo = (url, reason) => {
    if (!url || !canAct()) return false;
    const targetUrl = new URL(url, location.href).toString();
    markAction(reason || `導向 ${targetUrl}`);
    log("navigate", reason || `導向 ${targetUrl}`, 1200);
    location.assign(targetUrl);
    return true;
  };

  const reloadPage = (reason) => {
    if (!state.config.autoRefresh || !canReload()) return false;
    markReload(`${reason}，重新整理`);
    log("reload", `${reason}，重新整理`, 1200);
    location.reload();
    return true;
  };

  const isLoginPage = () => {
    const url = location.href.toLowerCase();
    const bodyText = cleanText(document.body?.innerText);
    if (/login|signin|member/.test(url)) return true;
    return /會員登入|login|sign in/i.test(bodyText) && Boolean(document.querySelector("input[type='password']"));
  };

  const detectMemberState = () => {
    const loginEntry = xFirst(
      "//header//*[contains(normalize-space(.), '會員登入')] | //a[contains(normalize-space(.), '會員登入')] | //button[contains(normalize-space(.), '會員登入')]",
    );
    if (loginEntry) return "未登入";

    const memberEntry = xFirst(
      "//header//*[contains(normalize-space(.), '會員中心') or contains(normalize-space(.), '我的帳戶') or contains(normalize-space(.), '登出')] | //a[contains(normalize-space(.), '會員中心') or contains(normalize-space(.), '我的帳戶') or contains(normalize-space(.), '登出')]",
    );
    if (memberEntry) return "已登入";

    return "未知";
  };

  const isPausedByRiskControl = () => {
    const bodyText = cleanText(document.body?.innerText);
    return /您的瀏覽活動已暫停|我們偵測到您的網路或瀏覽器有異常行為/.test(bodyText);
  };

  const onActivityPage = () => /\/activity\/detail\//.test(location.pathname);
  const onSessionPage = () => /\/(ticket|activity)\/game\//.test(location.pathname);
  const onAreaPage = () => /\/ticket\/area\//.test(location.pathname);
  const onOrderPage = () =>
    /\/ticket\/ticket\//.test(location.pathname) ||
    Boolean(document.querySelector("select")) ||
    Boolean(document.querySelector("#TicketForm_agree"));

  const isConfiguredActivityPage = () => {
    if (!state.config.activityUrl) return true;
    if (!onActivityPage()) return true;
    const expected = state.config.activityUrl.trim();
    return location.href.startsWith(expected);
  };

  const tryBuyNow = () => {
    const buyNow = xFirst(
      "//li[contains(@class, 'buy')]//a | //a[.//div[contains(normalize-space(.), '立即購票')]] | //button[contains(normalize-space(.), '立即購票')]",
    );
    if (!buyNow) return false;
    if (clickElement(buyNow, "點擊立即購票")) {
      log("buy-now", "點擊立即購票");
      return true;
    }
    return false;
  };

  const hasSessionRows = () => Array.from(document.querySelectorAll("tr.gridc, tr.fcTxt")).length > 0;

  const rowMatchesTarget = (row) => {
    const text = cleanText(row?.innerText);
    if (!text) return false;

    const rawDate = state.config.targetDate;
    const normalizedDate = normalizeDate(rawDate);
    const looseDate = normalizedDate.replace(/\/0(\d)\//g, "/$1/").replace(/\/0(\d)$/, "/$1");
    const targetTime = state.config.targetTime;

    const matchesDate = [rawDate, normalizedDate, looseDate].filter(Boolean).some((date) => text.includes(date));
    const matchesTime = !targetTime || text.includes(targetTime);
    return matchesDate && matchesTime;
  };

  const findTargetSessionRow = () => Array.from(document.querySelectorAll("tr")).find((row) => rowMatchesTarget(row)) || null;

  const trySessionBuy = () => {
    const row = findTargetSessionRow();
    if (!row) return false;

    const buyButton = xFirst(
      ".//button[contains(normalize-space(.), '立即訂購') or @data-href] | .//a[contains(normalize-space(.), '立即訂購') or @href]",
      row,
    );
    if (!buyButton || isDisabled(buyButton)) return false;

    const buttonText = cleanText(buyButton.innerText);
    if (buttonText && !buttonText.includes("立即訂購") && !buyButton.getAttribute("data-href")) return false;

    const href = buyButton.getAttribute("data-href") || buyButton.getAttribute("href");
    if (href) {
      return navigateTo(href, `導向場次 ${state.config.targetDate} ${state.config.targetTime} 的訂購頁`);
    }

    if (clickElement(buyButton, `點擊場次 ${state.config.targetDate} ${state.config.targetTime}`)) {
      log("session-buy", `點擊場次 ${state.config.targetDate} ${state.config.targetTime} 的立即訂購`);
      return true;
    }
    return false;
  };

  const areaCandidates = () =>
    Array.from(document.querySelectorAll("a, button")).filter((element) => {
      const text = cleanText(element.innerText || element.textContent);
      if (!text) return false;
      if (!isVisible(element) || isDisabled(element)) return false;
      return /區|票|身障|輪椅|\d{3,4}/.test(text);
    });

  const getAreaCandidateSearchText = (element) => {
    const parts = [];
    let current = element;

    for (let depth = 0; current && depth < 4; depth += 1) {
      const ownText = cleanText(current.innerText || current.textContent);
      if (ownText) parts.push(ownText);

      const previous = current.previousElementSibling;
      if (previous) {
        const previousText = cleanText(previous.innerText || previous.textContent);
        if (previousText) parts.push(previousText);
      }

      current = current.parentElement;
    }

    return normalizeComparableText(parts.join(" "));
  };

  const areaRuleMatches = (element, rule) => {
    const searchText = getAreaCandidateSearchText(element);
    const keywordVariants = String(rule.keyword || "")
      .split(",")
      .map((part) => normalizeComparableText(part))
      .filter(Boolean);
    const price = normalizeComparableText(rule.price);

    if (keywordVariants.length > 0 && !keywordVariants.some((keyword) => searchText.includes(keyword))) return false;
    if (price && !searchText.includes(price)) return false;
    return true;
  };

  const ensureAutoAssign = () => {
    if (!state.config.autoSwitchAssignMode) return false;

    const tab = xFirst(
      "//a[contains(normalize-space(.), '電腦配位')] | //button[contains(normalize-space(.), '電腦配位')] | //li[contains(normalize-space(.), '電腦配位')]",
    );
    if (!tab) return false;

    const parentClass = tab.parentElement?.className || "";
    const ownClass = tab.className || "";
    if (/active/i.test(parentClass) || /active/i.test(ownClass)) return false;

    if (clickElement(tab, "切換到電腦配位")) {
      log("auto-assign", "切換到電腦配位");
      return true;
    }
    return false;
  };

  const pickArea = () => {
    const candidates = areaCandidates();

    for (const rule of state.config.priorityRules) {
      for (const element of candidates) {
        const text = cleanText(element.innerText || element.textContent);
        if (!text) continue;
        if (!areaRuleMatches(element, rule)) continue;

        if (clickElement(element, `點擊區域 ${text}`)) {
          log("pick-area", `點擊區域: ${text}`);
          return true;
        }
      }
    }

    return false;
  };

  const findTicketQtyOption = (select) => {
    const options = Array.from(select?.options || []);
    if (options.length <= 1) return null;

    const exactMatch = options.find((option) => {
      const text = cleanText(option.textContent);
      return option.value === String(state.config.ticketQty) || new RegExp(`(^|\\D)${state.config.ticketQty}(\\D|$)`).test(text);
    });

    return exactMatch || options[Math.min(state.config.ticketQty, options.length - 1)] || null;
  };

  const selectTicketQty = () => {
    const select = document.querySelector("select");
    if (!select || select.disabled) return false;

    const option = findTicketQtyOption(select);
    if (!option) return false;
    if (select.value === option.value && select.selectedIndex === option.index) return false;

    select.value = option.value;
    select.selectedIndex = option.index;
    select.dispatchEvent(new Event("change", { bubbles: true }));
    state.lastActionText = `已選擇張數: ${cleanText(option.textContent)}`;
    log("qty", `已選擇張數: ${cleanText(option.textContent)}`);
    return true;
  };

  const checkAgreement = () => {
    const checkbox = document.querySelector("#TicketForm_agree");
    if (!checkbox || checkbox.checked || checkbox.disabled) return false;
    checkbox.click();
    state.lastActionText = "已勾選購票同意條款";
    log("agree", "已勾選購票同意條款");
    return true;
  };

  const hasCaptcha = () =>
    Boolean(
      document.querySelector("#TicketForm_verifyCode") ||
      document.querySelector("input[name*='captcha']") ||
      document.querySelector("input[placeholder*='驗證碼']") ||
      document.querySelector("input[placeholder*='captcha']")
    );

  const tick = ({ manual = false, ignoreSchedule = false } = {}) => {
    if (!document.body) return;
    ensureOverlay();
    state.memberState = detectMemberState();
    const scheduleState = getScheduleState();

    if (state.paused && !manual) {
      setStatus("腳本已暫停");
      return;
    }

    if (scheduleState.enabled && !scheduleState.reached && !manual && !ignoreSchedule) {
      setStatus(
        `等待開始時間 ${formatScheduledStart(scheduleState.value)}\n倒數 ${formatCountdown(scheduleState.diffMs)}`,
      );
      return;
    }

    if (onActivityPage() && !isConfiguredActivityPage()) {
      setStatus("目前不是設定中的活動頁，暫不自動操作");
      return;
    }

    if (isLoginPage()) {
      state.memberState = "未登入";
      setStatus("等待手動登入");
      log("login", "目前在會員登入頁，請手動登入，登入完成後腳本會自動續跑");
      return;
    }

    if (state.memberState === "未登入") {
      setStatus("尚未登入會員，已暫停自動操作");
      log("member-login", "偵測到頁面仍顯示會員登入，請先完成會員登入後再繼續", 1500);
      return;
    }

    if (isPausedByRiskControl()) {
      setStatus("偵測到風控暫停，已停止自動操作", true);
      log("risk-control", "偵測到『您的瀏覽活動已暫停』，腳本已停止自動點擊與重整", 1500, true);
      state.paused = true;
      return;
    }

    if (hasCaptcha()) {
      setStatus("已到驗證碼頁，等待手動輸入", true);
      selectTicketQty();
      checkAgreement();
      log("captcha", "已到驗證碼頁，請立刻手動輸入驗證碼", 1500, true);
      return;
    }

    if (findTargetSessionRow() || ((onActivityPage() || onSessionPage()) && hasSessionRows())) {
      setStatus("場次表檢查中");
      if (trySessionBuy()) return;

      const row = findTargetSessionRow();
      if (!row) {
        reloadPage(`尚未看到場次 ${state.config.targetDate} ${state.config.targetTime}`);
        return;
      }

      reloadPage("目標場次已出現，但立即訂購尚未可按");
      return;
    }

    if (onActivityPage()) {
      setStatus("活動頁檢查中");
      if (tryBuyNow()) return;
      reloadPage("活動頁尚未找到立即購票");
      return;
    }

    if (onSessionPage()) {
      setStatus("場次頁檢查中");
      if (trySessionBuy()) return;

      const row = findTargetSessionRow();
      if (!row) {
        reloadPage(`尚未看到場次 ${state.config.targetDate} ${state.config.targetTime}`);
        return;
      }

      reloadPage("目標場次已出現，但立即訂購尚未可按");
      return;
    }

    if (onAreaPage()) {
      setStatus("區域頁檢查中");
      if (ensureAutoAssign()) return;
      if (pickArea()) return;
      reloadPage("區域頁目前沒有符合優先清單的票");
      return;
    }

    if (onOrderPage()) {
      setStatus("訂單頁檢查中");
      const changedQty = selectTicketQty();
      const changedAgree = checkAgreement();
      if (changedQty || changedAgree) return;
      log("order", "已進入訂單頁，等待驗證碼或後續操作");
      return;
    }

    setStatus("腳本已載入，等待進入活動流程頁");
  };

  const restartLoop = () => {
    if (state.intervalId) clearInterval(state.intervalId);
    if (state.startTimerId) clearTimeout(state.startTimerId);

    const scheduleState = getScheduleState();
    if (scheduleState.enabled && !scheduleState.reached) {
      state.startTimerId = window.setTimeout(() => {
        state.startTimerId = null;
        state.lastActionText = `到達開始時間 ${formatScheduledStart(scheduleState.value)}`;
        try {
          tick({ ignoreSchedule: true });
        } catch (error) {
          console.error("[IVE BOT] scheduled start failed", error);
          state.lastActionText = `錯誤: ${error.message || error}`;
          setStatus("到點啟動時發生錯誤，請開 Console 檢查");
        }
      }, Math.max(0, scheduleState.diffMs));
    }

    state.intervalId = window.setInterval(() => {
      try {
        tick();
      } catch (error) {
        console.error("[IVE BOT] tick failed", error);
        state.lastActionText = `錯誤: ${error.message || error}`;
        setStatus("執行時發生錯誤，請開 Console 檢查");
      }
    }, state.config.checkIntervalMs);
  };

  const bindKeyboardShortcuts = () => {
    window.addEventListener("keydown", (event) => {
      if (!event.altKey) return;
      if (event.key.toLowerCase() === "b") {
        event.preventDefault();
        togglePause();
      }
      if (event.key.toLowerCase() === "s") {
        event.preventDefault();
        toggleSettings();
      }
    });
  };

  const boot = () => {
    if (!document.body) {
      setTimeout(boot, 100);
      return;
    }

    state.config = loadConfig();
    state.paused = !state.config.autoStart;
    ensureOverlay();
    bindKeyboardShortcuts();
    setStatus(state.paused ? "腳本已載入，目前為暫停狀態" : "腳本已載入");
    tick();
    restartLoop();
    window.setInterval(updateOverlay, 1000);
    console.log("[IVE BOT] userscript loaded");
  };

  boot();
})();
