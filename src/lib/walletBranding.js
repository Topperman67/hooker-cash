const brands = {
  rabby: '/brand/wallets/rabby.svg',
  coinbase: '/brand/wallets/coinbase.svg',
  metamask: '/brand/wallets/metamask.svg',
  phantom: '/brand/wallets/phantom.svg',
  tronlink: '/brand/wallets/tronlink.jpg',
}

const domains = {
  'io.rabby': 'rabby',
  'com.coinbase.wallet': 'coinbase',
  'io.metamask': 'metamask',
  'app.phantom': 'phantom',
  'org.tronlink': 'tronlink',
  'com.tronlink': 'tronlink',
}

const names = {
  rabby: 'rabby',
  rabbywallet: 'rabby',
  coinbasewallet: 'coinbase',
  metamask: 'metamask',
  phantom: 'phantom',
  phantomwallet: 'phantom',
  tronlink: 'tronlink',
  tronlinkwallet: 'tronlink',
}

// Branding is display metadata only, never a capability or trust check.
export function walletIconSource(wallet) {
  const info = wallet?.info || {}
  const name = String(info.name || '')
    .toLowerCase()
    .replace(/[\s_-]/g, '')
  const brand = domains[String(info.rdns || '').toLowerCase()] || names[name]
  if (brand) return brands[brand]

  // EIP-6963 icons are data URIs. Render them only through an <img> element.
  if (
    typeof info.icon === 'string' &&
    info.icon.length <= 1_000_000 &&
    /^data:image\/(?:svg\+xml|png|webp|jpeg|gif)(?:;[^,]*)?,/i.test(info.icon)
  )
    return info.icon

  if (info.uuid === 'injected' || name === 'browserwallet') {
    const provider = wallet?.provider
    // Several providers also set isMetaMask for compatibility; check them first.
    if (provider?.isRabby) return brands.rabby
    if (provider?.isCoinbaseWallet) return brands.coinbase
    if (provider?.isPhantom) return brands.phantom
    if (provider?.isTronLink || provider?.isTronLinkWallet) return brands.tronlink
    if (provider?.isMetaMask) return brands.metamask
  }
  return null
}
