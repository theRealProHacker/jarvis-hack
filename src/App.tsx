import { Renderer } from '@openuidev/react-lang'
import { JarvisProvider, jarvisLibrary, jarvisPromptOptions } from '@jarvis-ui/kit'
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
const MAX_REBUILDS = 2

type Message = { role: 'user' | 'assistant'; content: string }

declare global {
  interface Window {
    __fit?: { attempt: number; height: number; available: number; fits: boolean }[]
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
  const [busy, setBusy] = useState(false)
  const [runKey, setRunKey] = useState(0)
  const [listening, setListening] = useState(false)
  const recording = useRef<Recording | null>(null)
  const stage = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)
  // The command bar floats over the HUD: it hides once a build starts, "/" brings it back and Escape hides it.
  const [open, setOpen] = useState(true)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        input.current?.blur()
        setOpen(false)
      } else if (e.key === '/' && !(e.target instanceof HTMLInputElement)) {
        e.preventDefault()
        setOpen(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    if (open) input.current?.focus()
  }, [open])

  async function generate(messages: Message[]) {
    setRunKey((k) => k + 1)
    setResponse('')
    setStreaming(true)
    let text = ''
    try {
      const res = await fetch('/api/generate', { method: 'POST', body: JSON.stringify({ system: SYSTEM, messages }) })
      const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        text += value
        setResponse(unfence(text))
      }
    } finally {
      setStreaming(false)
    }
    return text
  }

  async function talk() {
    if (recording.current) {
      const rec = recording.current
      recording.current = null
      setListening(false)
      const text = await rec.stop()
      setPrompt(text)
      await build(text)
      return
    }
    setPrompt('')
    setListening(true)
    try {
      recording.current = await record(setPrompt)
    } catch (err) {
      console.error(err)
      setListening(false)
    }
  }

  async function build(prompt: string) {
    if (!prompt.trim() || busy) return
    setBusy(true)
    setOpen(false)
    window.__fit = []
    try {
      const el = stage.current!
      const available = Math.floor(window.innerHeight - el.getBoundingClientRect().top - 24)
      const messages: Message[] = [
        { role: 'user', content: `${prompt}\n\nThe HUD is shown on a screen area of ${el.clientWidth}×${available}px and must fit without scrolling.` },
      ]
      for (let attempt = 0; ; attempt++) {
        messages.push({ role: 'assistant', content: await generate(messages) })
        const height = await settledHeight(el)
        const fits = height <= available
        window.__fit.push({ attempt, height, available, fits })
        if (fits || attempt === MAX_REBUILDS) break
        messages.push({
          role: 'user',
          content: `That layout renders ${height}px tall but the screen only has ${available}px (width ${el.clientWidth}px). Rebuild it so everything fits without scrolling: fewer or smaller panels, side-by-side rows, shorter charts and tables. Keep what matters most for the original request.`,
        })
      }
    } finally {
      setPrompt('')
      setBusy(false)
    }
  }

  return (
    <div className="app">
      <form
        className="command"
        data-open={open}
        inert={!open}
        onSubmit={(e: FormEvent) => {
          e.preventDefault()
          build(prompt)
        }}
      >
        <input value={prompt} onChange={(e) => setPrompt(e.target.value)} ref={input} placeholder="Describe your HUD" aria-label="Command" />
        <button type="button" className="mic" onClick={talk} disabled={busy} aria-pressed={listening}>
          {listening ? 'Stop' : 'Talk'}
        </button>
        <button type="submit" disabled={busy || listening}>
          {busy ? 'Building' : 'Build'}
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
