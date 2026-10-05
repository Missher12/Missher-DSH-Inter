/** An owned, account-free Electron window for opt-in native input verification. */
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const root = process.env.DSH_NATIVE_WINDOW_ROOT
const title = process.env.DSH_NATIVE_WINDOW_TITLE
if (!root || !path.basename(root).startsWith('dsh-cbu-native-window-') || !title?.startsWith('DSH Native Fixture ')) {
  throw new Error('A dedicated native fixture directory and title are required')
}
app.setPath('userData', path.join(root, 'profile'))
let window, sequence = 0, previousCommand = 0
const save = (name, value) => {
  const target = path.join(root, name)
  fs.writeFileSync(`${target}.next`, JSON.stringify(value))
  fs.renameSync(`${target}.next`, target)
}
async function createWindow() {
  window = new BrowserWindow({ title, width: 640, height: 420, show: false, backgroundColor: '#ffffff', webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', event => event.preventDefault())
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><html lang="en"><head><title>${title}</title><style>body{font:20px system-ui;padding:40px;background:white;color:#111}input,button{display:block;font:20px system-ui;padding:12px;margin:16px 0}output{display:block}</style></head><body><h1>Native fixture only</h1><label for="entry">Fixture input</label><input id="entry" aria-label="Fixture input" autocomplete="off"><button id="record">Record fixture value</button><output id="result">Empty</output><output id="count">0</output><script>let clicks=0;document.querySelector('#record').onclick=()=>{document.querySelector('#result').textContent=document.querySelector('#entry').value;document.querySelector('#count').textContent=String(++clicks)}</script></body></html>`)}`)
  window.showInactive()
  save('ready.json', { pid: process.pid, title, electron: process.versions.electron, generation: ++sequence })
}
app.whenReady().then(async () => {
  app.setAccessibilitySupportEnabled(true)
  await createWindow()
  const timer = setInterval(async () => {
    try {
      if (fs.existsSync(path.join(root, 'command.json'))) {
        const command = JSON.parse(fs.readFileSync(path.join(root, 'command.json'), 'utf8'))
        if (Number.isSafeInteger(command.id) && command.id > previousCommand) {
          previousCommand = command.id
          if (command.action === 'hide') window.hide()
          else if (command.action === 'show') window.showInactive()
          else if (command.action === 'replace') { window.destroy(); await createWindow() }
          else if (command.action === 'quit') { clearInterval(timer); app.exit(0); return }
          save('command-result.json', { id: command.id })
        }
      }
      if (!window.isDestroyed()) {
        const state = await window.webContents.executeJavaScript('({value:document.querySelector("#entry").value,result:document.querySelector("#result").textContent,clicks:Number(document.querySelector("#count").textContent)})')
        save('state.json', { ...state, generation: sequence, visible: window.isVisible() })
      }
    } catch (error) { save('fixture-error.json', { message: error.message }) }
  }, 100)
  setTimeout(() => app.exit(0), 120_000).unref()
}).catch(error => { save('fixture-error.json', { message: error.message }); app.exit(1) })
app.on('window-all-closed', () => {})
