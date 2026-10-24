/*
 * Jarvis: one long-lived Claude Agent SDK session the browser talks to.
 *   POST /api/say { system, text }        -> queues a user turn (the first one starts the session)
 *   GET  /api/events                      -> SSE: spoken text, HUD programs, status line, theme, end of turn
 *   POST /api/ui-result { id, height, available, width, screenshot } -> the browser's measurement and JPEG of a HUD change
 *   GET  /api/speak?text=…                -> ElevenLabs speech for one reply (mp3, streamed)
 * MCP servers for the user's own data (Notion, …) come from jarvis.mcp.json, in Claude Code's .mcp.json format.
 */
import { createSdkMcpServer, query, tool, type McpServerConfig, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import type { Plugin } from 'vite'
import { z } from 'zod'

const PERSONA = `You are Jarvis, a voice assistant. The user talks to you out loud and hears your replies spoken.
- Reply in one or two short spoken sentences. No markdown, lists or code in replies, and never read out a program.
- Put detail on the HUD whenever a visual helps or the user asks for one. Leave the HUD alone when the user only asks a question.
- The HUD stays on screen between turns, and every message ends with its current program. Change it with edit_ui: send only the statements to add or replace, and remove the ones to drop. To add a panel, define it and also redefine its parent (usually root or a row) with the new reference. Use show_ui only for a completely different HUD.
- Use WebSearch and WebFetch for anything current (weather, news, prices, places, events). Never invent live data.
- Before anything that takes a moment (searching, fetching, building the HUD), call set_status with a few words saying what you are doing, e.g. "Checking Berlin weather". Call it with "Standing by" when you are done.
- The result of edit_ui and show_ui says whether the HUD fits the screen and includes a screenshot of it. If it doesn't fit, or the screenshot shows a clear defect (cut off, overlapping, empty or broken panels), fix it with edit_ui, at most twice. Otherwise leave it.
- Pick the theme to suit the moment with set_theme: jarvis for everyday use, friday when the user asks for FRIDAY, battle for fights, threats and alarms, targeting for tracking and aiming, patriot for Iron Patriot. Set it before changing the HUD so it builds in the right colors.
- Other tools may give you the user's own data (notes, todos, calendars); use them when the user asks about their stuff.`

const VOICE = 'JBFqnCBsd6RMkjVDRZzb'

const MODES = ['jarvis', 'friday', 'battle', 'targeting', 'patriot'] as const
type Mode = (typeof MODES)[number]

type Event =
  | { type: 'text'; text: string }
  | { type: 'text_end' }
  | { type: 'ui_start'; edit: boolean }
  | { type: 'ui_partial'; program: string }
  | { type: 'ui'; id: string; program: string; edit: boolean; remove: string[] }
  | { type: 'status'; text: string }
  | { type: 'theme'; mode: Mode }
  | { type: 'done' }

const clients = new Set<ServerResponse>()
const send = (event: Event) => clients.forEach((c) => c.write(`data: ${JSON.stringify(event)}\n\n`))

// HUD changes waiting for the browser to report how tall the HUD rendered, with a screenshot.
type Measured = { text: string; screenshot?: string }
const measured = new Map<string, (result: Measured) => void>()

async function render(change: { program: string; edit: boolean; remove: string[] }) {
  const id = randomUUID()
  send({ type: 'ui', id, ...change })
  const result = await new Promise<Measured>((resolve) => {
    measured.set(id, resolve)
    setTimeout(() => resolve({ text: 'The HUD is shown; no measurement came back.' }), 20000)
  })
  measured.delete(id)
  return {
    content: [
      { type: 'text' as const, text: result.text },
      ...(result.screenshot ? [{ type: 'image' as const, data: result.screenshot, mimeType: 'image/jpeg' }] : []),
    ],
  }
}

const editUi = tool(
  'edit_ui',
  'Change the HUD on screen: statements are OpenUI Lang statements that replace the ones with the same name or are added; remove lists statement names to drop. Returns how tall it renders, whether it fits the screen, and a screenshot.',
  {
    statements: z.string().describe('OpenUI Lang statements to add or replace, one per line'),
    remove: z.array(z.string()).optional().describe('Names of statements to delete'),
  },
  async ({ statements, remove }) => render({ program: statements, edit: true, remove: remove ?? [] }),
  { alwaysLoad: true },
)

const showUi = tool(
  'show_ui',
  'Replace the whole HUD with a new OpenUI Lang program (the language and components are in the system prompt). Returns how tall it renders, whether it fits the screen, and a screenshot.',
  { program: z.string().describe('The complete OpenUI Lang program') },
  async ({ program }) => render({ program, edit: false, remove: [] }),
  { alwaysLoad: true },
)

const setStatus = tool(
  'set_status',
  'Set the one-line status shown in the HUD frame, e.g. "Searching the web". A few words.',
  { text: z.string() },
  async ({ text }) => {
    send({ type: 'status', text })
    return { content: [{ type: 'text', text: 'Status set.' }] }
  },
  { alwaysLoad: true },
)

const setTheme = tool(
  'set_theme',
  'Switch the whole HUD and its frame to a color theme: jarvis (blue, default), friday (teal), battle (red), targeting (amber), patriot (green).',
  { mode: z.enum(MODES) },
  async ({ mode }) => {
    send({ type: 'theme', mode })
    return { content: [{ type: 'text', text: `Theme set to ${mode}.` }] }
  },
  { alwaysLoad: true },
)

// An async queue of user turns: the session reads from it for as long as it lives.
function inbox() {
  const waiting: SDKUserMessage[] = []
  let wake = () => {}
  return {
    push(text: string) {
      waiting.push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, origin: { kind: 'human' } })
      wake()
    },
    async *messages() {
      for (;;) {
        while (waiting.length) yield waiting.shift()!
        await new Promise<void>((r) => (wake = r))
      }
    },
  }
}

// A HUD program arrives as streamed tool-input JSON: decode what has come so far, so the HUD builds live.
function partialProgram(json: string) {
  const m = json.match(/"(?:program|statements)"\s*:\s*"((?:[^"\\]|\\.)*)/)
  if (!m) return ''
  try {
    return JSON.parse(`"${m[1].replace(/\\u[0-9a-fA-F]{0,3}$/, '')}"`) as string
  } catch {
    return ''
  }
}

const readJson = async (req: IncomingMessage) => {
  let body = ''
  for await (const chunk of req) body += chunk
  return JSON.parse(body)
}

// { mcpServers: { name: config } }, as in Claude Code's .mcp.json. Gitignored: it holds tokens.
function userMcpServers(): Record<string, McpServerConfig> {
  const file = new URL('../jarvis.mcp.json', import.meta.url)
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')).mcpServers : {}
}

export function jarvisAgent(keys: { anthropic: string; elevenlabs: string }): Plugin {
  let session: ReturnType<typeof inbox> | null = null

  function start(system: string) {
    const box = inbox()
    session = box
    const mcp = userMcpServers()
    const q = query({
      prompt: box.messages(),
      options: {
        model: 'claude-sonnet-5-5',
        effort: 'low',
        systemPrompt: `${PERSONA}\n\n${system}`,
        tools: ['WebSearch', 'WebFetch'],
        allowedTools: ['WebSearch', 'WebFetch', 'mcp__jarvis', ...Object.keys(mcp).map((name) => `mcp__${name}`)],
        mcpServers: { ...mcp, jarvis: createSdkMcpServer({ name: 'jarvis', tools: [editUi, showUi, setStatus, setTheme] }) },
        includePartialMessages: true,
        // Isolated from the developer's own Claude Code setup (settings, hooks, CLAUDE.md, session files).
        settingSources: [],
        persistSession: false,
        env: { ...process.env, ANTHROPIC_API_KEY: keys.anthropic },
      },
    })
    let ui: { index: number; json: string } | null = null
    const handle = (m: SDKMessage) => {
      if (m.type === 'result') return send({ type: 'done' })
      if (m.type !== 'stream_event' || m.parent_tool_use_id) return
      const e = m.event
      if (e.type === 'content_block_start' && e.content_block.type === 'tool_use' && /__(show|edit)_ui$/.test(e.content_block.name)) {
        ui = { index: e.index, json: '' }
        send({ type: 'ui_start', edit: e.content_block.name.endsWith('edit_ui') })
      } else if (e.type === 'content_block_delta' && e.delta.type === 'text_delta') {
        send({ type: 'text', text: e.delta.text })
      } else if (e.type === 'content_block_delta' && e.delta.type === 'input_json_delta' && ui?.index === e.index) {
        ui.json += e.delta.partial_json
        send({ type: 'ui_partial', program: partialProgram(ui.json) })
      } else if (e.type === 'content_block_stop') {
        if (ui?.index === e.index) ui = null
        else send({ type: 'text_end' })
      }
    }
    ;(async () => {
      try {
        for await (const m of q) handle(m)
      } catch (err) {
        console.error(err)
      } finally {
        // A dead session restarts on the next turn instead of taking the dev server down.
        if (session === box) session = null
        send({ type: 'done' })
      }
    })()
    return box
  }

  return {
    name: 'jarvis-agent',
    configureServer(server) {
      server.middlewares.use('/api/events', (req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
        res.write(': connected\n\n')
        clients.add(res)
        req.on('close', () => clients.delete(res))
      })
      server.middlewares.use('/api/say', async (req, res) => {
        const { system, text } = await readJson(req)
        ;(session ?? start(system)).push(text)
        res.statusCode = 204
        res.end()
      })
      server.middlewares.use('/api/ui-result', async (req, res) => {
        const { id, height, available, width, screenshot } = await readJson(req)
        measured.get(id)?.({
          screenshot,
          text:
            height <= available
            ? `Shown. It renders ${height}px tall and fits the ${width}×${available}px screen area.`
            : `It renders ${height}px tall but the screen area is only ${width}×${available}px, so the bottom is cut off. Fix it with edit_ui so everything fits: fewer or smaller panels, side-by-side rows, shorter charts and tables.`,
        })
        res.statusCode = 204
        res.end()
      })
      server.middlewares.use('/api/speak', async (req, res) => {
        const text = new URL(req.url!, 'http://x').searchParams.get('text') ?? ''
        try {
          const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${VOICE}/stream?output_format=mp3_44100_128`, {
            method: 'POST',
            headers: { 'xi-api-key': keys.elevenlabs, 'Content-Type': 'application/json' },
            body: JSON.stringify({ text, model_id: 'eleven_flash_v2_5' }),
          })
          if (!r.ok || !r.body) {
            console.error('ElevenLabs', r.status, await r.text())
            res.statusCode = 502
            return res.end()
          }
          res.setHeader('Content-Type', 'audio/mpeg')
          Readable.fromWeb(r.body as import('node:stream/web').ReadableStream).pipe(res)
        } catch (err) {
          console.error(err)
          res.statusCode = 502
          res.end()
        }
      })
    },
  }
}
