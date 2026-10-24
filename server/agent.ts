/*
 * Jarvis: one long-lived Claude Agent SDK session the browser talks to.
 *   POST /api/say { system, text }        -> queues a user turn (the first one starts the session)
 *   GET  /api/events                      -> SSE: spoken text, HUD programs, end of turn
 *   POST /api/ui-result { id, height, available, width } -> the browser's measurement of a show_ui call
 *   GET  /api/speak?text=…                -> ElevenLabs speech for one reply (mp3, streamed)
 */
import { createSdkMcpServer, query, tool, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import type { Plugin } from 'vite'
import { z } from 'zod'

const PERSONA = `You are Jarvis, a voice assistant. The user talks to you out loud and hears your replies spoken.
- Reply in one or two short spoken sentences. No markdown, lists or code in replies, and never read out a program.
- Put detail on the HUD: call show_ui with a complete OpenUI Lang program whenever a visual helps or the user asks for one. Each call replaces the whole HUD. Leave the HUD alone when the user only asks a question.
- Use WebSearch and WebFetch for anything current (weather, news, prices, places, events). Never invent live data.
- show_ui's result says whether the HUD fit the screen. If it didn't, call show_ui again with a smaller layout, at most twice.`

const VOICE = 'JBFqnCBsd6RMkjVDRZzb'

type Event =
  | { type: 'text'; text: string }
  | { type: 'text_end' }
  | { type: 'ui_start' }
  | { type: 'ui_partial'; program: string }
  | { type: 'ui'; id: string; program: string }
  | { type: 'done' }

const clients = new Set<ServerResponse>()
const send = (event: Event) => clients.forEach((c) => c.write(`data: ${JSON.stringify(event)}\n\n`))

// show_ui calls waiting for the browser to report how tall the HUD rendered.
const measured = new Map<string, (result: string) => void>()

const showUi = tool(
  'show_ui',
  'Replace the HUD with an OpenUI Lang program (the language and components are in the system prompt). Returns how tall it rendered and whether it fits the screen.',
  { program: z.string().describe('The complete OpenUI Lang program') },
  async ({ program }) => {
    const id = randomUUID()
    send({ type: 'ui', id, program })
    const result = await new Promise<string>((resolve) => {
      measured.set(id, resolve)
      setTimeout(() => resolve('The HUD is shown; no measurement came back.'), 15000)
    })
    measured.delete(id)
    return { content: [{ type: 'text', text: result }] }
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

// The show_ui program arrives as streamed tool-input JSON: decode what has come so far, so the HUD builds live.
function partialProgram(json: string) {
  const m = json.match(/"program"\s*:\s*"((?:[^"\\]|\\.)*)/)
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

export function jarvisAgent(keys: { anthropic: string; elevenlabs: string }): Plugin {
  let session: ReturnType<typeof inbox> | null = null

  function start(system: string) {
    const box = inbox()
    session = box
    const q = query({
      prompt: box.messages(),
      options: {
        model: 'claude-opus-5-5',
        effort: 'low',
        systemPrompt: `${PERSONA}\n\n${system}`,
        tools: ['WebSearch', 'WebFetch'],
        allowedTools: ['WebSearch', 'WebFetch', 'mcp__jarvis__show_ui'],
        mcpServers: { jarvis: createSdkMcpServer({ name: 'jarvis', tools: [showUi] }) },
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
      if (e.type === 'content_block_start' && e.content_block.type === 'tool_use' && e.content_block.name.endsWith('show_ui')) {
        ui = { index: e.index, json: '' }
        send({ type: 'ui_start' })
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
        const { id, height, available, width } = await readJson(req)
        measured.get(id)?.(
          height <= available
            ? `Shown. It renders ${height}px tall and fits the ${width}×${available}px screen area.`
            : `It renders ${height}px tall but the screen area is only ${width}×${available}px, so the bottom is cut off. Call show_ui again so everything fits: fewer or smaller panels, side-by-side rows, shorter charts and tables.`,
        )
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
