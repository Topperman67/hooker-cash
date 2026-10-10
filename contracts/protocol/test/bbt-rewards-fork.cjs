const assert = require('node:assert/strict')
const hre = require('hardhat')
const { loadFixture } = require('@nomicfoundation/hardhat-network-helpers')
const { encodeFunctionData, keccak256, parseEther, zeroAddress } = require('viem')

// Opt-in investigation of a specific deployed token. All writes use the local fork.
;(process.env.HOOKBREW_BBT_REVIEW === '1' ? describe : describe.skip)(
  'BBT deployed reward accounting on a local Robinhood fork',
  function () {
    this.timeout(180000)
    async function fundedHolders() {
      assert.equal(hre.network.name, 'hardhat')
      assert.ok(process.env.HOOKBREW_FORK_RPC_URL)
      // Execute against a locally mined block; Hardhat has no historical fork schedule for 4663.
      await hre.network.provider.send('evm_mine')
      const client = await hre.viem.getPublicClient()
      const [holder, stranger] = await hre.viem.getWalletClients()
      const token = await hre.viem.getContractAt(
        'HookbrewRewardToken',
        '0x7c906f147f0441eafc90bd7f1cdc79dae7db7cb1',
      )
      assert.equal(
        keccak256(await client.getCode({ address: token.address })),
        '0x979b09eadc0c7a9d0e18b798dfae940c99061afbf92779f35d0c32e83175e54e',
      )
      const factory = await hre.viem.getContractAt(
        'HookbrewModularFactory',
        await token.read.factory(),
      )
      const router = await hre.viem.getContractAt(
        'HookbrewRouter',
        '0x0178704614659A46a872019E17219E6dFDb2899a',
      )
      const recipient = await hre.viem.deployContract('NativeRecipient')
      const buy = parseEther('0.001')
      await router.write.swap([token.address, true, buy, 1n, 2n ** 32n], {
        account: holder.account,
        value: buy,
      })
      const balance = await token.read.balanceOf([holder.account.address])
      assert.ok(balance > 0n)
      await token.write.transfer([recipient.address, balance / 2n], { account: holder.account })
      await router.write.swap([token.address, true, buy, 1n, 2n ** 32n], {
        account: stranger.account,
        value: buy,
      })
      await factory.write.harvest([token.address], { account: stranger.account })
      assert.ok((await token.read.pendingReward([holder.account.address])) > 0n)
      assert.ok((await token.read.pendingReward([recipient.address])) > 0n)
      return { client, token, holder, stranger, recipient }
    }

    it('pays the holder the full pending ETH when a stranger triggers the claim', async () => {
      const { client, token, holder, stranger } = await loadFixture(fundedHolders)
      const address = holder.account.address
      const due = await token.read.pendingReward([address])
      const before = await client.getBalance({ address })
      const reserve = await client.getBalance({ address: token.address })
      await token.write.claimRewards([address], { account: stranger.account })
      assert.equal(await client.getBalance({ address }), before + due)
      assert.equal(await client.getBalance({ address: token.address }), reserve - due)
      assert.equal(await token.read.pendingReward([address]), 0n)
      await token.write.claimRewards([address], { account: stranger.account })
      assert.equal(await client.getBalance({ address }), before + due)
    })

    it('preserves accrued rewards through unsolicited zero transfers and transferFrom', async () => {
      const { client, token, holder, stranger } = await loadFixture(fundedHolders)
      const address = holder.account.address
      const due = await token.read.pendingReward([address])
      assert.equal(await token.read.allowance([address, stranger.account.address]), 0n)
      for (let i = 0; i < 5; i++) {
        await token.write.transfer([address, 0n], { account: stranger.account })
        await token.write.transferFrom([address, stranger.account.address, 0n], {
          account: stranger.account,
        })
        assert.equal(await token.read.pendingReward([address]), due)
      }
      const before = await client.getBalance({ address })
      await token.write.claimRewards([address], { account: stranger.account })
      assert.equal(await client.getBalance({ address }), before + due)
    })

    it('restores a rejected payout and blocks claim reentry without erasing credit', async () => {
      const { client, token, recipient, stranger } = await loadFixture(fundedHolders)
      const address = recipient.address
      const due = await token.read.pendingReward([address])
      const reserve = await client.getBalance({ address: token.address })
      await recipient.write.configure([true, zeroAddress, '0x'])
      await assert.rejects(
        () => token.write.claimRewards([address], { account: stranger.account }),
        /ETH transfer failed/,
      )
      assert.equal(await token.read.pendingReward([address]), due)
      assert.equal(await client.getBalance({ address: token.address }), reserve)
      const payload = encodeFunctionData({
        abi: token.abi,
        functionName: 'claimRewards',
        args: [address],
      })
      await recipient.write.configure([false, token.address, payload])
      await token.write.claimRewards([address], { account: stranger.account })
      assert.equal(await recipient.read.reentryBlocked(), true)
      assert.equal(await client.getBalance({ address }), due)
      assert.equal(await token.read.pendingReward([address]), 0n)
    })
  },
)
