// Pure tests of shared/merkle.mjs against an independent node:crypto implementation of the
// on-chain hashing. The e2e suite proves the same trees verify inside the program.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { Keypair, PublicKey } from '@solana/web3.js'
import {
  buildEntanglementTree,
  leafHash,
  nodeHash,
  verifyClaim,
  verifyProof,
  MAX_LEAVES,
} from '../../../shared/merkle.mjs'

const sha = (...parts: Uint8Array[]) => {
  const h = createHash('sha256')
  for (const p of parts) h.update(p)
  return new Uint8Array(h.digest())
}

function referenceLeaf(index: number, wallet: string, amount: bigint) {
  const i = Buffer.alloc(4)
  i.writeUInt32LE(index)
  const a = Buffer.alloc(8)
  a.writeBigUInt64LE(amount)
  return sha(Uint8Array.of(0), i, new PublicKey(wallet).toBytes(), a)
}

function referenceNode(a: Uint8Array, b: Uint8Array) {
  const [lo, hi] = Buffer.compare(Buffer.from(a), Buffer.from(b)) <= 0 ? [a, b] : [b, a]
  return sha(Uint8Array.of(1), lo, hi)
}

const entries = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    wallet: Keypair.generate().publicKey.toBase58(),
    amount: BigInt(1_000 + i * 7919),
  }))

test('leaf and node hashing match the on-chain definition', () => {
  const wallet = Keypair.generate().publicKey.toBase58()
  assert.deepEqual(leafHash(7, wallet, 123456789n), referenceLeaf(7, wallet, 123456789n))
  const a = sha(Uint8Array.of(9)),
    b = sha(Uint8Array.of(3))
  assert.deepEqual(nodeHash(a, b), referenceNode(a, b))
  assert.deepEqual(nodeHash(a, b), nodeHash(b, a))
})

for (const n of [1, 2, 3, 4, 5, 7, 8, 17, 100]) {
  test(`every proof verifies for a ${n}-leaf tree; tampering fails`, () => {
    const list = entries(n)
    const tree = buildEntanglementTree(list)
    assert.equal(tree.leafCount, n)
    assert.equal(
      tree.total,
      list.reduce((s, e) => s + e.amount, 0n),
    )
    for (let i = 0; i < n; i++) {
      const proof = tree.proof(i)
      assert.ok(proof.length <= Math.ceil(Math.log2(Math.max(2, n))))
      // Fold with the reference hasher to be independent of the module under test.
      let node = referenceLeaf(i, list[i].wallet, list[i].amount)
      for (const sibling of proof) node = referenceNode(node, sibling)
      assert.deepEqual(node, tree.root)
      assert.ok(
        verifyClaim({
          leafIndex: i,
          wallet: list[i].wallet,
          amount: list[i].amount,
          proof,
          root: tree.root,
        }),
      )
      assert.ok(
        !verifyClaim({
          leafIndex: i,
          wallet: list[i].wallet,
          amount: list[i].amount + 1n,
          proof,
          root: tree.root,
        }),
      )
      if (n > 1)
        assert.ok(
          !verifyProof(leafHash((i + 1) % n, list[i].wallet, list[i].amount), proof, tree.root),
        )
    }
  })
}

test('rejects empty, zero, oversize and overflowing input', () => {
  assert.throws(() => buildEntanglementTree([]))
  assert.throws(() =>
    buildEntanglementTree([{ wallet: Keypair.generate().publicKey.toBase58(), amount: 0n }]),
  )
  assert.throws(() => buildEntanglementTree([{ wallet: 'not-a-key', amount: 1n }]))
  assert.throws(() =>
    buildEntanglementTree([
      { wallet: Keypair.generate().publicKey.toBase58(), amount: (1n << 64n) - 1n },
      { wallet: Keypair.generate().publicKey.toBase58(), amount: 1n },
    ]),
  )
  assert.equal(MAX_LEAVES, 16384)
})
