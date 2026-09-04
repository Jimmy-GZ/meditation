// pages/records/index.js
const storage = require("../../utils/storage");
const { formatDuration } = require("../../utils/levels");

// 将时间戳格式化为 "YYYY-MM-DD" 与 "HH:mm"
function formatDateTime(timestamp) {
  const d = new Date(timestamp);
  const pad = (n) => String(n).padStart(2, "0");
  return {
    dateText: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    timeText: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
  };
}

Page({
  data: {
    totalDurationText: "",
    count: 0,
    streakDays: 0,
    records: [],
  },

  onShow() {
    this.refresh();
  },

  refresh() {
    const stats = storage.getStats();
    const records = storage.getRecords().map((r) => {
      const { dateText, timeText } = formatDateTime(r.endTime);
      return {
        id: r.id,
        dateText,
        timeText,
        durationText: formatDuration(r.duration),
      };
    });
    this.setData({
      totalDurationText: formatDuration(stats.totalSeconds),
      count: stats.count,
      streakDays: stats.streakDays,
      records,
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
