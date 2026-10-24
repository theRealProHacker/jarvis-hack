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

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, import.meta.dirname, '')
  return {
    plugins: [claudeApi(env.ANTHROPIC_API_KEY!), react()],
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
