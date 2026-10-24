import { AssistantLine, Compass, HudShell, JarvisProvider, Renderer, StatusLine, VoiceOrb, jarvisChatLibrary, jarvisLibrary, type JarvisMode } from '@jarvis-ui/kit'
import { useEffect, useRef, useState } from 'react'
import { Loader } from '../../../jarvis-ui/packages/kit/src/components/Loader'
import { DEFAULT_HUD, live, merge } from '../App'
import { Backdrop, type BackdropKind } from './Backdrop'
import DURATIONS from './durations.json'
import { SCRIPT, type Speaker } from './script'

declare global {
  interface Window {
    __start?: () => void
    __cues?: { id: string; t: number }[]
    __done?: boolean
    __t0?: number
  }
}

const durations: Record<string, number> = DURATIONS
// The main page's library with the chat Card and TextContent, which carry sources and inline [n] citations.
const library = jarvisLibrary.extend!({
  components: { override: [jarvisChatLibrary.components.Card, jarvisChatLibrary.components.TextContent] },
}) as typeof jarvisLibrary
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
// ?audio plays the rendered lines too, for screen-recording in a normal browser; ?autostart starts on load;
// ?at=<line id> holds the HUD as it stands when that line starts, for screenshots; ?bg=sky|city puts a view behind it.
const params = new URLSearchParams(location.search)
const bg = params.get('bg') as BackdropKind | null

// The main page's visor, played from the script: the page stays black until __start() (or a click), then the
// default HUD boots and every step runs on the clock of the rendered speech.
export function Demo() {
  const [started, setStarted] = useState(false)
  const [response, setResponse] = useState(() => merge(DEFAULT_HUD, live({ battery: 81 })))
  const [status, setStatus] = useState({ text: 'Standing by', working: false })
  const [mode, setMode] = useState<JarvisMode>('jarvis')
  const [line, setLine] = useState<{ id: string; speaker: Speaker; text: string; ms: number } | null>(null)
  const hud = useRef(response)

  useEffect(() => {
    window.__start = () => setStarted(true)
    if (params.has('autostart')) setStarted(true)
    const at = params.get('at')
    if (!at) return
    for (const step of SCRIPT) {
      if ('line' in step && step.line === at) {
        setLine({ id: step.line, speaker: step.speaker, text: step.text, ms: durations[step.line] })
        break
      }
      if ('edit' in step) setResponse((hud.current = merge(hud.current, step.edit, step.remove)))
      else if ('status' in step) setStatus({ text: step.status, working: !!step.working })
      else if ('theme' in step) setMode(step.theme)
    }
  }, [])

  useEffect(() => {
    if (!started) return
    const t0 = performance.now()
    window.__t0 = performance.timeOrigin + t0
    const cues: { id: string; t: number }[] = (window.__cues = [])
    ;(async () => {
      for (const step of SCRIPT) {
        if ('wait' in step) await sleep(step.wait)
        else if ('edit' in step) setResponse((hud.current = merge(hud.current, step.edit, step.remove)))
        else if ('status' in step) setStatus({ text: step.status, working: !!step.working })
        else if ('theme' in step) setMode(step.theme)
        else {
          const ms = durations[step.line]
          cues.push({ id: step.line, t: Math.round(performance.now() - t0) })
          if (params.has('audio')) new Audio(`/demo/${step.line}.mp3`).play()
          setLine({ id: step.line, speaker: step.speaker, text: step.text, ms })
          await sleep(ms)
          if (step.speaker !== 'user') setLine(null)
        }
      }
      setLine(null)
      window.__done = true
    })()
  }, [started])

  // The backdrop loads behind the black screen, so its tiles are in before the demo starts.
  if (!started && !params.has('at'))
    return (
      <>
        {bg && <Backdrop kind={bg} />}
        <div className="demo-black" onClick={() => setStarted(true)} />
      </>
    )

  const orb = line?.speaker === 'jarvis' ? 'speaking' : line?.speaker === 'user' ? 'listening' : status.working ? 'thinking' : 'idle'
  const caption = line && line.speaker !== 'narrator' ? line : null
  return (
    <>
    {bg && <Backdrop kind={bg} />}
    <div className={bg ? 'app demo-over' : 'app'}>
      <JarvisProvider mode={mode}>
        <HudShell mode={mode} className="frame">
          <div className="visor">
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
              <div className="visor-status demo-status" data-jv-case="sentence">
                {status.working && <Loader variant="rings" size={20} label="" />}
                <StatusLine key={status.text} items={[{ label: status.text }]} size={16} marker={!status.working} />
              </div>
            </header>
            <div className="visor-content">
              <div className="stage">
                <Renderer library={library} response={response} isStreaming={false} />
              </div>
            </div>
            <footer className="visor-bottom demo-bottom">
              {caption && (
                <AssistantLine
                  key={caption.id}
                  className="demo-caption"
                  speaker={caption.speaker === 'jarvis' ? 'jarvis' : 'user'}
                  text={caption.text}
                  charMs={Math.max(12, (caption.ms * 0.85) / caption.text.length)}
                />
              )}
              <VoiceOrb state={orb} size={110} />
            </footer>
          </div>
        </HudShell>
      </JarvisProvider>
    </div>
    </>
  )
}
