import { JarvisProvider, Renderer, jarvisLibrary, jarvisPromptOptions } from '@jarvis-ui/kit'
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
  | { type: 'ui_start' }
  | { type: 'ui_partial'; program: string }
  | { type: 'ui'; id: string; program: string }
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

export function App() {
  const [prompt, setPrompt] = useState('')
  const [response, setResponse] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [runKey, setRunKey] = useState(0)
  const [listening, setListening] = useState(false)
  const stage = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)
  // The command bar floats over the HUD, hidden until "/" or push-to-talk opens it; sending or Escape hides it again.
  const [open, setOpen] = useState(false)
  // Spoken replies play one after another; talking again cuts them off.
  const voice = useRef({ queue: Promise.resolve(), playing: new Set<HTMLAudioElement>() })

  function speak(text: string) {
    const audio = new Audio(`/api/speak?text=${encodeURIComponent(text)}`)
    const v = voice.current
    v.playing.add(audio)
    v.queue = v.queue.then(
      () =>
        new Promise<void>((done) => {
          if (!v.playing.has(audio)) return done()
          audio.onended = audio.onerror = audio.onpause = () => done()
          audio.play().catch(() => done())
        }),
    )
    v.queue.then(() => v.playing.delete(audio))
  }

  function hush() {
    voice.current.playing.forEach((a) => a.pause())
    voice.current.playing.clear()
  }

  useEffect(() => {
    const typing = (e: KeyboardEvent) => e.target instanceof HTMLInputElement
    const onKey = (e: KeyboardEvent) => {
      // Opening the bar focuses the input, so Space held from there on still belongs to push-to-talk.
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
        setRunKey((k) => k + 1)
        setResponse('')
        setStreaming(true)
      } else if (e.type === 'ui_partial') setResponse(unfence(e.program))
      else if (e.type === 'ui') {
        setResponse(unfence(e.program))
        setStreaming(false)
        // Report the rendered height back to the agent, which rebuilds the HUD if it overflows.
        const el = stage.current!
        const available = Math.floor(window.innerHeight - el.getBoundingClientRect().top - 24)
        const height = await settledHeight(el)
        ;(window.__fit ??= []).push({ height, available, fits: height <= available })
        fetch('/api/ui-result', { method: 'POST', body: JSON.stringify({ id: e.id, height, available, width: el.clientWidth }) })
      }
    }
    return () => events.close()
  }, [])

  function send(text: string) {
    if (!text.trim()) return
    setOpen(false)
    setPrompt('')
    const el = stage.current!
    const available = Math.floor(window.innerHeight - el.getBoundingClientRect().top - 24)
    const now = new Date()
    const context = `It is ${now.toLocaleString('en-GB', { dateStyle: 'full', timeStyle: 'short' })} (time zone ${Intl.DateTimeFormat().resolvedOptions().timeZone}). The HUD is shown on a screen area of ${el.clientWidth}×${available}px and must fit without scrolling.`
    fetch('/api/say', { method: 'POST', body: JSON.stringify({ system: SYSTEM, text: `${text}\n\n(${context})` }) })
  }

  // Push-to-talk: hold Space (or press Talk, then Stop). While listening, the command bar shows the live transcript.
  const recording = useRef<Promise<Recording | null> | null>(null)

  function listen() {
    if (recording.current) return
    hush()
    setPrompt('')
    setOpen(true)
    setListening(true)
    recording.current = record(setPrompt).catch((err) => {
      console.error(err)
      return null
    })
  }

  async function stopListening() {
    const pending = recording.current
    if (!pending) return
    recording.current = null
    setListening(false)
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
      <JarvisProvider mode="jarvis">
        <div className="stage" ref={stage}>
          <Renderer key={runKey} library={jarvisLibrary} response={response} isStreaming={streaming} />
        </div>
      </JarvisProvider>
    </div>
  )
}
