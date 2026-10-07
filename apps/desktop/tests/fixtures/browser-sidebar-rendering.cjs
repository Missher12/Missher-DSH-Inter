/** Owned native rendering regression. Caller shows the parent with showInactive(). */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { BrowserWindow, nativeImage } = require('electron')
const images = new Map()
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const sessionId = 'rendering-session'

function image(color) {
  if (images.has(color)) return images.get(color)
  const bytes = Buffer.alloc(120 * 120 * 4)
  for (let i = 0; i < bytes.length; i += 4) {
    bytes[i] = color === 'blue' ? 255 : 0
    bytes[i + 2] = color === 'red' ? 255 : 0
    bytes[i + 3] = 255
  }
  const png = nativeImage.createFromBitmap(bytes, { width: 120, height: 120 }).toPNG()
  images.set(color, png)
  return png
}

/** Return true only when this helper has answered an owned PNG request. */
function serve(request, response) {
  if (request.method !== 'GET' || !['/red.png', '/blue.png'].includes(request.url)) return false
  response.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' })
  response.end(image(request.url === '/red.png' ? 'red' : 'blue'))
  return true
}

const html = `<!doctype html><meta charset="utf-8"><title>Owned asynchronous canvas</title>
<p id="paint-state">Waiting for image</p>
<canvas id="canvas" width="120" height="120" style="position:fixed;top:150px;left:20px"></canvas>
<script>
async function paint(color) {
  document.querySelector('#paint-state').textContent = 'Loading ' + color;
  const response = await fetch(color === '#ff0000' ? '/red.png' : '/blue.png', {cache:'no-store'});
  if (!response.ok) throw Error('Owned image request failed');
  const image = await createImageBitmap(await response.blob());
  document.querySelector('canvas').getContext('2d').drawImage(image, 0, 0);
  image.close();
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  document.querySelector('#paint-state').textContent = 'Painted ' + color;
}
paint('#ff0000');
</script>`

/** Exercise production automation only; request(sessionId, operation) is the existing fixture helper. */
async function run({ window, request, open, attached, root, checks, automation }) {
  const output = path.join(root, 'rendering')
  fs.mkdirSync(output, { recursive: true, mode: 0o700 })
  for (const color of ['red', 'blue']) fs.writeFileSync(path.join(output, `source-${color}.png`), image(color))
  assert.equal(window.isFocused(), false, 'Create rendering parent with show:false, then showInactive()')
  const ownerThrottling = window.webContents.getBackgroundThrottling()
  const cover = new BrowserWindow({ ...window.getBounds(), show: false, alwaysOnTop: true,
    focusable: false, title: 'Owned stable rendering cover' })
  const targets = new Set()
  const seen = new Set()
  try {
    await cover.loadURL('data:text/html,<body style="background:%23333;color:white">Owned rendering cover</body>')
    cover.showInactive()
    assert.deepEqual(cover.getBounds(), window.getBounds())
    assert.equal(cover.isAlwaysOnTop(), true)
    for (let pass = 0; pass < 2; pass++) {
      await pause(8000)
      const opened = await open(sessionId)
      assert.equal(opened.value.status, 'delivered', JSON.stringify(opened))
      const target = opened.value.target
      assert.equal(seen.has(target), false); seen.add(target); targets.add(target)
      const guest = attached.get(target)
      assert.ok(guest)
      const guestThrottling = guest.getBackgroundThrottling()
      const deadline = Date.now() + 5000
      while ((guest.isLoading() || !guest.getURL().startsWith('http://127.0.0.1:')) && Date.now() < deadline) await pause(20)
      assert.ok(!guest.isLoading() && guest.getURL().startsWith('http://127.0.0.1:'))
      for (const color of ['red', 'blue']) {
        if (color === 'blue') await guest.executeJavaScript('void paint("#0000ff")')
        const observation = await request(sessionId, { action: 'wait', target,
          text: `Painted ${color === 'red' ? '#ff0000' : '#0000ff'}`, timeoutMs: 4000 })
        assert.equal(observation.status, 'observed', JSON.stringify(observation))
        const started = performance.now()
        const result = await request(sessionId, { action: 'screenshot', target })
        const elapsedMs = Math.round(performance.now() - started)
        assert.equal(result.status, 'observed', JSON.stringify(result))
        const bytes = Buffer.from(result.image.data, 'base64')
        fs.writeFileSync(path.join(output, `guest-${pass + 1}-${color}.png`), bytes)
        const picture = nativeImage.createFromBuffer(bytes)
        const viewport = await guest.executeJavaScript('({width:innerWidth,height:innerHeight})')
        const scale = picture.getSize().width / viewport.width
        const pixel = [...picture.crop({ x: Math.round(40 * scale), y: Math.round(170 * scale), width: 1, height: 1 }).toBitmap()]
        assert.deepEqual(pixel.slice(0, 3), color === 'red' ? [0, 0, 255] : [255, 0, 0])
        assert.equal(window.isFocused(), false)
        assert.equal(window.webContents.getBackgroundThrottling(), ownerThrottling)
        assert.equal(guest.getBackgroundThrottling(), guestThrottling)
        assert.equal(automation.entries.get(target).inFlight.size, 0)
        checks.push({ name: 'stable occlusion asynchronous image', pass: pass + 1, color, target,
          elapsedMs, bytes: bytes.length, size: picture.getSize(), pixelBGRA: pixel })
      }
      assert.equal((await request(sessionId, { action: 'close', target })).status, 'closed')
      targets.delete(target)
      // Remove only closed fixture markup; the next capture follows another 8-second occlusion.
      await window.webContents.executeJavaScript('document.querySelectorAll("section[id^=guest-],p[data-lease]").forEach(el=>el.remove())')
    }
    const listed = await request(sessionId, { action: 'list' })
    assert.equal(listed.status, 'observed'); assert.deepEqual(listed.data, [])
  } finally {
    try { for (const target of targets) await request(sessionId, { action: 'close', target }) }
    finally { if (!cover.isDestroyed()) cover.destroy() }
  }
}

module.exports = { serve, html, run }
