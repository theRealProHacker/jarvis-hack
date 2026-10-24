// Records /demo.html headless (GPU) with the CDP screencast, then lays the rendered speech over it at the moments
// the page logged and writes demo/jarvis-demo.mp4.
// Run with the dev server up: node scripts/demo-record.mjs [width height]
// --mix redoes only the encode, from the frames and cues of the last recording; --bg=sky|city records with a backdrop.
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { chromium } from '../../jarvis-ui/node_modules/@playwright/test/index.mjs'

const mixOnly = process.argv.includes('--mix')
const bg = process.argv.find((a) => a.startsWith('--bg='))?.slice(5)
const size = process.argv.slice(2).filter((a) => !a.startsWith('--'))
const [W, H] = [+(size[0] ?? 1920), +(size[1] ?? 1080)]
const root = new URL('..', import.meta.url).pathname
const out = `${root}demo`
const frames = `${out}/frames`
if (!mixOnly) await record()
const { cues, seconds } = JSON.parse(readFileSync(`${out}/cues.json`, 'utf8'))

async function record() {
rmSync(frames, { recursive: true, force: true })
mkdirSync(frames, { recursive: true })

const browser = await chromium.launch({ args: ['--disable-audio-output', '--enable-gpu', '--use-angle=vulkan', '--enable-features=Vulkan', '--ignore-gpu-blocklist'] })
const page = await browser.newPage({ viewport: { width: W, height: H } })
await page.route(/\/api\//, (r) => r.abort())
await page.goto(`http://localhost:5174/demo.html${bg ? `?bg=${bg}` : ''}`)
await page.waitForFunction(() => window.__start)
await page.waitForTimeout(bg ? 8000 : 1500)

const cdp = await page.context().newCDPSession(page)
const shots = []
cdp.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
  const file = `${frames}/${String(shots.length).padStart(5, '0')}.jpg`
  writeFileSync(file, Buffer.from(data, 'base64'))
  shots.push({ file, t: metadata.timestamp * 1000 })
  cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {})
})
await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: W, maxHeight: H, everyNthFrame: 1 })
await page.waitForTimeout(500)
await page.evaluate(() => window.__start())
await page.waitForFunction(() => window.__done, null, { timeout: 180000, polling: 500 })
await page.waitForTimeout(300)
await cdp.send('Page.stopScreencast')
const { t0, cues } = await page.evaluate(() => ({ t0: window.__t0, cues: window.__cues }))
await browser.close()

// Video: each frame lasts until the next one, starting at the timeline's t0 (the black frame before it holds).
const first = Math.max(0, shots.findLastIndex((s) => s.t <= t0))
const used = shots.slice(first)
const end = used.at(-1).t + 1000
const list = used.map((s, i) => `file '${s.file}'\nduration ${((Math.min(used[i + 1]?.t ?? end, end) - Math.max(s.t, t0)) / 1000).toFixed(4)}`)
writeFileSync(`${frames}/list.txt`, `${list.join('\n')}\nfile '${used.at(-1).file}'\n`)
const fps = (shots.length / ((shots.at(-1).t - shots[0].t) / 1000)).toFixed(1)
console.log(`${shots.length} frames, ${fps} fps average, ${((end - t0) / 1000).toFixed(1)} s`)
writeFileSync(`${out}/cues.json`, JSON.stringify({ cues, seconds: (end - t0) / 1000 }, null, 2))
}

// Audio: every line at its cue.
const inputs = cues.flatMap((c) => ['-i', `${root}public/demo/${c.id}.mp3`])
const delays = cues.map((c, i) => `[${i + 1}:a]adelay=${c.t}|${c.t}[a${i}]`).join(';')
const mix = `${delays};${cues.map((_, i) => `[a${i}]`).join('')}amix=inputs=${cues.length}:normalize=0,apad=whole_dur=${seconds}[aout];[0:v]fps=30,scale=${W}:${H},format=yuv420p[vout]`
execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', `${frames}/list.txt`, ...inputs, '-filter_complex', mix, '-map', '[vout]', '-map', '[aout]', '-c:v', 'libx264', '-crf', '18', '-preset', 'slow', '-c:a', 'aac', '-b:a', '192k', '-t', String(seconds), `${out}/jarvis-demo.mp4`], { stdio: 'inherit' })
console.log(`wrote ${out}/jarvis-demo.mp4`)
