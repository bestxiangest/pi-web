"use strict";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const path = require("node:path");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { app, BrowserWindow, Menu, session, shell } = require("electron");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getUrlOrigin, isInternalUrl, isSafeExternalUrl } = require("./window-policy.cjs");

const appUrl = process.env.PI_WEB_APP_URL;
const appOrigin = getUrlOrigin(appUrl);
if (!appUrl || !appOrigin || !["http:", "https:"].includes(new URL(appUrl).protocol)) {
  console.error("PI_WEB_APP_URL must be a valid HTTP or HTTPS URL.");
  app.exit(1);
}

const pkgDir = path.join(__dirname, "..");
const iconPath = path.join(pkgDir, "public", "icons", "icon-512.png");
const secureWebPreferences = {
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
};

process.title = "Pi Web";
app.setName("Pi Web");
app.setAppUserModelId("dev.pi-web.app");
app.setPath("userData", path.join(app.getPath("appData"), "Pi Web"));

let mainWindow = null;

function focusMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createMainWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function openExternalUrl(url) {
  if (isSafeExternalUrl(url)) void shell.openExternal(url);
}

function configureWebContents(contents) {
  contents.on("will-attach-webview", (event) => event.preventDefault());
  contents.on("will-navigate", (event) => {
    if (isInternalUrl(event.url, appOrigin)) return;
    event.preventDefault();
    openExternalUrl(event.url);
  });
  contents.on("will-redirect", (event) => {
    if (isInternalUrl(event.url, appOrigin)) return;
    event.preventDefault();
    openExternalUrl(event.url);
  });
  contents.setWindowOpenHandler(({ url }) => {
    if (!isInternalUrl(url, appOrigin)) {
      openExternalUrl(url);
      return { action: "deny" };
    }

    return {
      action: "allow",
      overrideBrowserWindowOptions: {
        autoHideMenuBar: process.platform !== "darwin",
        backgroundColor: "#1a1a1a",
        webPreferences: secureWebPreferences,
      },
    };
  });
}

function configurePermissions() {
  const isAllowed = (permission, requestingUrl) => (
    permission === "notifications" && isInternalUrl(requestingUrl, appOrigin)
  );

  session.defaultSession.setPermissionCheckHandler((_, permission, requestingOrigin) => (
    isAllowed(permission, requestingOrigin)
  ));
  session.defaultSession.setPermissionRequestHandler((_, permission, callback, details) => {
    callback(isAllowed(permission, details.requestingUrl));
  });
}

function installApplicationMenu() {
  const template = [];
  if (process.platform === "darwin") {
    template.push({
      label: "Pi Web",
      submenu: [
        { role: "about" },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    });
  }
  template.push(
    { role: "fileMenu" },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
  );
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    title: "Pi Web",
    width: 1440,
    height: 900,
    minWidth: 720,
    minHeight: 520,
    show: false,
    autoHideMenuBar: process.platform !== "darwin",
    backgroundColor: "#1a1a1a",
    icon: iconPath,
    webPreferences: secureWebPreferences,
  });

  mainWindow.once("ready-to-show", () => mainWindow?.show());
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  void mainWindow.loadURL(appUrl).catch((error) => {
    console.error(`Failed to load Pi Web: ${error.message}`);
  });
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", focusMainWindow);
  app.on("web-contents-created", (_, contents) => configureWebContents(contents));
  app.on("activate", focusMainWindow);
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  void app.whenReady().then(() => {
    configurePermissions();
    installApplicationMenu();
    if (process.platform === "darwin") app.dock.setIcon(iconPath);
    createMainWindow();
  });
}
