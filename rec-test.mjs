import { chromium } from '/home/rharvey/Dokumente/Programmieren/jarvis-ui/node_modules/@playwright/test/index.mjs'
const [w, h, gpu] = [+process.argv[2], +process.argv[3], process.argv[4]]
const args = ['--disable-audio-output', ...(gpu ? ['--enable-gpu', '--use-angle=vulkan', '--enable-features=Vulkan', '--ignore-gpu-blocklist'] : [])]
const b = await chromium.launch({ args })
const c = await b.newContext({ viewport: { width: w, height: h }, recordVideo: { dir: '/tmp/vt', size: { width: w, height: h } } })
const p = await c.newPage()
await p.route(/\/api\/(events|say)/, r => r.abort())
await p.goto('http://localhost:5174/')
const fps = await p.evaluate(() => new Promise(res => { let n = 0; const t0 = performance.now(); const f = () => { n++; performance.now() - t0 < 8000 ? requestAnimationFrame(f) : res(n / 8) }; requestAnimationFrame(f) }))
console.log('raf fps', fps, await p.evaluate(() => { const g = document.createElement('canvas').getContext('webgl'); const d = g?.getExtension('WEBGL_debug_renderer_info'); return d ? g.getParameter(d.UNMASKED_RENDERER_WEBGL) : 'none' }))
await c.close(); await b.close()
