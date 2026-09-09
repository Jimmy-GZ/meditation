// utils/env.js
// 云开发环境 ID 的唯一来源。
// envList.js 由微信开发者工具「云开发」面板维护（选择环境后自动写入），
// 也可手动填：[{ envId: "meditation-prod", alias: "冥想" }]；
// 为空数组时应用退化为「纯本地存储」模式，功能完整。
const { envList } = require("../envList");

function getCloudEnv() {
  if (!Array.isArray(envList) || envList.length === 0) return "";
  const first = envList[0];
  return first && typeof first.envId === "string" ? first.envId : "";
}

module.exports = {
  getCloudEnv,
};
