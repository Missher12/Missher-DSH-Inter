/** Standalone Electron fixture: exact webview control on a local page, without DSH credentials. */
const { app, BrowserWindow, dialog } = require('electron')
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http'), assert = require('node:assert/strict')
const { pathToFileURL } = require('node:url')
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cbu-electron-evidence-')))
app.setPath('userData', path.join(root, 'profile'))
let browser, automation, files, server
const timeout = setTimeout(() => { console.error('CBU_NATIVE_TIMEOUT'); app.exit(1) }, 45000)
app.whenReady().then(async () => {
  const modules = process.env.CBU_NATIVE_MODULES
  const { DesktopBrowserAutomation } = await import(pathToFileURL(path.join(modules, 'browser-automation.mjs')))
  const { DesktopBrowserGuests } = await import(pathToFileURL(path.join(modules, 'browser-guests.mjs')))
  const { DesktopBrowserFiles } = await import(pathToFileURL(path.join(modules, 'browser-files.mjs')))
  const preload = path.join(root, 'preload.cjs')
  fs.writeFileSync(preload, `const {ipcRenderer,contextBridge}=require('electron');contextBridge.exposeInMainWorld('fixture',{onOpen:f=>ipcRenderer.on('fixture:open',(_e,r)=>f(r))});`)
  const renderer = `<title>Protected shell</title><p id="guard">Shell untouched</p><script>fixture.onOpen(r=>{const v=document.createElement('webview');v.style='width:720px;height:480px;display:block';v.setAttribute('partition',r.partition);v.setAttribute('allowpopups','');v.src='about:blank#'+r.lease;v.addEventListener('dom-ready',()=>{if(v.getURL().startsWith('about:blank'))v.loadURL(r.url).catch(()=>{})});document.body.append(v)});</script>`
  const page = '<style>body{background:white;color:black}</style><title>CBU local form</title><label>Display name <input aria-label="Display name" id="name"></label><button id="save" onclick="document.querySelector(\'#result\').textContent=\'Saved: \'+document.querySelector(\'#name\').value">Save</button><p id="result">Waiting</p><input type="file" aria-label="Fixture file" id="file"><a href="/popup" target="_blank">Popup</a><a href="/download" download="fixture.txt">Download fixture</a><div style="height:1300px"></div><p>End of test</p>'
  server = http.createServer((req,res) => { if(req.url==='/download'){res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Disposition':'attachment; filename=fixture.txt'});res.end('only local download content');return} res.writeHead(200,{'Content-Type':'text/html'});res.end(req.url==='/popup' ? '<title>Owned popup</title><p>Popup result</p>' : page) })
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  const url = `http://127.0.0.1:${server.address().port}`
  browser = new BrowserWindow({ width:1000,height:760,show:true,webPreferences:{preload,contextIsolation:true,nodeIntegration:false,sandbox:true,webviewTag:true} })
  files = new DesktopBrowserFiles(()=>browser)
  const savedDownload=path.join(root,'explicitly-selected-download.txt')
  dialog.showSaveDialog=async()=>({canceled:false,filePath:savedDownload})
  const guests = new DesktopBrowserGuests(()=> 'http://127.0.0.1:19387', (event,item,guest)=>files.download(event,item,guest), (lease,url)=>automation.openPopup(lease,url))
  const selected = path.join(root,'fixture-upload.txt');fs.writeFileSync(selected,'only local fixture content')
  const attached = new Map()
  dialog.showOpenDialog=async()=>({canceled:false,filePaths:[selected]})
  automation = new DesktopBrowserAutomation({
    reserve:owner=>guests.acquire(browser.webContents,owner.sessionId),
    present:(owner,reservation,url)=>browser.webContents.send('fixture:open',{...reservation,url}),
    release:lease=>guests.release(browser.webContents,lease),publish:()=>{},allowed:value=>guests.allowedNavigation(value),selectUpload:guest=>files.selectUpload(guest),
  })
  guests.bind(browser,()=>()=>{},(lease,guest)=>{attached.set(lease,guest);automation.attached(lease,guest)})
  await browser.loadURL('data:text/html,' + encodeURIComponent(renderer))
  const owner={sessionId:'fixture-session-one',activationId:'fixture-activation-one'}
  const invoke=operation=>automation.request({owner,operation},new AbortController().signal)
  const opened=await invoke({action:'open',url}); assert.equal(opened.status,'delivered')
  const target=opened.target
  const initial=await invoke({action:'wait',target,text:'Display name',timeoutMs:5000});assert.equal(initial.status,'observed')
  const input=initial.data.nodes.find(x=>x.role==='textbox'&&x.name==='Display name'); assert.ok(input)
  const filled=await invoke({action:'fill',target,snapshot:initial.snapshot,element:input.ref,text:'Cordis candidate'});assert.equal(filled.status,'delivered')
  assert.equal(await attached.get(target).executeJavaScript('document.querySelector("#name").value'),'Cordis candidate')
  const stale=await invoke({action:'click',target,snapshot:initial.snapshot,element:input.ref});assert.equal(stale.status,'stale-snapshot')
  const observation=await invoke({action:'observe',target});const button=observation.data.nodes.find(x=>x.role==='button'&&x.name==='Save');assert.ok(button)
  assert.equal((await invoke({action:'click',target,snapshot:observation.snapshot,element:button.ref})).status,'delivered')

  assert.equal((await invoke({action:'wait',target,text:'Saved: Cordis candidate',timeoutMs:5000})).status,'observed')
  const actual = await attached.get(target).executeJavaScript('document.querySelector("#result").textContent');assert.equal(actual,'Saved: Cordis candidate')
  await new Promise(resolve=>setTimeout(resolve,250))
  const screenshot=await invoke({action:'screenshot',target});assert.ok(screenshot.image.data.length>100);fs.writeFileSync(path.join(root,'same-guest.png'),Buffer.from(screenshot.image.data,'base64'))
  assert.equal(await browser.webContents.executeJavaScript('document.querySelector("#guard").textContent'),'Shell untouched')
  const uploadView=await invoke({action:'observe',target});const fileNode=uploadView.data.nodes.find(x=>x.name==='Fixture file' && x.ref);assert.ok(fileNode)
  assert.equal((await invoke({action:'upload',target,snapshot:uploadView.snapshot,element:fileNode.ref})).status,'delivered')
  assert.equal(await attached.get(target).executeJavaScript('document.querySelector("#file").files[0].name'),'fixture-upload.txt')
  const downloadView=await invoke({action:'observe',target});const downloadLink=downloadView.data.nodes.find(x=>x.role==='link' && x.name==='Download fixture');assert.ok(downloadLink)
  assert.equal((await invoke({action:'click',target,snapshot:downloadView.snapshot,element:downloadLink.ref})).status,'delivered')
  await new Promise(resolve=>setTimeout(resolve,250));assert.equal(fs.existsSync(savedDownload),false)
  files.allowDownload(attached.get(target))
  const allowedDownload=await invoke({action:'observe',target});const allowedLink=allowedDownload.data.nodes.find(x=>x.role==='link' && x.name==='Download fixture')
  assert.equal((await invoke({action:'click',target,snapshot:allowedDownload.snapshot,element:allowedLink.ref})).status,'delivered')
  for(let i=0;i<100&&!fs.existsSync(savedDownload);i++)await new Promise(resolve=>setTimeout(resolve,50))
  assert.equal(fs.readFileSync(savedDownload,'utf8'),'only local download content')
  const popupView=await invoke({action:'observe',target});const popupLink=popupView.data.nodes.find(x=>x.role==='link' && x.name==='Popup');assert.ok(popupLink)
  assert.equal((await invoke({action:'click',target,snapshot:popupView.snapshot,element:popupLink.ref})).status,'delivered')
  let tabs;for(let i=0;i<50;i++){tabs=await invoke({action:'list'});if(tabs.data.length===2 && tabs.data.every(x=>x.status==='ready'))break;await new Promise(r=>setTimeout(r,40))}assert.equal(tabs.data.length,2)
  const popupTarget=tabs.data.find(x=>x.target!==target).target
  assert.equal((await invoke({action:'wait',target:popupTarget,text:'Popup result',timeoutMs:5000})).status,'observed')
  const other={sessionId:'fixture-session-two',activationId:'fixture-activation-two'}
  assert.equal((await automation.request({owner:other,operation:{action:'observe',target}},new AbortController().signal)).status,'stale-target')
  const second=await automation.request({owner:other,operation:{action:'open',url}},new AbortController().signal);assert.equal(second.status,'delivered');assert.notEqual(second.target,target);await automation.request({owner:other,operation:{action:'wait',target:second.target,text:'Display name',timeoutMs:5000}},new AbortController().signal)
  await automation.control(target,'takeover');assert.equal((await invoke({action:'observe',target})).status,'denied')
  await automation.control(target,'resume');assert.equal((await invoke({action:'click',target,snapshot:observation.snapshot,element:button.ref})).status,'stale-snapshot')
  const fresh=await invoke({action:'observe',target});assert.equal((await invoke({action:'scroll',target,snapshot:fresh.snapshot,delta:600})).status,'delivered')
  await invoke({action:'release'});assert.equal((await invoke({action:'list'})).status,'stale-target')
  await automation.dispose()
  console.log(JSON.stringify({status:'passed',electron:process.versions.electron,platform:process.platform,arch:process.arch,evidence:root,checks:['same guest visible and controlled','local form readback','screenshot','old snapshot refusal','cross session refusal','two owned tabs','takeover and resume','scroll','shell untouched','activation retirement','owned popup','selected staged upload','default download denial','one-shot download saved without overwrite']}))
}).catch(error=>{console.error(error);process.exitCode=1}).finally(async()=>{
  clearTimeout(timeout);await automation?.dispose().catch(()=>{});await files?.dispose().catch(()=>{});browser?.destroy();await new Promise(resolve=>server?.close(resolve)??resolve());app.exit(process.exitCode||0)
})
