// Entanglement merkle trees, hashed exactly like the quantum_hooks program:
//   leaf = sha256(0x00 ‖ leaf_index u32 LE ‖ wallet (32 bytes) ‖ amount u64 LE)
//   node = sha256(0x01 ‖ min(a, b) ‖ max(a, b))      (byte-wise lexicographic order)
// A level with an odd node count promotes its last node unchanged. Pure JS, browser-safe.
import { sha256 } from '@noble/hashes/sha2'
import { PublicKey } from '@solana/web3.js'

export const MAX_LEAVES = 16_384
const U64_MAX = (1n << 64n) - 1n

function u32le(value) {
  const out = new Uint8Array(4)
  new DataView(out.buffer).setUint32(0, value, true)
  return out
}

function u64le(value) {
  const out = new Uint8Array(8)
  new DataView(out.buffer).setBigUint64(0, value, true)
  return out
}

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

function compareBytes(a, b) {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i]
  return 0
}

function walletBytes(wallet) {
  return (wallet instanceof PublicKey ? wallet : new PublicKey(wallet)).toBytes()
}

export function leafHash(leafIndex, wallet, amount) {
  return sha256(
    concat(Uint8Array.of(0), u32le(leafIndex), walletBytes(wallet), u64le(BigInt(amount))),
  )
}

export function nodeHash(a, b) {
  const [lo, hi] = compareBytes(a, b) <= 0 ? [a, b] : [b, a]
  return sha256(concat(Uint8Array.of(1), lo, hi))
}

/**
 * @param {{ wallet: string, amount: bigint }[]} entries One leaf per entry; leaf index = position.
 * @returns {{ root: Uint8Array, total: bigint, leafCount: number, leaves: Uint8Array[],
 *   entries: { wallet: string, amount: bigint }[], proof: (index: number) => Uint8Array[] }}
 */
export function buildEntanglementTree(entries) {
  if (!Array.isArray(entries) || entries.length === 0)
    throw new Error('Entanglement tree needs at least one entry')
  if (entries.length > MAX_LEAVES)
    throw new Error(`Entanglement tree holds at most ${MAX_LEAVES} entries`)
  let total = 0n
  const normalized = entries.map(({ wallet, amount }, index) => {
    const value = BigInt(amount)
    if (value <= 0n || value > U64_MAX)
      throw new Error(`Entry ${index}: amount must be a positive u64`)
    total += value
    return { wallet: new PublicKey(wallet).toBase58(), amount: value }
  })
  if (total > U64_MAX) throw new Error('Entanglement total overflows u64')

  const leaves = normalized.map(({ wallet, amount }, index) => leafHash(index, wallet, amount))
  const levels = [leaves]
  while (levels[levels.length - 1].length > 1) {
    const level = levels[levels.length - 1]
    const next = []
    for (let i = 0; i < level.length; i += 2)
      next.push(i + 1 < level.length ? nodeHash(level[i], level[i + 1]) : level[i])
    levels.push(next)
  }

  const proof = (index) => {
    if (!Number.isInteger(index) || index < 0 || index >= leaves.length)
      throw new Error(`Leaf index ${index} out of range`)
    const path = []
    let position = index
    for (let depth = 0; depth < levels.length - 1; depth++) {
      const level = levels[depth]
      const sibling = position ^ 1
      if (sibling < level.length) path.push(level[sibling])
      position >>= 1
    }
    return path
  }

  return {
    root: levels[levels.length - 1][0],
    total,
    leafCount: leaves.length,
    leaves,
    entries: normalized,
    proof,
  }
}

/** Folds `proof` over `leaf` and compares with `root`. */
export function verifyProof(leaf, proof, root) {
  let node = leaf
  for (const sibling of proof) node = nodeHash(node, sibling)
  return compareBytes(node, root) === 0 && node.length === root.length
}

/** Convenience: verifies a claim the way `claim_entanglement` does. */
export function verifyClaim({ leafIndex, wallet, amount, proof, root }) {
  return verifyProof(leafHash(leafIndex, wallet, amount), proof, root)
}
