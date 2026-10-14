import { AbsoluteFill, Img, staticFile } from 'remotion'
import { FPS } from './timeline.js'

/** Contact sheet of rendered stills (public/review/f<frame>.png), four across. */
export function Sheet({ frames = [], title = '' }) {
  return (
    <AbsoluteFill style={{ background: '#e9ecf0', padding: 24, fontFamily: 'Martian Mono Variable, monospace' }}>
      {title && <div style={{ fontSize: 22, color: '#15181d', marginBottom: 12 }}>{title}</div>}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
        {frames.map((f) => (
          <figure key={f} style={{ margin: 0 }}>
            <Img src={staticFile(`review/f${f}.png`)} style={{ width: '100%', display: 'block', borderRadius: 6 }} />
            <figcaption style={{ fontSize: 16, color: '#5f6876', marginTop: 4 }}>
              {(f / FPS).toFixed(2)} s · frame {f}
            </figcaption>
          </figure>
        ))}
      </div>
    </AbsoluteFill>
  )
}
