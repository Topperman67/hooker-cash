const assert = require('node:assert/strict')
const hre = require('hardhat')
const { setCode } = require('@nomicfoundation/hardhat-network-helpers')
const {
  encodeDeployData,
  encodeFunctionData,
  getCreate2Address,
  keccak256,
  toHex,
  parseEther,
  zeroAddress,
  decodeEventLog,
} = require('viem')
const proxy = '0x4e59b44847b379578588920cA78FbF26c0B4956C'
const proxyCode =
  '0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3'

for (const modular of [false, true])
  describe(`Native ETH boundary: ${modular ? 'modular' : 'standard'}`, function () {
    let client, owner, trader, manager, factory, router, recipient, token, params
    const fee = parseEther('0.0001'),
      buy = parseEther('0.002')
    before(async () => {
      client = await hre.viem.getPublicClient()
      ;[owner, trader] = await hre.viem.getWalletClients()
      manager = await hre.viem.deployContract('PoolManager', [owner.account.address])
      recipient = await hre.viem.deployContract('NativeRecipient')
      await setCode(proxy, proxyCode)
      const { emptyRecipe } = await import('../../../src/lib/hookRecipe.js')
      const name = modular ? 'HookbrewModularFactory' : 'HookbrewFactory'
      const artifact = await hre.artifacts.readArtifact(name)
      const args = [
        manager.address,
        zeroAddress,
        owner.account.address,
        fee,
        ...(modular ? [{ ...emptyRecipe, rewardBps: 2000 }] : []),
      ]
      const data = encodeDeployData({ ...artifact, args }),
        bytecodeHash = keccak256(data)
      for (let n = 0n; ; n++) {
        const salt = toHex(n, { size: 32 }),
          address = getCreate2Address({ from: proxy, salt, bytecodeHash })
        if ((BigInt(address) & 0x3fffn) !== (modular ? 0x20c0n : 0x2080n)) continue
        await client.waitForTransactionReceipt({
          hash: await owner.sendTransaction({ to: proxy, data: salt + data.slice(2) }),
        })
        factory = await hre.viem.getContractAt(name, address)
        break
      }
      router = await hre.viem.deployContract('HookbrewRouter', [factory.address])
      params = {
        name: 'Native boundary',
        symbol: 'ETHB',
        metadataURI: 'https://example.com/native.json',
        salt: toHex(100n, { size: 32 }),
        fee: 10000,
        targetMcap: parseEther('1'),
        initialBuy: 0n,
        minTokensOut: 0n,
        guard: { window: 0, startCapBps: 0, endCapBps: 0, interval: 0 },
        splits: [{ wallet: recipient.address, bps: 10000, cliff: 0, duration: 0 }],
      }
      const { request, result } = await client.simulateContract({
        address: factory.address,
        abi: factory.abi,
        functionName: 'launch',
        args: [params],
        account: owner.account,
        value: fee,
      })
      await client.waitForTransactionReceipt({ hash: await owner.writeContract(request) })
      token = await hre.viem.getContractAt(
        modular ? 'HookbrewRewardToken' : 'HookbrewToken',
        result[0],
      )
    })
    it('rejects underpayment, overpayment, stale one-ETH fees and invalid valuations', async () => {
      const p = { ...params, salt: toHex(101n, { size: 32 }), initialBuy: buy }
      for (const value of [fee, fee + buy - 1n, fee + buy + 1n, parseEther('1')])
        await assert.rejects(
          () =>
            client.simulateContract({
              address: factory.address,
              abi: factory.abi,
              functionName: 'launch',
              args: [p],
              account: owner.account,
              value,
            }),
          /invalid fee/,
        )
      for (const targetMcap of [parseEther('0.5') - 1n, parseEther('5') + 1n])
        await assert.rejects(
          () => factory.simulate.launch([{ ...p, targetMcap }], { value: fee + buy }),
          /valuation/,
        )
      for (const targetMcap of [parseEther('0.5'), parseEther('5')])
        await factory.simulate.launch([{ ...p, targetMcap }], { value: fee + buy })
    })
    it('rounds opening ETH valuations within one usable tick at both boundaries', async () => {
      const { priceFromSqrt } = await import('../../../server/market-math.mjs')
      for (const [index, target] of ['0.5', '1', '5'].entries()) {
        const p = {
          ...params,
          salt: toHex(200n + BigInt(index), { size: 32 }),
          targetMcap: parseEther(target),
        }
        const receipt = await client.waitForTransactionReceipt({
          hash: await factory.write.launch([p], { value: fee }),
        })
        const launched = receipt.logs.flatMap((log) => {
          try {
            const event = decodeEventLog({ abi: factory.abi, ...log })
            return event.eventName === 'TokenLaunched' ? [event.args] : []
          } catch {
            return []
          }
        })[0]
        const actual = priceFromSqrt(launched.sqrtPriceX96, launched.token, zeroAddress) * 1e9
        assert.ok(actual >= Number(target) * (1 - 1e-12))
        const tickSpacing = Number(await factory.read.TICK_SPACING())
        assert.equal(tickSpacing, 60)
        assert.ok(actual < Number(target) * 1.0001 ** tickSpacing)
      }
    })
    it('buys with ETH without approval, rejects sell ETH and prevents unsolicited factory deposits', async () => {
      const args = [token.address, true, buy, 1n, 2n ** 32n]
      for (const value of [0n, buy - 1n, buy + 1n])
        await assert.rejects(
          () => router.simulate.swap(args, { account: trader.account, value }),
          /incorrect ETH/,
        )
      await router.write.swap(args, { account: trader.account, value: buy })
      assert.equal(await token.read.allowance([trader.account.address, router.address]), 0n)
      const held = await token.read.balanceOf([trader.account.address])
      await token.write.approve([router.address, held / 2n], { account: trader.account })
      await assert.rejects(
        () =>
          router.simulate.swap([token.address, false, held / 2n, 1n, 2n ** 32n], {
            account: trader.account,
            value: 1n,
          }),
        /incorrect ETH/,
      )
      await router.write.swap([token.address, false, held / 2n, 1n, 2n ** 32n], {
        account: trader.account,
      })
      assert.equal(await client.getBalance({ address: router.address }), 0n)
      await assert.rejects(
        () => owner.sendTransaction({ to: factory.address, value: 1n, gas: 100000n }),
        /only pool manager|reverted/,
      )
    })
    it('preserves rejected claims and blocks receiver reentrancy without spending protocol reserves', async () => {
      await factory.write.harvest([token.address])
      const due = await factory.read.claimable([token.address, recipient.address, zeroAddress])
      const protocol = await factory.read.protocolClaimable([token.address, zeroAddress])
      assert.ok(due > 0n && protocol > 0n)
      await recipient.write.configure([true, zeroAddress, '0x'])
      await assert.rejects(
        () => factory.write.claim([token.address, recipient.address]),
        /ETH transfer failed/,
      )
      assert.equal(
        await factory.read.claimable([token.address, recipient.address, zeroAddress]),
        due,
      )
      const payload = encodeFunctionData({
        abi: factory.abi,
        functionName: 'claim',
        args: [token.address, recipient.address],
      })
      await recipient.write.configure([false, factory.address, payload])
      await factory.write.claim([token.address, recipient.address])
      assert.equal(await recipient.read.reentryBlocked(), true)
      assert.equal(await client.getBalance({ address: recipient.address }), due)
      assert.equal(await factory.read.protocolClaimable([token.address, zeroAddress]), protocol)
    })
    if (modular)
      it('preserves rejected holder rewards and blocks reward-claim reentry', async () => {
        await token.write.transfer(
          [recipient.address, await token.read.balanceOf([trader.account.address])],
          { account: trader.account },
        )
        await router.write.swap([token.address, true, buy, 1n, 2n ** 32n], {
          account: trader.account,
          value: buy,
        })
        await factory.write.harvest([token.address])
        const due = await token.read.pendingReward([recipient.address])
        assert.ok(due > 0n)
        await recipient.write.configure([true, zeroAddress, '0x'])
        await assert.rejects(
          () => token.write.claimRewards([recipient.address]),
          /ETH transfer failed/,
        )
        assert.equal(await token.read.pendingReward([recipient.address]), due)
        const payload = encodeFunctionData({
          abi: token.abi,
          functionName: 'claimRewards',
          args: [recipient.address],
        })
        await recipient.write.configure([false, token.address, payload])
        await token.write.claimRewards([recipient.address])
        assert.equal(await recipient.read.reentryBlocked(), true)
        assert.equal(await token.read.pendingReward([recipient.address]), 0n)
      })
  })
