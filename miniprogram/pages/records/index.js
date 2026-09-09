// pages/records/index.js
const storage = require("../../utils/storage");
const { getLevelInfo, formatDuration } = require("../../utils/levels");

const WEEK_CN = ["日", "一", "二", "三", "四", "五", "六"];
const pad = (n) => String(n).padStart(2, "0");

// 将时间戳拆成时间轴所需的年月/日期/时刻文案
function splitDateTime(timestamp) {
  const d = new Date(timestamp);
  return {
    monthKey: `${d.getFullYear()}-${pad(d.getMonth() + 1)}`,
    monthLabel: `${d.getFullYear()} 年 ${d.getMonth() + 1} 月`,
    dayText: `${d.getDate()}日 · 周${WEEK_CN[d.getDay()]}`,
    timeText: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
  };
}

Page({
  data: {
    totalDurationText: "",
    count: 0,
    streakDays: 0,
    filter: "all", // all 全部节点 | noted 仅留字节点
    months: [], // 月份快速定位 chips [{ key, label }]
    sections: [], // 时间轴分区 [{ key, label, count, nodes: [...] }]
    scrollIntoId: "", // scroll-view 锚点（月份分区 id）
    hasRecords: false,
    notedEmpty: false, // 有记录但「仅留字」筛选为空
  },

  onShow() {
    this.refresh();
    // 云端同步完成后再刷新一次（本地读取始终即时，此处只处理云端合并结果）
    storage.syncFromCloud(() => this.refresh());
  },

  /**
   * 重建时间轴：
   * 1. 记录按 endTime 升序累计总时长，用 getLevelInfo 判断每次打卡前后等级，
   *    跨过门槛的那一次即里程碑节点（与主页晋级判定同一口径，旧记录同样正确）
   * 2. 按当前筛选过滤后，倒序按月分组为时间轴分区
   */
  refresh() {
    const stats = storage.getStats();
    const asc = storage
      .getRecords()
      .slice()
      .sort((a, b) => a.endTime - b.endTime);

    let runningSeconds = 0;
    const nodes = asc.map((r) => {
      const before = getLevelInfo(runningSeconds).current;
      runningSeconds += r.duration || 0;
      const after = getLevelInfo(runningSeconds).current;
      const { monthKey, monthLabel, dayText, timeText } = splitDateTime(r.endTime);
      return {
        id: r.id,
        monthKey,
        monthLabel,
        dayText,
        timeText,
        durationText: formatDuration(r.duration),
        note: r.note || "",
        milestone: after.level > before.level,
        milestoneName: after.name,
      };
    });

    const filtered =
      this.data.filter === "noted" ? nodes.filter((n) => n.note) : nodes;

    // 倒序后按月份分组（Map 保持「倒序插入 = 最新月份在前」）
    const monthMap = new Map();
    filtered
      .slice()
      .reverse()
      .forEach((n) => {
        if (!monthMap.has(n.monthKey)) {
          monthMap.set(n.monthKey, {
            key: n.monthKey,
            label: n.monthLabel,
            count: 0,
            nodes: [],
          });
        }
        const section = monthMap.get(n.monthKey);
        section.count++;
        section.nodes.push(n);
      });
    const sections = Array.from(monthMap.values());

    this.setData({
      totalDurationText: formatDuration(stats.totalSeconds),
      count: stats.count,
      streakDays: stats.streakDays,
      hasRecords: nodes.length > 0,
      notedEmpty: nodes.length > 0 && filtered.length === 0,
      months: sections.map((s) => ({ key: s.key, label: s.label })),
      sections,
      scrollIntoId: "",
    });
  },

  onChangeFilter(e) {
    const filter = e.currentTarget.dataset.value;
    if (filter === this.data.filter) return;
    this.setData({ filter });
    this.refresh();
  },

  // 点击月份 chip：平滑滚动时间轴到该月份分区
  onMonthTap(e) {
    const key = e.currentTarget.dataset.key;
    // 先清空再赋值，保证连续点击同一个月也能重新触发滚动
    this.setData({ scrollIntoId: "" });
    wx.nextTick(() => {
      this.setData({ scrollIntoId: `h-${key}` });
    });
  },

  onClearAll() {
    wx.showModal({
      title: "清空数据",
      content: "将删除全部打卡记录与累计时长，此操作不可恢复。确定清空吗？",
      confirmText: "清空",
      confirmColor: "#e54545",
      success: (res) => {
        if (!res.confirm) return;
        storage.clearAll();
        this.refresh();
        wx.showToast({ title: "已清空", icon: "success" });
      },
    });
  },
});
