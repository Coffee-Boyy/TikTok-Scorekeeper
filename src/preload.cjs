const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("scorekeeper", {
  getState: () => ipcRenderer.invoke("app:state"),
  assignGift: (giftId, participantId) => ipcRenderer.invoke("gift:assign", giftId, participantId),
  assignGifts: (giftIds, participantId) => ipcRenderer.invoke("gift:assign-many", giftIds, participantId),
  clearMissedGifts: () => ipcRenderer.invoke("gift:clear-missed"),
  resetScores: () => ipcRenderer.invoke("show:reset-scores"),
  openEulerKeyHelp: () => ipcRenderer.invoke("help:euler-key"),
  openEulerPricingHelp: () => ipcRenderer.invoke("help:euler-pricing"),
  setActiveDancer: participantId => ipcRenderer.invoke("dancer:set", participantId),
  setRoutingRule: (giftName, participantId) => ipcRenderer.invoke("rules:set", giftName, participantId),
  removeRoutingRule: giftName => ipcRenderer.invoke("rules:delete", giftName),
  connect: username => ipcRenderer.invoke("stream:connect", username),
  discoverGuests: username => ipcRenderer.invoke("stream:discover", username),
  disconnect: () => ipcRenderer.invoke("stream:disconnect"),
  toggleAutoConnect: () => ipcRenderer.invoke("settings:autoconnect"),
  updateSettings: patch => ipcRenderer.invoke("settings:update", patch),
  previewRanking: patch => ipcRenderer.invoke("settings:preview-ranking", patch),
  copyRanking: () => ipcRenderer.invoke("ranking:copy"),
  copyOverlay: () => ipcRenderer.invoke("overlay:copy"),
  exportCsv: () => ipcRenderer.invoke("show:export"),
  onStateChanged: callback => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on("state:changed", listener);
    return () => ipcRenderer.removeListener("state:changed", listener);
  },
  onGiftSound: callback => {
    const listener = (_event, sound) => callback(sound);
    ipcRenderer.on("gift:sound", listener);
    return () => ipcRenderer.removeListener("gift:sound", listener);
  }
});
