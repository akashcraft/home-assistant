import { useEffect, useState } from 'react'
import App from './App'
import EffectEditor from './effects/EffectEditor'

// The effect editor opens in its own tab via a hash route, so the whole app
// stays a single Vite entry point with no router dependency.
const EFFECTS_PREFIX = '#/effects/'

function Root() {
  const [hash, setHash] = useState(window.location.hash)

  useEffect(() => {
    const onHashChange = () => setHash(window.location.hash)
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  if (hash.startsWith(EFFECTS_PREFIX)) {
    const basename = decodeURIComponent(hash.slice(EFFECTS_PREFIX.length))
    if (basename) return <EffectEditor basename={basename} />
  }

  return <App />
}

export default Root
