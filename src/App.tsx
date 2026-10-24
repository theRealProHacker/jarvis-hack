import { Renderer } from '@openuidev/react-lang'
import { JarvisProvider, jarvisLibrary, jarvisPromptOptions } from '@jarvis-ui/kit'
import { useState, type FormEvent } from 'react'

const SYSTEM = jarvisLibrary.prompt(jarvisPromptOptions)

// Claude sometimes wraps the program in a code fence; the Renderer wants the bare program.
const unfence = (text: string) => text.replace(/^\s*```[\w-]*\n?/, '').replace(/\n?```\s*$/, '')

export function App() {
  const [prompt, setPrompt] = useState('')
  const [response, setResponse] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [runKey, setRunKey] = useState(0)

  async function build(e: FormEvent) {
    e.preventDefault()
    if (!prompt.trim() || streaming) return
    setRunKey((k) => k + 1)
    setResponse('')
    setStreaming(true)
    try {
      const res = await fetch('/api/generate', { method: 'POST', body: JSON.stringify({ system: SYSTEM, prompt }) })
      const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader()
      let text = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        text += value
        setResponse(unfence(text))
      }
    } finally {
      setStreaming(false)
    }
  }

  return (
    <div className="app">
      <form className="command" onSubmit={build}>
        <input value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Describe your HUD" aria-label="Command" autoFocus />
        <button type="submit" disabled={streaming}>
          {streaming ? 'Building' : 'Build'}
        </button>
      </form>
      <JarvisProvider mode="jarvis">
        <div className="stage">
          <Renderer key={runKey} library={jarvisLibrary} response={response} isStreaming={streaming} />
        </div>
      </JarvisProvider>
    </div>
  )
}
