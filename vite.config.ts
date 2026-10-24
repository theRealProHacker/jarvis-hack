import { defineConfig, loadEnv, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import Anthropic from '@anthropic-ai/sdk'
import { resolve } from 'node:path'

const kit = resolve(import.meta.dirname, '../jarvis-ui/packages/kit/src')

// POST /api/generate { system, messages } -> streams Claude's text back as plain text.
function claudeApi(apiKey: string): Plugin {
  const client = new Anthropic({ apiKey })
  return {
    name: 'claude-api',
    configureServer(server) {
      server.middlewares.use('/api/generate', async (req, res) => {
        let body = ''
        for await (const chunk of req) body += chunk
        const { system, messages } = JSON.parse(body) as { system: string; messages: Anthropic.MessageParam[] }
        res.setHeader('Content-Type', 'text/plain; charset=utf-8')
        try {
          const stream = client.messages.stream({
            model: 'claude-opus-5-5',
            max_tokens: 16000,
            output_config: { effort: 'low' },
            system,
            messages,
          })
          for await (const event of stream) {
            if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') res.write(event.delta.text)
          }
        } catch (err) {
          console.error(err)
          if (!res.headersSent) res.statusCode = 500
        }
        res.end()
      })
    },
  }
}

// POST /api/reson8-token -> a 10-minute Reson8 access token, so the API key never reaches the browser.
function reson8Token(apiKey: string): Plugin {
  return {
    name: 'reson8-token',
    configureServer(server) {
      server.middlewares.use('/api/reson8-token', async (_req, res) => {
        const r = await fetch('https://api.reson8.dev/v1/auth/token', { method: 'POST', headers: { Authorization: `ApiKey ${apiKey}` } })
        res.statusCode = r.status
        res.setHeader('Content-Type', 'application/json')
        res.end(await r.text())
      })
    },
  }
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, import.meta.dirname, '')
  return {
    plugins: [claudeApi(env.ANTHROPIC_API_KEY!), reson8Token(env.RESON8_API_KEY!), react()],
    resolve: {
      alias: [
        { find: /^@jarvis-ui\/kit\/holo$/, replacement: `${kit}/holo.ts` },
        { find: /^@jarvis-ui\/kit$/, replacement: `${kit}/index.ts` },
      ],
      dedupe: ['react', 'react-dom', 'motion', 'zod', 'zustand', '@openuidev/react-lang', '@openuidev/react-ui', '@openuidev/react-headless', '@openuidev/lang-core'],
    },
    server: { port: 5174, fs: { allow: ['..'] } },
  }
})
