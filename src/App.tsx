import { Compass, HudShell, JarvisProvider, Renderer, StatusLine, VoiceOrb, jarvisLibrary, jarvisPromptOptions, type JarvisMode } from '@jarvis-ui/kit'
import { domToJpeg } from 'modern-screenshot'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import HEIGHTS from './component-heights.json'
import { record, type Recording } from './voice'

const { card, ...heights } = HEIGHTS
// Measured by /measure.html: lets Claude budget pixels before it builds, so the fit check rarely has to rebuild.
const SYSTEM = `${jarvisLibrary.prompt(jarvisPromptOptions)}

## Rendered heights
Measured height in px of a Card with a CardHeader holding one component with typical data, at full width (1200px) / in a one-third column (390px). An empty Card with a CardHeader is ${card}px. Rows of side-by-side cards take the height of their tallest card; stacked rows add up, plus about 24px between them.
${Object.entries(heights)
  .map(([name, h]) => `${name}: ${h.full} / ${h.third}`)
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

// The HUD the page starts with; the agent edits it from there.
const DEFAULT_HUD = `root = Stack([row])
row = Stack([clockCard], "row")
clockCard = Card([clockHead, clock])
clockHead = CardHeader("Local time")
clock = Clock("${Intl.DateTimeFormat().resolvedOptions().timeZone}")`

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

  useEffect(() => {
    let said = ''
    const events = new EventSource('/api/events')
    events.onmessage = async (msg) => {
      const e: Event = JSON.parse(msg.data)
      if (e.type === 'text') said += e.text
      else if (e.type === 'text_end') {
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
    const context = `It is ${now.toLocaleString('en-GB', { dateStyle: 'full', timeStyle: 'short' })} (time zone ${Intl.DateTimeFormat().resolvedOptions().timeZone}). The HUD is shown on a screen area of ${el.clientWidth}×${available}px and must fit without scrolling.`
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
            <div className="visor-content">
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
