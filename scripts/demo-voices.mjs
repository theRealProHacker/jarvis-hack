// Renders every spoken line of the demo script with ElevenLabs into public/demo/<id>.mp3 and writes the lengths
// (ms) to src/demo/durations.json. Lines whose text and voice haven't changed are kept.
// Run: node --experimental-strip-types scripts/demo-voices.mjs
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { SCRIPT, VOICES } from '../src/demo/script.ts'

const root = new URL('..', import.meta.url).pathname
const env = Object.fromEntries(readFileSync(`${root}.env`, 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]))
const out = `${root}public/demo`
mkdirSync(out, { recursive: true })
const manifestPath = `${out}/manifest.json`
const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : {}
const durations = {}

for (const step of SCRIPT) {
  if (!('line' in step)) continue
  const voice = VOICES[step.speaker]
  const key = `${voice}:${step.text}`
  const file = `${out}/${step.line}.mp3`
  if (manifest[step.line] !== key || !existsSync(file)) {
    const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice}?output_format=mp3_44100_128`, {
      method: 'POST',
      headers: { 'xi-api-key': env.ELEVENLABS_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: step.text, model_id: 'eleven_multilingual_v2', voice_settings: { stability: 0.45, similarity_boost: 0.8, style: 0.15 } }),
    })
    if (!r.ok) throw new Error(`${step.line}: ${r.status} ${await r.text()}`)
    writeFileSync(file, Buffer.from(await r.arrayBuffer()))
    manifest[step.line] = key
    console.log('rendered', step.line)
  }
  const seconds = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8' })
  durations[step.line] = Math.round(+seconds * 1000)
}

writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
writeFileSync(`${root}src/demo/durations.json`, JSON.stringify(durations, null, 2) + '\n')
const total = SCRIPT.reduce((t, s) => t + ('line' in s ? durations[s.line] : 'wait' in s ? s.wait : 0), 0)
console.log(durations, `total ${(total / 1000).toFixed(1)} s`)
