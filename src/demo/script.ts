// The two-minute demo as a fixed script: who speaks, what they say, and what the HUD does around it.
// scripts/demo-voices.mjs renders every line to public/demo/<id>.mp3 and writes their lengths to durations.json;
// the page plays the steps back on that clock and scripts/demo-record.mjs records it.
import type { JarvisMode } from '@jarvis-ui/kit'

export type Speaker = 'narrator' | 'user' | 'jarvis'

export type Step =
  | { line: string; speaker: Speaker; text: string }
  | { edit: string; remove?: string[] }
  | { status: string; working?: boolean }
  | { theme: JarvisMode }
  | { wait: number }

export const VOICES: Record<Speaker, string> = {
  narrator: 'nPczCjzI2devNBz1zQrb',
  user: 'nPczCjzI2devNBz1zQrb',
  jarvis: 'mMc1jJdsmogeUDdTvGEf',
}

const YOU = '{lat: 52.52675, lon: 13.39079, label: "You"}'
const GATE = '{lat: 52.51628, lon: 13.3777, label: "Brandenburg Gate"}'

// Alphabet's closes over the last month (Yahoo Finance, 24 Sep to 23 Oct 2026).
const GOOGL: [string, number][] = [
  ['24 Sep', 342.36], ['25 Sep', 343.92], ['28 Sep', 342.75], ['29 Sep', 340.92], ['30 Sep', 344.08], ['1 Oct', 338.24],
  ['2 Oct', 343.5], ['5 Oct', 346.47], ['6 Oct', 347.68], ['7 Oct', 350.5], ['8 Oct', 348.29], ['9 Oct', 351.66],
  ['12 Oct', 352.72], ['13 Oct', 353.78], ['14 Oct', 347.64], ['15 Oct', 349.22], ['16 Oct', 340.59], ['19 Oct', 344.18],
  ['20 Oct', 340.28], ['21 Oct', 334.76], ['22 Oct', 324.22], ['23 Oct', 320.21],
]

const working = (status: string): Step => ({ status, working: true })
const idle: Step = { status: 'Standing by' }

// The Orbit statement for a set of slots; the extra slots come last.
const orbit = (slots: Record<string, string>, extra: Record<string, string> = {}) =>
  `hud = Orbit({${Object.entries({ ...slots, ...extra }).map(([k, v]) => `${k}: ${v}`).join(', ')}})`
const BASE = { bigTopLeft: 'radar', bigLeft: 'altitude', bigRight: 'position', bigBottomRight: 'suit', smallCluster1: 'clock', smallCluster2: 'power', smallTop: 'timer' }
const STOCK = { ...BASE, bigTopLeft: 'stock', smallBottom: 'market' }
const FIRMWARE = { ...STOCK, bigTopRight: 'news', bigBottomRight: 'weather', smallCluster1: 'download' }

// What the agent's tools are doing, as a step list in the middle; `active` past the last step marks all done.
const steps = (items: [string, string][], active: number) =>
  `activity = Steps([${items.map(([t, d]) => `StepsItem("${t}", "${d}")`).join(', ')}], ${active})`
const browser = (active: number) =>
  steps([['Read marketbeat.com', 'Analyst downgrade'], ['Read tradersunion.com', 'Earnings date'], ['Cite two sources', 'News, top right']], active)
const firmware = (active: number) => steps([['Download mk8.fw', '`firmware/mk8.fw`'], ['Run diagnostics', 'Five thrusters']], active)
const search = (active: number) =>
  steps([['Search ~/suit', '`rg -n left_boot ~/suit`'], ['1 match in 214 files', '`thrusters.toml:12  left_boot = 0.78`'], ['Open thrusters.toml', 'Line 12']], active)

export const SCRIPT: Step[] = [
  { wait: 1000 },
  { line: 'n1', speaker: 'narrator', text: 'Every AI assistant gets measured against one benchmark: Jarvis.' },
  { wait: 400 },
  {
    line: 'n2',
    speaker: 'narrator',
    text: 'So I built one that behaves like the original. It talks, and Claude builds the interface live. The hard part was keeping the agent on theme: real HUD components only, never a generic web page.',
  },
  { wait: 600 },

  // A two-minute countdown along the top.
  { line: 'u1', speaker: 'user', text: 'Jarvis, put two minutes on the clock.' },
  working('Setting a timer'),
  { wait: 500 },
  {
    edit: `hud = Orbit({bigTopLeft: radar, bigLeft: altitude, bigRight: position, bigBottomRight: suit, smallCluster1: clock, smallCluster2: power, smallTop: timer})
timer = Timecode(100000, true, true, "mm:ss")`,
  },
  idle,
  { line: 'j1', speaker: 'jarvis', text: 'Two minutes, sir. The countdown is up top.' },
  { wait: 400 },

  // Flying, so the course is a straight line on the position map.
  { line: 'u2', speaker: 'user', text: 'Plot a course to the Brandenburg Gate.' },
  working('Plotting a course'),
  { wait: 500 },
  { edit: `position = Map(null, null, [${YOU}, ${GATE}], [${YOU}, ${GATE}])` },
  idle,
  { line: 'j2', speaker: 'jarvis', text: "Brandenburg Gate is one point five kilometres south-west, heading two one seven. It's on your map." },
  { wait: 400 },

  // An area chart where the radar was and a market strip along the bottom.
  { line: 'u3', speaker: 'user', text: "How's Alphabet doing?" },
  working('Fetching quotes'),
  { wait: 700 },
  {
    edit: `${orbit(STOCK)}
stock = AreaChart([${GOOGL.map(([d]) => `"${d}"`).join(', ')}], [Series("GOOGL", [${GOOGL.map(([, v]) => v).join(', ')}])])
market = Ticker([{label: "GOOGL", value: 320.21, delta: -1.24, deltaUnit: "%"}, {label: "NVDA", value: 210.96, delta: -0.59, deltaUnit: "%"}, {label: "AAPL", value: 347.73, delta: -0.14, deltaUnit: "%"}, {label: "MSFT", value: 524.51, delta: 0.66, deltaUnit: "%"}])`,
    remove: ['radar'],
  },
  idle,
  {
    line: 'j3',
    speaker: 'jarvis',
    text: "Alphabet closed at three hundred and twenty dollars, down five percent this month. Chart's top left.",
  },
  { wait: 400 },

  // The browser: the pages it reads show in the middle, then a summary with numbered citations top right.
  { line: 'u4', speaker: 'user', text: 'Why is it down? Check the news.' },
  working('Browsing marketbeat.com'),
  { edit: browser(1) },
  { wait: 1100 },
  working('Browsing tradersunion.com'),
  { edit: browser(2) },
  { wait: 1100 },
  {
    edit: `${orbit(STOCK, { bigTopRight: 'news', center: 'activity' })}
${browser(4)}
news = Card([newsText], [{title: "Alphabet stock down 1.2% after analyst downgrade", sourceName: "MarketBeat", url: "https://www.marketbeat.com/instant-alerts/price-alphabet-nasdaq-googl-stock-price-down-12-following-analyst-downgrade-2026-10-23/"}, {title: "Alphabet slips 0.24% to USD 323.44", sourceName: "Traders Union", url: "https://tradersunion.com/news/stocks/show/3945313-alphabet-slips-0-24percent-to-usd323-44/"}])
newsText = TextContent("Citizens JMP cut its target to $450 [1]. The AI sell-off is pulling it toward its 200-day average [1]. Q3 earnings land on 28 Oct [2].")`,
  },
  idle,
  {
    line: 'j4',
    speaker: 'jarvis',
    text: 'MarketBeat says Citizens JMP cut its target to four hundred and fifty dollars, and the AI sell-off is weighing on it. Earnings are on the twenty-eighth. Sources, top right.',
  },
  { wait: 400 },

  // Weather where the suit diagnostic was; the middle clears again.
  { line: 'u5', speaker: 'user', text: "Weather for tonight's flight?" },
  working('Checking the weather'),
  { wait: 600 },
  {
    edit: `${orbit(STOCK, { bigTopRight: 'news', bigBottomRight: 'weather' })}
weather = Weather({lat: 52.52675, lon: 13.39079}, "Berlin", "metric", 3, "current", {temp: 9.6, feelsLike: 6.5, humidity: 81, wind: 15, code: 3})`,
    remove: ['suit', 'activity'],
  },
  idle,
  { line: 'j5', speaker: 'jarvis', text: 'Berlin is overcast, ten degrees, wind fifteen kilometres an hour. Fine for flying. Lower right.' },
  { wait: 400 },

  // A download with a progress bar, then a bar chart of thruster output.
  { line: 'u6', speaker: 'user', text: 'Download the Mark Eight firmware and run a diagnostic.' },
  working('Downloading firmware'),
  { wait: 400 },
  {
    edit: `${orbit(FIRMWARE, { center: 'activity' })}
${firmware(1)}
download = Progress(8, 100, "segments", "Firmware Mark 8")`,
    remove: ['clock'],
  },
  { wait: 900 },
  { edit: 'download = Progress(41, 100, "segments", "Firmware Mark 8")' },
  { wait: 900 },
  { edit: 'download = Progress(77, 100, "segments", "Firmware Mark 8")' },
  { wait: 900 },
  working('Running diagnostics'),
  { edit: `download = Progress(100, 100, "segments", "Firmware Mark 8", null, "ok")\n${firmware(2)}` },
  { wait: 900 },
  {
    edit: `${orbit({ ...FIRMWARE, bigLeft: 'thrusters' }, { center: 'activity' })}
${firmware(3)}
thrusters = BarChart(["L boot", "R boot", "L palm", "R palm", "Back"], [Series("Output %", [78, 94, 96, 93, 97])])`,
    remove: ['altitude'],
  },
  idle,
  { line: 'j6', speaker: 'jarvis', text: 'Firmware is in. Every thruster is above ninety percent, except the left boot at seventy-eight.' },
  { wait: 400 },

  // The file system: ripgrep through the suit's config, each step ticking off as it runs.
  { line: 'u8', speaker: 'user', text: 'Find where I set the left boot.' },
  working('Searching ~/suit'),
  { edit: search(1) },
  { wait: 800 },
  { edit: search(2) },
  { wait: 800 },
  working('Opening thrusters.toml'),
  { edit: search(3) },
  { wait: 800 },
  { edit: search(4) },
  idle,
  { line: 'j8', speaker: 'jarvis', text: 'Found it. Line twelve of thrusters dot toml caps the left boot at seventy-eight percent.' },
  { wait: 400 },

  // Battle mode: red theme, a large reticle in the middle, targets, systems and the mode dock.
  { line: 'u7', speaker: 'user', text: 'Jarvis, battle mode.' },
  { theme: 'battle' },
  { status: 'Combat mode' },
  { wait: 300 },
  {
    edit: `${orbit({ ...FIRMWARE, bigLeft: 'thrusters', bigTopRight: 'systems', bigBottomRight: 'targets' }, { smallInnerBottom: 'modes', center: 'reticle' })}
reticle = Reticle("mk7", 440, true)
systems = SystemStatus([{name: "Repulsors", value: 92}, {name: "Shields", value: 88, tone: "ok"}, {name: "Flight", value: 97}, {name: "Weapons", value: 100, tone: "ok"}], "Systems")
targets = TargetLock([{x: 0.28, y: 0.4, label: "T1", locked: true}, {x: 0.62, y: 0.3, label: "T2", locked: true}, {x: 0.72, y: 0.7, label: "T3", locked: true}], "Targets")
modes = Dock([{label: "Targeting", icon: "targeting"}, {label: "Radar", icon: "radar"}, {label: "Shield", icon: "shield"}, {label: "Power", icon: "power"}], "Targeting")`,
    remove: ['news', 'weather', 'activity'],
  },
  { line: 'j7', speaker: 'jarvis', text: 'Combat mode. Reticle is up, three targets locked, shields holding.' },
  { wait: 700 },

  {
    line: 'n3',
    speaker: 'narrator',
    text: "Jarvis is just the costume for a hackathon. The point is generative UI in your own theme: an interface that rebuilds itself around whoever sits in front of it. Run it for yourself, or build it into your product. People are reverse-engineering SaaS tools to personalize them, and it's killing those companies. This could save them.",
  },
  { wait: 800 },
]
