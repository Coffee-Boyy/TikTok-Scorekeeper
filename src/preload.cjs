const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("scorekeeper", {
  getState: () => ipcRenderer.invoke("app:state"),
  assignGift: (giftId, participantId) => ipcRenderer.invoke("gift:assign", giftId, participantId),
  setRoutingRule: (giftName, participantId) => ipcRenderer.invoke("rules:set", giftName, participantId),
  removeRoutingRule: giftName => ipcRenderer.invoke("rules:delete", giftName),
  connect: username => ipcRenderer.invoke("stream:connect", username),
  discoverGuests: username => ipcRenderer.invoke("stream:discover", username),
  signIn: username => ipcRenderer.invoke("stream:login", username),
  disconnect: () => ipcRenderer.invoke("stream:disconnect"),
  toggleAutoConnect: () => ipcRenderer.invoke("settings:autoconnect"),
  copyOverlay: () => ipcRenderer.invoke("overlay:copy"),
  simulateGift: () => ipcRenderer.invoke("gift:simulate"),
  exportCsv: () => ipcRenderer.invoke("show:export"),
  onStateChanged: callback => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on("state:changed", listener);
    return () => ipcRenderer.removeListener("state:changed", listener);
  }
});
