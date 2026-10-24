import { JarvisProvider, Renderer, jarvisLibrary, jarvisPromptOptions } from '@jarvis-ui/kit'
import { useEffect, useState } from 'react'

/*
 * /measure.html (dev only): measures how tall each kit component renders, for the height table in
 * src/component-heights.json. Claude writes one sample program per component, every sample renders at
 * full width and in a one-third column, and the settled heights land on window.__heights.
 * ?only=Clock,Map measures just those; components with a handwritten sample below need no Claude call.
 */

const SYSTEM = jarvisLibrary.prompt(jarvisPromptOptions)
export const WIDTHS = { full: 1200, third: 390 } as const

// Only make sense inside a parent (sampled through it), or are the frame every sample already uses.
const SKIP = new Set(
  'Card CardHeader Stack Modal Series Col Slice ScatterSeries Point SelectItem CheckBoxItem RadioItem SwitchItem OptionCard TabItem AccordionItem StepsItem ListItem SnippetCardItem OverviewCardItem ContextCardItem CompositeCardItem VisualCardItem Label FormControl Input TextArea Select DatePicker Slider CheckBoxGroup RadioGroup SwitchGroup Button IconButton'.split(' '),
)
const only = new URLSearchParams(location.search).get('only')?.split(',')
const NAMES = Object.keys(jarvisLibrary.components).filter((n) => !SKIP.has(n) && (!only || only.includes(n)))
const frame = (sample: string) => `root = Stack([card])\ncard = Card([head, sample])\nhead = CardHeader("Title", "Subtitle")\nsample = ${sample}`
const HANDWRITTEN: Record<string, string> = {
  Clock: frame('Clock("Europe/Berlin", "Berlin")'),
  Map: frame('Map({lat: 52.52, lon: 13.405}, 11, [{lat: 52.5163, lon: 13.3777, label: "Brandenburg Gate"}, {lat: 52.5208, lon: 13.4094, label: "TV Tower"}])'),
}
const BASELINE = 'root = Stack([card])\ncard = Card([head])\nhead = CardHeader("Title", "Subtitle")'

const unfence = (text: string) => text.replace(/^\s*```[\w-]*\n?/, '').replace(/\n?```\s*$/, '')
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function samples(names: string[]): Promise<Record<string, string>> {
  const content = `For each component below, write one minimal OpenUI Lang program: root = Stack([card]), card = Card([head, sample]), head = CardHeader("Title", "Subtitle"), and sample uses that component once with typical, realistic data (a normal amount, not the minimum or maximum). Components that only work inside a parent go inside their natural parent. Reply with only a JSON object mapping each component name to its program string.\n\n${names.join(', ')}`
  const res = await fetch('/api/generate', { method: 'POST', body: JSON.stringify({ system: SYSTEM, messages: [{ role: 'user', content }] }) })
  return JSON.parse(unfence(await res.text()))
}

declare global {
  interface Window {
    __heights?: { programs: Record<string, string>; heights: Record<string, { full: number; third: number }> }
  }
}

export function Measure() {
  const [programs, setPrograms] = useState<Record<string, string> | null>(null)

  useEffect(() => {
    const written = NAMES.filter((n) => !HANDWRITTEN[n])
    const batches = Array.from({ length: Math.ceil(written.length / 15) }, (_, i) => written.slice(i * 15, i * 15 + 15))
    const hand = Object.fromEntries(NAMES.filter((n) => HANDWRITTEN[n]).map((n) => [n, HANDWRITTEN[n]]))
    Promise.all(batches.map(samples)).then((all) => setPrograms({ _card: BASELINE, ...hand, ...Object.assign({}, ...all) }))
  }, [])

  useEffect(() => {
    if (!programs) return
    ;(async () => {
      // Every sample renders at once; poll until no height changes for three reads in a row.
      const read = () => {
        const out: Record<string, { full: number; third: number }> = {}
        for (const el of document.querySelectorAll<HTMLElement>('[data-sample]')) {
          const name = el.dataset.sample!
          out[name] = { ...out[name]!, [el.dataset.width!]: el.scrollHeight }
        }
        return JSON.stringify(out)
      }
      let last = ''
      for (let stable = 0, i = 0; stable < 3 && i < 40; i++) {
        await sleep(500)
        const now = read()
        stable = now === last ? stable + 1 : 0
        last = now
      }
      window.__heights = { programs, heights: JSON.parse(last) }
    })()
  }, [programs])

  if (!programs) return <p className="app">Writing samples…</p>
  return (
    <JarvisProvider mode="jarvis">
      <div style={{ display: 'grid', gap: 24, padding: 16 }}>
        {Object.entries(programs).map(([name, program]) =>
          Object.entries(WIDTHS).map(([key, width]) => (
            <div key={name + key} data-sample={name} data-width={key} style={{ width }}>
              <Renderer library={jarvisLibrary} response={program} isStreaming={false} />
            </div>
          )),
        )}
      </div>
    </JarvisProvider>
  )
}
