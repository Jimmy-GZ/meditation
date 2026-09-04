// utils/levels.js
// 冥想等级体系：按累计冥想时长（秒）划分等级

const HOUR = 3600; // 一小时的秒数

// 等级定义：threshold 为达到该等级所需的累计冥想秒数
const LEVELS = [
  { level: 1, name: "初心", threshold: 0 },
  { level: 2, name: "静心", threshold: 50 * HOUR },
  { level: 3, name: "安心", threshold: 200 * HOUR },
  { level: 4, name: "定心", threshold: 500 * HOUR },
  { level: 5, name: "观心", threshold: 1200 * HOUR },
  { level: 6, name: "明心", threshold: 2500 * HOUR },
  { level: 7, name: "慧心", threshold: 5000 * HOUR },
  { level: 8, name: "圆满", threshold: 10000 * HOUR },
];

/**
 * 根据累计冥想秒数计算等级信息
 * @param {number} totalSeconds 累计冥想总秒数
 * @returns {{current: object, next: object|null, progressPercent: number}}
 *   current: 当前等级；next: 下一等级（最高级时为 null）；progressPercent: 距下一级进度百分比
 */
function getLevelInfo(totalSeconds) {
  let current = LEVELS[0];
  let next = LEVELS.length > 1 ? LEVELS[1] : null;
  for (let i = 0; i < LEVELS.length; i++) {
    if (totalSeconds >= LEVELS[i].threshold) {
      current = LEVELS[i];
      next = i + 1 < LEVELS.length ? LEVELS[i + 1] : null;
    }
  }
  let progressPercent = 100;
  if (next) {
    const span = next.threshold - current.threshold;
    const passed = totalSeconds - current.threshold;
    progressPercent = Math.min(100, Math.floor((passed / span) * 100));
  }
  return { current, next, progressPercent };
}

/**
 * 将秒数格式化为人类可读时长
 * @param {number} seconds 秒数
 * @returns {string} 如 "45分钟" / "3小时20分钟" / "1万小时" 级别的大数会带千分位
 */
function formatDuration(seconds) {
  const totalMinutes = Math.floor(seconds / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) {
    return `${minutes}分钟`;
  }
  if (minutes === 0) {
    return `${hours}小时`;
  }
  return `${hours}小时${minutes}分钟`;
}

module.exports = {
  LEVELS,
  getLevelInfo,
  formatDuration,
};
