const { contextBridge, ipcRenderer } = require('electron');

/**
 * Минимальный whitelist API для renderer.
 * Renderer не получает ipcRenderer, require, process или доступ к файловой системе.
 */
const api = Object.freeze({
  /**
   * Возвращает безопасные сведения о приложении.
   * @returns {Promise<{name: string, version: string, electron: string, chrome: string}>}
   */
  getAppInfo: () => ipcRenderer.invoke('app:get-info'),
});

contextBridge.exposeInMainWorld('moscowRoleplay', api);
