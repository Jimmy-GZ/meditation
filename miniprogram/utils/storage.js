// utils/storage.js
// 数据存储抽象层。
//
// 双源策略：本地缓存是即时权威，云端（微信云开发数据库）负责跨设备备份与持久。
// - 读：一律读本地缓存，瞬时返回；页面在 onShow 调 syncFromCloud() 拉取云端合并后刷新
// - 写：本地立即落盘（保持同步返回，页面无感），同时写入「待同步队列」异步上云；
//       失败自动留队，下次同步 / 网络恢复时重试；云端按记录 _id 幂等写入（doc.set 即 upsert），
//       重试不会造成重复打卡
// - 冥想会话（session）是瞬态状态，重启恢复要求即时可靠，保持纯本地实现，不同步云端
// - 云环境未配置（envList.js 为空）或云不可用时，自动退化为纯本地模式，功能完整
//
// 接口一览：
//   getRecords()                          → 打卡记录数组（按时间倒序）
//   addRecord({ duration, startTime, endTime, note? }) → 写入一条打卡记录（本地即时 + 排队上云）
//   updateRecordNote(id, note)            → 补写文字感想（同上）
//   getStats()                            → { totalSeconds, count, streakDays }
//   clearAll()                            → 清空全部打卡（本地即时 + 排队上云）
//   syncFromCloud(callback?)              → 推送队列 → 拉取云端 → 合并本地 → 完成后回调
//   getSession() / saveSession() / clearSession() → 冥想会话暂存（纯本地）

const { getCloudEnv } = require("./env");

const RECORDS_KEY = "meditation_records";
const SESSION_KEY = "meditation_session";
// 「待同步队列」：add 为整条记录上云（幂等 upsert），note 为补写感想，clear 为云端清空
const QUEUE_KEY = "meditation_sync_queue";
const SYNC_TIP_KEY = "meditation_sync_tipped"; // 「已与云端同步」一次性提示
// 曾成功同步标记：只有从未同步过的设备才允许「首次种子上传」，
// 否则云端被清空（他端执行了清空）时，本地旧记录会被错误地重新种回云端
const SYNCED_KEY = "meditation_cloud_synced";
const CLOUD_COLLECTION = "records";
const PAGE_SIZE = 20; // 客户端单次拉取上限取 20，保证各端一致

// 内存态：待同步队列（懒加载 + 每次变更即持久化）
let queue = null;

// ---------- 基础读写 ----------

function loadRaw() {
  try {
    return wx.getStorageSync(RECORDS_KEY) || [];
  } catch (e) {
    console.error("getStorageSync failed", e);
    return [];
  }
}

function saveRaw(list) {
  try {
    wx.setStorageSync(RECORDS_KEY, list);
  } catch (e) {
    console.error("setStorageSync failed", e);
  }
}

function loadQueue() {
  if (queue === null) {
    try {
      queue = wx.getStorageSync(QUEUE_KEY) || [];
    } catch (e) {
      queue = [];
    }
  }
  return queue;
}

function persistQueue() {
  try {
    wx.setStorageSync(QUEUE_KEY, loadQueue());
  } catch (e) {
    console.error("persist sync queue failed", e);
  }
}

// ---------- 云能力开关 ----------

function cloudDB() {
  if (!getCloudEnv() || !wx.cloud) return null;
  try {
    return wx.cloud.database();
  } catch (e) {
    console.error("cloud database unavailable", e);
    return null;
  }
}

// 云环境可用时才排队；纯本地模式下不产生队列，避免无限堆积
// 云环境可用时才排队；纯本地模式下不产生队列，避免无限堆积
function enqueueOp(op) {
  if (!cloudDB()) return;
  const q = loadQueue();
  if (op.type === "clear") {
    // 清空语义使此前的未同步操作全部失效，队列只保留本次清空（后续新操作继续追加）
    q.length = 0;
    q.push(op);
  } else {
    // 同一记录的同类操作合并为最新（note 覆盖旧文字，add 覆盖旧记录）
    const idx = q.findIndex((o) => o.type === op.type && o.id === op.id);
    if (idx >= 0) q.splice(idx, 1);
    q.push(op);
    // 防失控：队列过长时丢弃最旧记录（清空之后一般不会出现）
    if (q.length > 2000) q.splice(0, q.length - 2000);
  }
  persistQueue();
}

// 网络恢复时自动补推未同步操作（只注册一次）
let netHookBound = false;
function ensureNetHook() {
  if (netHookBound || typeof wx.onNetworkStatusChange !== "function") return;
  netHookBound = true;
  wx.onNetworkStatusChange((res) => {
    if (res.isConnected) flushQueue();
  });
}

// ---------- 云端队列冲刷 ----------

let flushing = false;
let syncPromise = null;

async function flushQueue() {
  if (flushing) return 0;
  const db = cloudDB();
  if (!db) return 0;
  const col = db.collection(CLOUD_COLLECTION);
  flushing = true;
  let flushed = 0;
  try {
    // 逐条串行上云；失败即中断，剩余留队待下次重试（保持先后顺序）
    while (loadQueue().length > 0) {
      const op = loadQueue()[0];
      const ok = await applyCloudOp(col, op);
      if (!ok) break;
      loadQueue().shift();
      persistQueue();
      flushed++;
    }
    return flushed;
  } finally {
    flushing = false;
  }
}

async function applyCloudOp(col, op) {
  try {
    if (op.type === "add") {
      const r = op.record;
      // doc.set 为幂等 upsert：重试不会重复创建
      await col.doc(op.id).set({
        data: {
          duration: r.duration,
          startTime: r.startTime,
          endTime: r.endTime,
          note: r.note || "",
        },
      });
      return true;
    }
    if (op.type === "note") {
      // updated=0 表示云端无此文（他端已清空等）→ 视为已同步，直接丢弃防死队
      await col.doc(op.id).update({ data: { note: op.note || "" } });
      return true;
    }
    if (op.type === "clear") {
      // 逐批取自己文档（权限已限定 _openid）逐个删除
      for (;;) {
        const res = await col.limit(PAGE_SIZE).get();
        const docs = (res && res.data) || [];
        if (docs.length === 0) break;
        for (const d of docs) {
          await col.doc(d._id).remove();
        }
        if (docs.length < PAGE_SIZE) break;
      }
      return true;
    }
    return true;
  } catch (e) {
    console.error("[meditation] 云操作失败，留队重试:", op.type, e.errMsg || e);
    return false;
  }
}

// ---------- 云端拉取与合并 ----------

function normalizeDoc(doc) {
  return {
    id: doc._id || doc.id,
    duration: Math.round(Number(doc.duration) || 0),
    startTime: Number(doc.startTime) || 0,
    endTime: Number(doc.endTime) || 0,
    note: typeof doc.note === "string" ? doc.note.trim() : "",
  };
}

async function pullCloudDocs(db) {
  const col = db.collection(CLOUD_COLLECTION);
  const docs = [];
  let offset = 0;
  for (;;) {
    const res = await col.limit(PAGE_SIZE).skip(offset).get();
    const page = (res && res.data) || [];
    docs.push(...page);
    if (page.length < PAGE_SIZE) break;
    offset += page.length;
    if (offset > 20000) break; // 防御：个人量级远达不到
  }
  return docs.map(normalizeDoc).filter((d) => d.id && d.endTime > 0);
}

// 首次上云：云端为空、本地有记录且队列空闲 → 全量入队（后续 flush 上传）
function seedUpload(localRaw) {
  const q = loadQueue();
  q.push(...localRaw.map((r) => ({ type: "add", id: r.id, record: r })));
  persistQueue();
}

// 合并：云端为主；本地存在「未上云操作」的记录保留本地新值；云端已删且本地无待上云操作 → 丢弃
function mergeCloud(cloudDocs, localRaw) {
  const q = loadQueue();
  const hasPendingClear = q.some((o) => o.type === "clear");
  const pendingTouch = new Set(
    q.filter((o) => o.type === "add" || o.type === "note").map((o) => o.id)
  );
  const localById = new Map(localRaw.map((r) => [r.id, r]));
  const mergedById = new Map();

  for (const doc of cloudDocs) {
    mergedById.set(doc.id, pendingTouch.has(doc.id) && localById.has(doc.id) ? localById.get(doc.id) : doc);
  }
  for (const r of localRaw) {
    if (!mergedById.has(r.id) && (hasPendingClear || pendingTouch.has(r.id))) {
      mergedById.set(r.id, r); // 本地独有且有未上云写（或清空在途）→ 保留等待上云
    }
  }
  return Array.from(mergedById.values());
}

// 曾成功同步过的设备标记：true 后不再自动种子上传（云端清空将被尊重）
function markSyncedOnce() {
  try {
    if (wx.getStorageSync(SYNCED_KEY)) return true;
    wx.setStorageSync(SYNCED_KEY, true);
  } catch (e) {
    // 标记失败无碍：最多下次同步重新上传一次种子
  }
  return true;
}

function tipOnce() {
  try {
    if (wx.getStorageSync(SYNC_TIP_KEY)) return true;
    wx.setStorageSync(SYNC_TIP_KEY, true);
    return false;
  } catch (e) {
    return true;
  }
}

/**
 * 同步入口：冲刷待上云队列 → 拉取云端全量 → 合并写回本地 → 完成后回调。
 * 页面在 onShow 调用；并发调用共享同一次同步，各自回调都会触发。
 */
function syncFromCloud(callback) {
  const db = cloudDB();
  if (!db) {
    if (typeof callback === "function") callback();
    return;
  }
  ensureNetHook();
  if (!syncPromise) {
    syncPromise = (async () => {
      try {
        const flushed = await flushQueue();
        let cloudDocs = await pullCloudDocs(db);
        const localRaw = loadRaw();
        // 首次上云：从未同步过的设备 + 云端空 + 本地有记录 + 队列空闲 → 全量上传后再拉取合并
        const neverSynced = !wx.getStorageSync(SYNCED_KEY);
        if (neverSynced && cloudDocs.length === 0 && localRaw.length > 0 && loadQueue().length === 0) {
          seedUpload(localRaw);
          await flushQueue();
          cloudDocs = await pullCloudDocs(db);
        }
        // 确有云端交互成功（推送或拉取到数据）→ 标记本设备已同步过
        if (flushed > 0 || cloudDocs.length > 0) markSyncedOnce();
        const merged = mergeCloud(cloudDocs, localRaw);
        saveRaw(merged);
        // 一次性轻提示：本地与云端确有数据且队列已清空
        if (cloudDocs.length > 0 && loadQueue().length === 0) {
          const first = tipOnce();
          if (!first) wx.showToast({ title: "已与云端同步", icon: "success" });
        }
      } catch (e) {
        console.error("[meditation] 云端同步失败（本地数据不受影响）", e);
      }
    })().finally(() => {
      syncPromise = null;
    });
  }
  if (typeof callback === "function") {
    syncPromise.then(() => callback());
  }
}

// ---------- 打卡记录（本地即时 + 排队上云） ----------

/**
 * 获取全部打卡记录（按结束时间倒序）
 * @returns {Array<{id: string, duration: number, startTime: number, endTime: number, note: string}>}
 */
function getRecords() {
  return loadRaw()
    .slice()
    .sort((a, b) => b.endTime - a.endTime);
}

/**
 * 写入一条打卡记录：本地立即落盘并返回（同步），同时排队异步上云
 * @param {{duration: number, startTime: number, endTime: number, note?: string}} record
 * @returns {object} 写入后的完整记录
 */
function addRecord(record) {
  const fullRecord = {
    id: `${record.endTime}-${Math.random().toString(36).slice(2, 8)}`,
    duration: Math.round(record.duration),
    startTime: record.startTime,
    endTime: record.endTime,
    note: typeof record.note === "string" ? record.note.trim() : "",
  };
  const list = loadRaw();
  list.push(fullRecord);
  saveRaw(list);
  enqueueOp({ type: "add", id: fullRecord.id, record: fullRecord });
  flushQueue();
  return fullRecord;
}

/**
 * 补写文字感想（冥想完成时先打卡、后补写），本地即时生效 + 排队上云
 * @returns {boolean} 是否找到并更新成功
 */
function updateRecordNote(id, note) {
  if (!id) return false;
  const list = loadRaw();
  const record = list.find((r) => r.id === id);
  if (!record) return false;
  const trimmed = typeof note === "string" ? note.trim() : "";
  record.note = trimmed;
  saveRaw(list);
  enqueueOp({ type: "note", id, note: trimmed });
  flushQueue();
  return true;
}

/**
 * 清空全部打卡数据：本地即时清空 + 排队云端清空（使此前所有未同步操作失效）
 */
function clearAll() {
  saveRaw([]);
  enqueueOp({ type: "clear" });
  flushQueue();
}

/**
 * 汇总统计：累计总时长（秒）、打卡次数、连续打卡天数（本地缓存推导，与云端无关）
 * @returns {{totalSeconds: number, count: number, streakDays: number}}
 */
function getStats() {
  const records = getRecords();
  const totalSeconds = records.reduce((sum, r) => sum + (r.duration || 0), 0);

  // 收集所有打卡日期（格式 YYYY-MM-DD，按自然日去重）
  const daySet = new Set();
  records.forEach((r) => {
    daySet.add(formatDay(new Date(r.endTime)));
  });

  // 从今天（若今天没打卡则从昨天）开始往回数连续天数
  const today = new Date();
  let cursor = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  if (!daySet.has(formatDay(cursor))) {
    cursor.setDate(cursor.getDate() - 1);
    if (!daySet.has(formatDay(cursor))) {
      return { totalSeconds, count: records.length, streakDays: 0 };
    }
  }
  let streakDays = 0;
  while (daySet.has(formatDay(cursor))) {
    streakDays++;
    cursor.setDate(cursor.getDate() - 1);
  }
  return { totalSeconds, count: records.length, streakDays };
}

// ---------- 冥想会话（纯本地瞬态，不同步云端） ----------

/**
 * 获取进行中的冥想会话，无则返回 null
 * @returns {{mode: string, plannedDuration: number, startTime: number}|null}
 */
function getSession() {
  try {
    return wx.getStorageSync(SESSION_KEY) || null;
  } catch (e) {
    return null;
  }
}

/**
 * 保存进行中的冥想会话
 */
function saveSession(session) {
  try {
    wx.setStorageSync(SESSION_KEY, session);
  } catch (e) {
    console.error("saveSession failed", e);
  }
}

/**
 * 清除冥想会话（冥想结束或放弃时调用）
 */
function clearSession() {
  try {
    wx.removeStorageSync(SESSION_KEY);
  } catch (e) {
    // ignore
  }
}

// ---------- 内部工具 ----------

function formatDay(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

module.exports = {
  getRecords,
  addRecord,
  updateRecordNote,
  getStats,
  clearAll,
  syncFromCloud,
  getSession,
  saveSession,
  clearSession,
};
