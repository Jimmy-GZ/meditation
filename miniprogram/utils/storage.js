// utils/storage.js
// 数据存储抽象层。
// 当前实现为本地缓存（wx.setStorageSync / wx.getStorageSync）。
// 将来迁移云数据库时，只需保持以下函数签名不变，把内部实现替换为
// wx.cloud.callFunction / 云数据库调用，页面代码无需任何改动。
//
// 接口一览：
//   getRecords()                              → 打卡记录数组（按时间倒序）
//   addRecord({ duration, startTime, endTime }) → 写入一条打卡记录
//   getStats()                                → { totalSeconds, count, streakDays }
//   clearAll()                                → 清空所有打卡数据
//   getSession() / saveSession() / clearSession() → 冥想会话的暂存与恢复

const RECORDS_KEY = "meditation_records";
const SESSION_KEY = "meditation_session";

// ---------- 打卡记录 ----------

/**
 * 获取全部打卡记录（按结束时间倒序）
 * @returns {Array<{id: string, duration: number, startTime: number, endTime: number}>}
 */
function getRecords() {
  let records = [];
  try {
    records = wx.getStorageSync(RECORDS_KEY) || [];
  } catch (e) {
    console.error("getStorageSync failed", e);
    records = [];
  }
  return records
    .slice()
    .sort((a, b) => b.endTime - a.endTime);
}

/**
 * 写入一条打卡记录
 * @param {{duration: number, startTime: number, endTime: number}} record
 *   duration 单位为秒，startTime/endTime 为毫秒时间戳
 * @returns {object} 写入后的完整记录
 */
function addRecord(record) {
  const fullRecord = {
    id: `${record.endTime}-${Math.random().toString(36).slice(2, 8)}`,
    duration: Math.round(record.duration),
    startTime: record.startTime,
    endTime: record.endTime,
  };
  const records = getRecords();
  records.unshift(fullRecord);
  try {
    wx.setStorageSync(RECORDS_KEY, records);
  } catch (e) {
    console.error("setStorageSync failed", e);
  }
  return fullRecord;
}

/**
 * 汇总统计：累计总时长（秒）、打卡次数、连续打卡天数
 * 连续天数按打卡结束时间所在自然日去重后，从今天（或昨天）往回连续计算
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

/**
 * 清空全部打卡数据
 */
function clearAll() {
  try {
    wx.removeStorageSync(RECORDS_KEY);
  } catch (e) {
    console.error("removeStorageSync failed", e);
  }
}

// ---------- 冥想会话（用于退出后恢复） ----------

/**
 * 获取进行中的冥想会话，无则返回 null
 * @returns {{mode: string, plannedDuration: number, startTime: number}|null}
 *   mode: "countdown" | "free"；plannedDuration 为倒计时模式的计划秒数（自由模式为 0）
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
  getStats,
  clearAll,
  getSession,
  saveSession,
  clearSession,
};
