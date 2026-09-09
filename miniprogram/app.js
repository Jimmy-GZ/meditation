// app.js
const { getCloudEnv } = require("./utils/env");

App({
  onLaunch: function () {
    this.globalData = {
      // 云开发环境 ID（envList.js 第一个环境）。为空时不上云，仅本地存储
      env: getCloudEnv(),
    };
    if (!wx.cloud) {
      console.error("请使用 2.2.3 或以上的基础库以使用云能力");
    } else if (this.globalData.env) {
      wx.cloud.init({
        env: this.globalData.env,
        traceUser: true,
      });
    } else {
      console.warn("[meditation] 未配置云开发环境（envList.js 为空），本次仅本地存储");
    }
  },
});
