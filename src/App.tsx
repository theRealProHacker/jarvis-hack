import { Compass, HudShell, JarvisProvider, Renderer, SIZING, StatusLine, VoiceOrb, jarvisLibrary, jarvisPromptOptions, type JarvisMode } from '@jarvis-ui/kit'
import { domToJpeg } from 'modern-screenshot'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import HEIGHTS from './component-heights.json'
import { record, type Recording } from './voice'

const { card, ...measured } = HEIGHTS
const heights: Record<string, { full: number; third: number }> = measured
const px = ([w, h]: readonly [number, number]) => `${w}×${h}`
// Natural and minimum sizes come from the kit; Card heights were measured by /measure.html. Together they let
// Claude budget space before it builds, so the fit check rarely has to rebuild.
const SYSTEM = `${jarvisLibrary.prompt(jarvisPromptOptions)}

## Component sizes
Outside Orbit, a component renders at its natural size (width×height px) unless you give it a width and height (its last two arguments). "scale" components keep their shape and never shrink below their minimum; "stretch" components fill the width they get. "in a Card" is the measured height of a Card with a CardHeader holding it at full width (1200px) / in a one-third column (390px); an empty Card with a CardHeader is ${card}px. Rows of side-by-side cards take the height of their tallest card; stacked rows add up, plus about 24px between them. Inside Orbit the slot decides the size.
${[...new Set([...Object.keys(SIZING), ...Object.keys(heights)])]
  .map((name) => {
    const size = SIZING[name]
    const inCard = heights[name] && `in a Card ${heights[name].full} / ${heights[name].third}`
    return `${name}: ${[size && `natural ${px(size.natural)}, min ${px(size.min)}, ${size.mode}`, inCard].filter(Boolean).join('; ')}`
  })
  .join('\n')}`

type Event =
  | { type: 'text'; text: string }
  | { type: 'text_end' }
  | { type: 'ui_start'; edit: boolean }
  | { type: 'ui_partial'; program: string }
  | { type: 'ui'; id: string; program: string; edit: boolean; remove: string[] }
  | { type: 'status'; text: string }
  | { type: 'theme'; mode: JarvisMode }
  | { type: 'done' }

declare global {
  interface Window {
    __fit?: { height: number; available: number; fits: boolean }[]
  }
}

// Claude sometimes wraps the program in a code fence; the Renderer wants the bare program.
const unfence = (text: string) => text.replace(/^\s*```[\w-]*\n?/, '').replace(/\n?```\s*$/, '')

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// Enter animations and charts change the height for a moment after streaming ends:
// poll until it holds still for three reads in a row (or 4 s pass).
async function settledHeight(el: HTMLElement) {
  let last = -1
  let stable = 0
  for (let i = 0; i < 20 && stable < 3; i++) {
    await sleep(200)
    const h = el.scrollHeight
    stable = h === last ? stable + 1 : 0
    last = h
  }
  return last
}

// Where the user is, fixed for the demo.
const HOME = { lat: 52.52675, lon: 13.39079, place: 'Linienstraße 144, Berlin' }

// Live readings in the default HUD: the laptop's battery. They refresh as long as the HUD still shows them as
// generated here; once the agent changes them, they are left alone.
type Device = { battery?: number; charging?: boolean }
const live = (d: Device) =>
  [
    `position = Map({lat: ${HOME.lat}, lon: ${HOME.lon}}, 14, [{lat: ${HOME.lat}, lon: ${HOME.lon}, label: "You"}])`,
    `power = Progress(${d.battery ?? 0}, 100, "bar", "${d.charging ? 'Battery charging' : 'Battery'}")`,
  ].join('\n')

// The HUD the page starts with: a Mark VII flight display on simulated readings, laid out like the films'
// helmet cam: big rings bleeding off the corners, the centre left clear. The agent edits it.
const DEFAULT_HUD = `root = Stack([hud])
hud = Orbit({bigTopLeft: radar, bigTopRight: alert, bigLeft: altitude, bigRight: position, bigBottomRight: suit, smallCluster1: clock, smallCluster2: power}, {bigTopLeft: 0.15})
radar = Radar([{angle: 42, dist: 0.62, tone: "danger"}, {angle: 118, dist: 0.35}, {angle: 290, dist: 0.8, tone: "ok"}], 150, "Range 40 km")
alert = AlertPlate("Terrain", "danger", "Pull up")
altitude = Altimeter(12450, "ft", 820, 2000, 2500, 500)
suit = BodyMap("suit", "front", "stand", "xray", true, [{id: "l-forearm", status: "warn", label: "Left gauntlet 71%"}], null, true)
clock = Clock("${Intl.DateTimeFormat().resolvedOptions().timeZone}", "Local", "digital")
${live({})}`

// A program as named statements in order; a statement runs until the next line that starts a new one.
function statements(program: string) {
  const out: [string, string][] = []
  for (const line of program.split('\n')) {
    const name = line.match(/^\s*([A-Za-z_$][\w$]*)\s*=/)?.[1]
    if (name) out.push([name, line])
    else if (out.length) out[out.length - 1][1] += `\n${line}`
  }
  return out
}

// Applies an edit: its statements replace same-named ones (moved to the end, so a statement still
// streaming in is last), and removed names are dropped.
function merge(base: string, edit: string, remove: string[] = []) {
  const all = new Map(statements(base))
  for (const [name, text] of statements(edit)) {
    all.delete(name)
    all.set(name, text)
  }
  for (const name of remove) all.delete(name)
  return [...all.values()].join('\n')
}

// The HUD scrolls inside the frame's content area; the agent's layout has to fit its visible height.
const availableHeight = (stage: HTMLElement) => Math.floor(stage.parentElement!.clientHeight - 8)

export function App() {
  const [prompt, setPrompt] = useState('')
  const [response, setResponse] = useState(DEFAULT_HUD)
  // The program on screen, which edits apply to; `editing` says whether the change streaming in is an edit.
  const hud = useRef(DEFAULT_HUD)
  const editing = useRef(false)
  const [streaming, setStreaming] = useState(false)
  const [runKey, setRunKey] = useState(0)
  const [listening, setListening] = useState(false)
  // The frame around the HUD: a status line the agent sets, and the voice orb.
  const [status, setStatus] = useState('Standing by')
  const [thinking, setThinking] = useState(false)
  const [speaking, setSpeaking] = useState(false)
  const [mode, setMode] = useState<JarvisMode>('jarvis')
  // The orb follows the real audio: the mic while listening, Jarvis's voice while speaking.
  const [mic, setMic] = useState<MediaStream | null>(null)
  const playback = useRef<{ ctx: AudioContext; out: MediaStreamAudioDestinationNode } | null>(null)
  const frame = useRef<HTMLDivElement>(null)
  const stage = useRef<HTMLDivElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)
  // The command bar floats over the HUD, hidden until "/" or push-to-talk opens it; sending or Escape hides it again.
  const [open, setOpen] = useState(false)
  // Spoken replies play one after another; talking again cuts them off.
  const voice = useRef({ queue: Promise.resolve(), playing: new Set<HTMLAudioElement>() })

  // Created on a key press or click: browsers keep audio started outside one silent.
  function unlockPlayback() {
    if (playback.current) return
    const ctx = new AudioContext()
    ctx.resume()
    playback.current = { ctx, out: ctx.createMediaStreamDestination() }
  }

  function speak(text: string) {
    const audio = new Audio(`/api/speak?text=${encodeURIComponent(text)}`)
    const p = playback.current
    // Route the voice through Web Audio only while it runs, so the orb can follow it without muting it.
    if (p?.ctx.state === 'running') {
      const source = p.ctx.createMediaElementSource(audio)
      source.connect(p.ctx.destination)
      source.connect(p.out)
    }
    const v = voice.current
    v.playing.add(audio)
    v.queue = v.queue.then(
      () =>
        new Promise<void>((done) => {
          if (!v.playing.has(audio)) return done()
          audio.onended = audio.onerror = audio.onpause = () => done()
          audio.onplaying = () => {
            setSpeaking(true)
            setThinking(false)
          }
          audio.play().catch(() => done())
        }),
    )
    v.queue.then(() => {
      v.playing.delete(audio)
      if (v.playing.size) return
      setSpeaking(false)
      setThinking(false)
    })
  }

  function hush() {
    voice.current.playing.forEach((a) => a.pause())
    voice.current.playing.clear()
    setSpeaking(false)
  }

  useEffect(() => {
    const typing = (e: KeyboardEvent) => e.target instanceof HTMLInputElement
    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'Space' && (recording.current || !typing(e))) {
        e.preventDefault()
        if (!e.repeat) listen()
      } else if (e.key === 'Escape') {
        input.current?.blur()
        setOpen(false)
      } else if (e.key === '/' && !(e.target instanceof HTMLInputElement)) {
        e.preventDefault()
        setOpen(true)
      }
    }
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || !recording.current) return
      e.preventDefault()
      stopListening()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('keyup', onKeyUp)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('keyup', onKeyUp)
    }
  }, [])

  useEffect(() => {
    if (open) input.current?.focus()
  }, [open])

  // The HUD tilts slowly toward the mouse, up to TILT degrees at the screen edge: as the mouse circles the
  // screen, the HUD's axis sweeps a cone around the centre. The frame and the orb stay put.
  useEffect(() => {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const TILT = 6
    const target = { x: 0, y: 0 }
    const now = { x: 0, y: 0 }
    const onMove = (e: MouseEvent) => {
      target.x = (e.clientX / innerWidth) * 2 - 1
      target.y = (e.clientY / innerHeight) * 2 - 1
    }
    let frame = requestAnimationFrame(function step() {
      now.x += (target.x - now.x) * 0.03
      now.y += (target.y - now.y) * 0.03
      content.current?.style.setProperty('transform', `perspective(1400px) rotateY(${(now.x * TILT).toFixed(2)}deg) rotateX(${(-now.y * TILT).toFixed(2)}deg)`)
      frame = requestAnimationFrame(step)
    })
    addEventListener('mousemove', onMove)
    return () => {
      cancelAnimationFrame(frame)
      removeEventListener('mousemove', onMove)
    }
  }, [])

  const [device, setDevice] = useState<Device>({})
  const deviceRef = useRef(device)
  // The readings the live statements on screen were last generated from.
  const liveShown = useRef<Device>({})
  deviceRef.current = device
  useEffect(() => {
    const poll = () =>
      fetch('/api/device')
        .then((r) => r.json())
        .then(({ battery }) => setDevice({ battery: battery?.percent, charging: battery?.charging }))
        .catch(() => {})
    poll()
    const timer = setInterval(poll, 60000)
    return () => clearInterval(timer)
  }, [])
  useEffect(() => {
    // Refresh only the live statements the HUD still shows as generated here (the agent may have changed them,
    // e.g. drawn a route on the position map), and not while a change is streaming in.
    const shown = new Map(statements(hud.current))
    const update = statements(live(device)).filter(([n]) => shown.get(n) === statements(live(liveShown.current)).find(([m]) => m === n)?.[1])
    if (!update.length || streaming) return
    const next = merge(hud.current, update.map(([, text]) => text).join('\n'))
    liveShown.current = device
    if (next === hud.current) return
    hud.current = next
    setResponse(next)
  }, [device, streaming])

  useEffect(() => {
    // Starts the agent session now, so the first question doesn't wait for it (and its MCP servers) to boot.
    fetch('/api/say', { method: 'POST', body: JSON.stringify({ system: SYSTEM }) })
    let said = ''
    const events = new EventSource('/api/events')
    events.onmessage = async (msg) => {
      const e: Event = JSON.parse(msg.data)
      if (e.type === 'text') {
        said += e.text
        // Each finished sentence goes to the voice right away, so speech starts while the rest streams in.
        const done = said.match(/^[^]*[.!?](?=\s+\S)/)?.[0]
        if (done) {
          speak(done.trim())
          said = said.slice(done.length)
        }
      } else if (e.type === 'text_end') {
        if (said.trim()) speak(said.trim())
        said = ''
      } else if (e.type === 'ui_start') {
        editing.current = e.edit
        // A new HUD starts from scratch; an edit keeps the panels on screen and changes them in place.
        if (!e.edit) {
          setRunKey((k) => k + 1)
          setResponse('')
        }
        setStreaming(true)
      } else if (e.type === 'ui_partial') setResponse(editing.current ? merge(hud.current, unfence(e.program)) : unfence(e.program))
      else if (e.type === 'status') setStatus(e.text)
      else if (e.type === 'theme') setMode(e.mode)
      // A reply still waiting for its audio keeps the orb thinking until it starts to play.
      else if (e.type === 'done' && !voice.current.playing.size) setThinking(false)
      else if (e.type === 'ui') {
        hud.current = e.edit ? merge(hud.current, unfence(e.program), e.remove) : unfence(e.program)
        setResponse(hud.current)
        setStreaming(false)
        // Report the rendered height back to the agent, which rebuilds the HUD if it overflows.
        const el = stage.current!
        const available = availableHeight(el)
        const height = await settledHeight(el)
        // List items and charts animate in after the height settles; give them a moment before the screenshot.
        await sleep(1500)
        ;(window.__fit ??= []).push({ height, available, fits: height <= available })
        // A screenshot of the whole screen goes back too, so the agent can check its work and refer to it later.
        const screenshot = await domToJpeg(frame.current!, { scale: 0.6, quality: 0.7 })
          .then((url) => url.slice(url.indexOf(',') + 1))
          .catch((err) => (console.error(err), undefined))
        fetch('/api/ui-result', { method: 'POST', body: JSON.stringify({ id: e.id, height, available, width: el.clientWidth, screenshot }) })
      }
    }
    return () => events.close()
  }, [])

  function send(text: string) {
    if (!text.trim()) return
    setOpen(false)
    setPrompt('')
    setThinking(true)
    const el = stage.current!
    const available = availableHeight(el)
    const now = new Date()
    const d = deviceRef.current
    const where = ` The user is at ${HOME.place} (${HOME.lat}, ${HOME.lon}).`
    const power = d.battery == null ? '' : ` Battery ${d.battery}%${d.charging ? ', charging' : ''}.`
    const context = `It is ${now.toLocaleString('en-GB', { dateStyle: 'full', timeStyle: 'short' })} (time zone ${Intl.DateTimeFormat().resolvedOptions().timeZone}).${where}${power} The HUD is shown on a screen area of ${el.clientWidth}×${available}px and must fit without scrolling.`
    const current = `Current HUD program:\n${hud.current}`
    fetch('/api/say', { method: 'POST', body: JSON.stringify({ system: SYSTEM, text: `${text}\n\n(${context})\n\n${current}` }) })
  }

  // Push-to-talk: hold Space (or press Talk, then Stop). The orb shows that Jarvis is listening; the bar stays hidden.
  const recording = useRef<Promise<Recording | null> | null>(null)

  function listen() {
    if (recording.current) return
    unlockPlayback()
    hush()
    setPrompt('')
    setListening(true)
    recording.current = record(setPrompt).then(
      (rec) => (setMic(rec.stream), rec),
      (err) => (console.error(err), null),
    )
  }

  async function stopListening() {
    const pending = recording.current
    if (!pending) return
    recording.current = null
    setListening(false)
    setMic(null)
    const rec = await pending
    if (rec) send(await rec.stop())
  }

  return (
    <div className="app">
      <form
        className="command"
        data-open={open}
        inert={!open}
        onSubmit={(e: FormEvent) => {
          e.preventDefault()
          unlockPlayback()
          send(prompt)
        }}
      >
        <input value={prompt} onChange={(e) => setPrompt(e.target.value)} ref={input} placeholder="Ask Jarvis" aria-label="Command" />
        <button type="button" className="mic" onClick={() => (recording.current ? stopListening() : listen())} aria-pressed={listening}>
          {listening ? 'Stop' : 'Talk'}
        </button>
        <button type="submit" disabled={listening}>
          Send
        </button>
      </form>
      <JarvisProvider mode={mode}>
        <HudShell mode={mode} className="frame">
          {/* Helmet visor after the Avengers Mk VII HUD: compass arc on top, curved rims, voice orb below. */}
          <div className="visor" ref={frame}>
            <svg className="visor-rims" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden>
              <path d="M 4 6 Q 0.6 50 4 94" />
              <path d="M 6 14 Q 3.4 50 6 86" className="thin" />
              <path d="M 96 6 Q 99.4 50 96 94" />
              <path d="M 94 14 Q 96.6 50 94 86" className="thin" />
              <path d="M 30 98.2 Q 50 100 70 98.2" className="thin" />
            </svg>
            <header className="visor-top">
              <div className="visor-compass">
                <Compass heading={0} r={420} arc={50} readout={false} />
              </div>
              <div className="visor-status" data-jv-case="sentence">
                <StatusLine key={status} items={[{ label: status }]} size={16} marker />
              </div>
            </header>
            <div className="visor-content" ref={content}>
              <div className="stage" ref={stage}>
                <Renderer key={runKey} library={jarvisLibrary} response={response} isStreaming={streaming} />
              </div>
            </div>
            <footer className="visor-bottom">
              <VoiceOrb
                state={listening ? 'listening' : speaking ? 'speaking' : thinking ? 'thinking' : 'idle'}
                stream={listening ? mic : speaking && playback.current?.ctx.state === 'running' ? playback.current.out.stream : null}
                size={110}
              />
            </footer>
          </div>
        </HudShell>
      </JarvisProvider>
    </div>
  )
}
