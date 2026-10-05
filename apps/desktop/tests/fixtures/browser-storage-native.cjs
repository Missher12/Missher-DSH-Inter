/** Two fresh Electron processes verify only fixture cookie persistence and no page restoration. */
const { app, BrowserWindow, session } = require('electron')
const path = require('node:path'), fs = require('node:fs'), assert = require('node:assert/strict')
const { pathToFileURL } = require('node:url')
const root = process.env.CBU_STORAGE_ROOT
if (!root || !path.basename(root).startsWith('dsh-cbu-storage-')) throw new Error('A dedicated fixture directory is required')
app.setPath('userData', path.join(root, 'profile'))
app.whenReady().then(async () => {
  const { DesktopBrowserGuests } = await import(pathToFileURL(path.join(process.env.CBU_NATIVE_MODULES, 'browser-guests.mjs')))
  const window = new BrowserWindow({ show:false, webPreferences:{sandbox:true} })
  const guests = new DesktopBrowserGuests(()=>'http://127.0.0.1:19387')
  const persistent=guests.acquire(window.webContents,'fixture-session',true)
  const temporary=guests.acquire(window.webContents,'fixture-session',false)
  const persistentSession=session.fromPartition(persistent.partition)
  const temporarySession=session.fromPartition(temporary.partition)
  const mark={url:'https://cbu.invalid',name:'fixture-login',value:'synthetic-only',expirationDate:Date.now()/1000+3600}
  if(process.env.CBU_STORAGE_PHASE==='write') {
    await persistentSession.cookies.set(mark);await temporarySession.cookies.set(mark)
    await persistentSession.cookies.flushStore();await temporarySession.cookies.flushStore()
    fs.writeFileSync(path.join(root,'partitions.json'),JSON.stringify({persistent:persistent.partition,temporary:temporary.partition}))
  } else {
    const before=JSON.parse(fs.readFileSync(path.join(root,'partitions.json'),'utf8'))
    assert.equal(persistent.partition,before.persistent);assert.notEqual(temporary.partition,before.temporary)
    assert.equal((await persistentSession.cookies.get({name:mark.name}))[0].value,mark.value)
    assert.equal((await temporarySession.cookies.get({name:mark.name})).length,0)
    assert.throws(()=>guests.guest(window.webContents,persistent.lease),/unavailable/)
    console.log(JSON.stringify({status:'passed',electron:process.versions.electron,checks:['explicit persistent partition stable across process restart','synthetic login cookie restored','temporary cookie not restored','page runtime not restored']}))
  }
  window.destroy()
}).catch(error=>{console.error(error);process.exitCode=1}).finally(()=>app.exit(process.exitCode||0))
