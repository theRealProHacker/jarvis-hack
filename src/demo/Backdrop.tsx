import { useEffect, useRef } from 'react'
import { Map as MapLibre } from '../../../jarvis-ui/packages/kit/node_modules/maplibre-gl'

export type BackdropKind = 'sky' | 'city'

// What the visor looks out on: a dusk flight over a cloud deck, or a night flight over Berlin toward the gate.
export function Backdrop({ kind }: { kind: BackdropKind }) {
  return <div className="demo-backdrop">{kind === 'sky' ? <Sky /> : <City />}</div>
}

const SKY_SHADER = `
precision highp float;
uniform vec2 res;
uniform float t;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
}
float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 6; i++) { v += a * noise(p); p = p * 2.03 + 11.7; a *= 0.5; }
  return v;
}

void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * res) / res.y;
  float horizon = 0.06 + 0.012 * sin(t * 0.21);
  float y = uv.y - horizon;
  // Dusk sky: deep blue overhead, a cold glow on the horizon.
  vec3 sky = mix(vec3(0.10, 0.17, 0.27), vec3(0.015, 0.03, 0.06), smoothstep(0.0, 0.5, y));
  sky += vec3(0.20, 0.17, 0.14) * exp(-abs(y) * 9.0) * 0.6;
  vec3 col = sky;
  if (y < 0.0) {
    // The cloud deck below: a plane rushing toward the camera.
    float z = 0.35 / -y;
    vec2 p = vec2(uv.x * z, z + t * 1.6);
    float c = fbm(p * 0.6);
    float d = smoothstep(0.42, 0.75, c);
    vec3 top = mix(vec3(0.06, 0.09, 0.14), vec3(0.40, 0.45, 0.52), d);
    float fog = 1.0 - exp(-z * 0.09);
    col = mix(top, sky + vec3(0.05, 0.05, 0.05), fog);
  }
  // Keep it dim so the HUD reads on top.
  gl_FragColor = vec4(col * 0.85, 1.0);
}`

function Sky() {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = ref.current!
    const gl = canvas.getContext('webgl')!
    const shader = (type: number, src: string) => {
      const s = gl.createShader(type)!
      gl.shaderSource(s, src)
      gl.compileShader(s)
      return s
    }
    const prog = gl.createProgram()!
    gl.attachShader(prog, shader(gl.VERTEX_SHADER, 'attribute vec2 p; void main() { gl_Position = vec4(p, 0, 1); }'))
    gl.attachShader(prog, shader(gl.FRAGMENT_SHADER, SKY_SHADER))
    gl.linkProgram(prog)
    gl.useProgram(prog)
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer())
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)
    const res = gl.getUniformLocation(prog, 'res')
    const time = gl.getUniformLocation(prog, 't')
    let frame = 0
    const t0 = performance.now()
    const draw = () => {
      canvas.width = canvas.clientWidth
      canvas.height = canvas.clientHeight
      gl.viewport(0, 0, canvas.width, canvas.height)
      gl.uniform2f(res, canvas.width, canvas.height)
      gl.uniform1f(time, (performance.now() - t0) / 1000)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
      frame = requestAnimationFrame(draw)
    }
    draw()
    return () => cancelAnimationFrame(frame)
  }, [])
  return <canvas ref={ref} />
}

// From the start position toward the Brandenburg Gate over the demo's two minutes.
const FROM: [number, number] = [13.39079, 52.52675]
const TO: [number, number] = [13.3777, 52.51628]

function City() {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const map = new MapLibre({
      container: ref.current!,
      style: 'https://tiles.openfreemap.org/styles/dark',
      center: FROM,
      zoom: 15.2,
      pitch: 76,
      bearing: 217,
      interactive: false,
      attributionControl: false,
    })
    let frame = 0
    map.on('load', () => {
      map.addLayer({
        id: 'demo-buildings',
        type: 'fill-extrusion',
        source: 'openmaptiles',
        'source-layer': 'building',
        paint: {
          'fill-extrusion-color': '#1b2a3d',
          'fill-extrusion-height': ['coalesce', ['get', 'render_height'], 12],
          'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], 0],
          'fill-extrusion-opacity': 0.9,
        },
      })
      const t0 = performance.now()
      const fly = () => {
        const k = Math.min(1, (performance.now() - t0) / 120000)
        map.jumpTo({ center: [FROM[0] + (TO[0] - FROM[0]) * k, FROM[1] + (TO[1] - FROM[1]) * k] })
        frame = requestAnimationFrame(fly)
      }
      fly()
    })
    return () => {
      cancelAnimationFrame(frame)
      map.remove()
    }
  }, [])
  return <div ref={ref} className="demo-city" />
}
