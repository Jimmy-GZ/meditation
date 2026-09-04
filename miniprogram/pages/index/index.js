// pages/index/index.js
const storage = require("../../utils/storage");
const { getLevelInfo, formatDuration } = require("../../utils/levels");

const MIN_RECORD_SECONDS = 60; // 实际冥想满 60 秒才计入打卡

// 等级序数的中文写法，用于「第X重」展示
const CN_NUM = ["壹", "贰", "叁", "肆", "伍", "陆", "柒", "捌"];

// 将秒数格式化为 mm:ss / h:mm:ss
function formatClock(totalSeconds) {
  totalSeconds = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

Page({
  data: {
    state: "idle", // idle 待机 | meditating 冥想中
    // 待机状态
    modeOptions: [
      { type: "free", label: "自由", minutes: 0 },
      { type: "countdown", label: "1分钟", minutes: 1 },
      { type: "countdown", label: "5分钟", minutes: 5 },
      { type: "countdown", label: "10分钟", minutes: 10 },
      { type: "countdown", label: "15分钟", minutes: 15 },
      { type: "countdown", label: "20分钟", minutes: 20 },
    ],
    selectedMode: 0,
    levelName: "",
    levelNumText: "",
    totalDurationText: "",
    progressPercent: 0,
    nextText: "",
    // 冥想中状态
    displayTime: "00:00",
    timerTip: "",
    // 打卡完成弹层
    showResult: false,
    resultDurationText: "",
    newTotalText: "",
    levelUpName: "",
  },

  onLoad() {
    // 当前冥想会话 { mode, plannedDuration, startTime }，进程内缓存
    this.session = null;
    this.timer = null;
    // 倒计时结束提示音（磬声），obeyMuteSwitch=false 使静音模式下也能播放
    this.chime = wx.createInnerAudioContext();
    this.chime.src = "/audio/chime.wav";
    this.chime.obeyMuteSwitch = false;
    this.refreshStats();
  },

  onShow() {
    this.refreshStats();
    // 小程序被关闭后重新打开时，恢复进行中的冥想会话
    this.recoverSession();
  },

  onUnload() {
    this.stopTimer();
    if (this.chime) {
      this.chime.destroy();
      this.chime = null;
    }
  },

  // ---------- 待机状态 ----------

  refreshStats() {
    const { totalSeconds } = storage.getStats();
    const { current, next, progressPercent } = getLevelInfo(totalSeconds);
    this.setData({
      levelName: current.name,
      levelNumText: CN_NUM[current.level - 1],
      totalDurationText: formatDuration(totalSeconds),
      progressPercent,
      nextText: next
        ? `距「${next.name}」尚差 ${formatDuration(next.threshold - totalSeconds)}`
        : "已至圆满 · 静水流深",
    });
  },

  onSelectMode(e) {
    this.setData({ selectedMode: Number(e.currentTarget.dataset.index) });
  },

  onStartMeditation() {
    const mode = this.data.modeOptions[this.data.selectedMode];
    const session = {
      mode: mode.type,
      plannedDuration: mode.minutes * 60, // 秒，自由模式为 0
      startTime: Date.now(),
    };
    this.session = session;
    storage.saveSession(session);
    this.startTimer(session);
  },

  onGoRecords() {
    wx.navigateTo({ url: "/pages/records/index" });
  },

  // ---------- 冥想计时 ----------

  startTimer(session) {
    this.stopTimer();
    this.setData({
      state: "meditating",
      timerTip:
        session.mode === "countdown" ? "本次冥想将在倒计时结束时结束" : "专注当下，一呼一吸",
    });
    this.tick();
    // setInterval 只负责刷新显示，时长一律由时间戳计算，后台节流不漂移
    this.timer = setInterval(() => this.tick(), 500);
  },

  stopTimer() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  },

  tick() {
    const s = this.session;
    if (!s) return;
    const elapsed = (Date.now() - s.startTime) / 1000;
    if (s.mode === "countdown") {
      const remain = s.plannedDuration - elapsed;
      if (remain <= 0) {
        this.setData({ displayTime: "00:00" });
        this.completeMeditation(s.plannedDuration, true);
        return;
      }
      this.setData({ displayTime: formatClock(remain) });
    } else {
      this.setData({ displayTime: formatClock(elapsed) });
    }
  },

  onEndMeditation() {
    const s = this.session;
    if (!s) return;
    const elapsed = Math.floor((Date.now() - s.startTime) / 1000);
    if (elapsed < MIN_RECORD_SECONDS) {
      wx.showModal({
        title: "提示",
        content: "本次冥想不足 1 分钟，将不计入打卡记录。确定要结束吗？",
        confirmText: "结束",
        cancelText: "继续冥想",
        success: (res) => {
          if (res.confirm) this.giveUp();
        },
      });
      return;
    }
    wx.showModal({
      title: "结束冥想",
      content: `已冥想 ${formatDuration(elapsed)}，确定结束并打卡吗？`,
      confirmText: "打卡",
      cancelText: "继续冥想",
      success: (res) => {
        if (res.confirm) this.completeMeditation(elapsed, false);
      },
    });
  },

  // ---------- 完成 / 放弃 ----------

  /**
   * 完成冥想并打卡
   * @param {number} durationSeconds 本次冥想秒数
   * @param {boolean} auto 是否为倒计时自然结束
   */
  completeMeditation(durationSeconds, auto) {
    const s = this.session;
    if (!s) return;
    const startTime = s.startTime;
    // 倒计时自然结束按精确计划时长结算，避免停止定时器的延迟误差
    const endTime =
      s.mode === "countdown" && auto ? startTime + s.plannedDuration * 1000 : Date.now();
    const isNaturalCountdown = s.mode === "countdown" && auto;

    this.stopTimer();
    this.session = null;
    storage.clearSession();

    const beforeLevel = getLevelInfo(storage.getStats().totalSeconds).current;
    storage.addRecord({ duration: durationSeconds, startTime, endTime });
    const stats = storage.getStats();
    const afterLevel = getLevelInfo(stats.totalSeconds).current;

    this.refreshStats();
    this.setData({
      state: "idle",
      showResult: true,
      resultDurationText: formatDuration(durationSeconds),
      newTotalText: formatDuration(stats.totalSeconds),
      levelUpName: afterLevel.level > beforeLevel.level ? `晋级 · ${afterLevel.name}` : "",
    });
    if (isNaturalCountdown) {
      // 结束提醒：磬声 + 震动
      if (this.chime) this.chime.play();
      wx.vibrateLong({ fail: () => {} });
    }
  },

  // 放弃本次冥想：不生成打卡记录
  giveUp() {
    this.stopTimer();
    this.session = null;
    storage.clearSession();
    this.setData({ state: "idle" });
    this.refreshStats();
  },

  onCloseResult() {
    this.setData({ showResult: false });
  },

  noop() {},

  // ---------- 会话恢复 ----------

  // 小程序中途被关闭：重新打开时恢复冥想；倒计时已到点则补记打卡
  recoverSession() {
    if (this.session) return; // 本页仍在冥想中（如从记录页返回），无需恢复
    if (this.data.showResult) return;
    const s = storage.getSession();
    if (!s || !s.startTime) return;
    const elapsed = (Date.now() - s.startTime) / 1000;
    if (s.mode === "countdown" && elapsed >= s.plannedDuration) {
      this.session = s;
      this.completeMeditation(s.plannedDuration, true);
      return;
    }
    this.session = s;
    this.startTimer(s);
  },
});
