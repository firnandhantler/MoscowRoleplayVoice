const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow, ipcMain, session } = require('electron');

// Песочница для всех renderer-процессов.
app.enableSandbox();
app.setName('MoscowRoleplay Voice');
app.setAppUserModelId('com.moscowroleplay.voice');

const isDevelopment = !app.isPackaged;
const rendererEntryPath = path.join(__dirname, '..', 'renderer', 'index.html');
const rendererEntryUrl = pathToFileURL(rendererEntryPath).href;

/**
 * Проверяет, что IPC-запрос пришёл из локального renderer-файла приложения,
 * а не из внешней страницы.
 *
 * @param {Electron.IpcMainInvokeEvent} event
 * @returns {boolean}
 */
function isTrustedSender(event) {
  const senderUrl = event.senderFrame?.url ?? '';
  return senderUrl === rendererEntryUrl;
}

/**
 * Создаёт главное окно с безопасными настройками.
 * Полноценный голосовой интерфейс будет добавлен на следующем этапе.
 */
function createWindow() {
  const window = new BrowserWindow({
    width: 980,
    height: 680,
    minWidth: 760,
    minHeight: 520,
    show: false,
    title: 'MoscowRoleplay Voice',
    backgroundColor: '#0b1118',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      spellcheck: false,
      devTools: isDevelopment,
    },
  });

  window.removeMenu();

  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  window.webContents.on('will-navigate', (event, url) => {
    if (url !== rendererEntryUrl) {
      event.preventDefault();
    }
  });

  window.webContents.on('will-attach-webview', (event) => {
    event.preventDefault();
  });

  window.once('ready-to-show', () => {
    window.show();
  });

  void window.loadFile(rendererEntryPath);
}

app.whenReady().then(() => {
  // По умолчанию запрещаем все разрешения браузера.
  // Для микрофона в будущем потребуется отдельное явное разрешение
  // только для локального renderer-файла приложения.
  session.defaultSession.setPermissionRequestHandler(
    (_webContents, _permission, callback) => {
      callback(false);
    },
  );

  session.defaultSession.setPermissionCheckHandler(() => false);

  ipcMain.handle('app:get-info', (event) => {
    if (!isTrustedSender(event)) {
      throw new Error('Недоверенный источник IPC-запроса.');
    }

    return {
      name: app.getName(),
      version: app.getVersion(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
    };
  });

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
