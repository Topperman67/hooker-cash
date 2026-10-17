import { useEffect, useState } from 'react'
import { delayRender, continueRender } from 'remotion'

/** holds the render until the brand fonts (imported by the composition) have loaded */
export function useFonts() {
  const [handle] = useState(() => delayRender('Loading brand fonts'))
  useEffect(() => {
    Promise.all(
      [
        '700 60px "Hubot Sans Variable"',
        '500 30px "Mona Sans Variable"',
        '400 20px "Martian Mono Variable"',
      ].map((f) => document.fonts.load(f)),
    ).then(() => continueRender(handle))
  }, [handle])
}
