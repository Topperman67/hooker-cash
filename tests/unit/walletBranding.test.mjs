import test from 'node:test'
import assert from 'node:assert/strict'
import { walletIconSource } from '../../src/lib/walletBranding.js'

test('legacy compatibility flags do not replace the actual wallet branding', () => {
  assert.equal(
    walletIconSource({
      info: { uuid: 'injected', name: 'Browser wallet' },
      provider: { isPhantom: true, isMetaMask: true },
    }),
    '/brand/wallets/phantom.svg',
  )
  assert.equal(walletIconSource({ info: { name: 'Browser wallet' }, provider: {} }), null)
})

test('extension icons accept image data but never remote or script URLs', () => {
  const icon = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg"/%3E'
  assert.equal(walletIconSource({ info: { name: 'Another wallet', icon } }), icon)
  for (const icon of [
    'javascript:alert(1)',
    'https://example.com/tracker.svg',
    'data:text/html,<script/>',
  ]) {
    assert.equal(walletIconSource({ info: { icon } }), null)
  }
})
