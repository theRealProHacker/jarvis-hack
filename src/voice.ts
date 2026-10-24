/*
 * Push-to-talk speech-to-text through Reson8's realtime WebSocket. The mic is resampled to 16 kHz and
 * streamed as raw 16-bit PCM; interim transcripts arrive while talking, and stop() flushes the rest
 * and resolves with the whole utterance.
 */

const URL = 'wss://api.reson8.dev/v1/speech-to-text/realtime?encoding=pcm_s16le&sample_rate=16000&channels=1&include_interim=true&language=en,de'

// Resamples the mic's float samples to 16 kHz, converts them to 16-bit PCM and posts each block to the
// main thread. The context runs at the mic's own rate: Firefox can't connect a mic to a context at another rate.
const WORKLET = `registerProcessor('pcm16', class extends AudioWorkletProcessor {
  pos = 0
  process([input]) {
    const ch = input[0]
    if (ch) {
      const step = sampleRate / 16000
      const out = new Int16Array(Math.ceil((ch.length - this.pos) / step))
      let n = 0
      for (; this.pos < ch.length; this.pos += step) out[n++] = Math.max(-1, Math.min(1, ch[Math.floor(this.pos)])) * 0x7fff
      this.pos -= ch.length
      this.port.postMessage(out.buffer, [out.buffer])
    }
    return true
  }
})`

export interface Recording {
  /** The live mic, e.g. for an audio-reactive orb. */
  stream: MediaStream
  stop(): Promise<string>
}

export async function record(onText: (text: string) => void): Promise<Recording> {
  // Created and resumed before the first await, while the key press or click is still being handled:
  // Firefox keeps a context created later suspended, and then no audio flows.
  const ctx = new AudioContext()
  ctx.resume()
  const res = await fetch('/api/reson8-token', { method: 'POST' })
  if (!res.ok) throw new Error(`Reson8 token request failed (${res.status})`)
  const { access_token } = await res.json()
  const ws = new WebSocket(URL, ['bearer', access_token])
  ws.binaryType = 'arraybuffer'
  const mic = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } })
  await ctx.audioWorklet.addModule(`data:text/javascript,${encodeURIComponent(WORKLET)}`)
  const node = new AudioWorkletNode(ctx, 'pcm16')
  ctx.createMediaStreamSource(mic).connect(node)
  // The node outputs silence; connecting it keeps browsers from skipping a node nothing listens to.
  node.connect(ctx.destination)

  // Audio captured before the socket opens is queued, so the first words aren't lost.
  const queued: ArrayBuffer[] = []
  node.port.onmessage = (e) => (ws.readyState === WebSocket.OPEN ? ws.send(e.data) : queued.push(e.data))
  ws.onopen = () => queued.splice(0).forEach((b) => ws.send(b))

  let final = ''
  let flushed = () => {}
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data)
    if (msg.type === 'transcript') {
      if (msg.is_final) final = `${final} ${msg.text}`.trim()
      onText(msg.is_final ? final : `${final} ${msg.text}`.trim())
    } else if (msg.type === 'flush_confirmation') flushed()
  }

  return {
    stream: mic,
    async stop() {
      mic.getTracks().forEach((t) => t.stop())
      await ctx.close()
      if (ws.readyState === WebSocket.OPEN) {
        await new Promise<void>((resolve) => {
          flushed = resolve
          ws.send(JSON.stringify({ type: 'flush_request' }))
          setTimeout(resolve, 3000) // don't hang the UI if the confirmation never comes
        })
      }
      ws.close()
      return final
    },
  }
}
