import { Timer, Shield, ChartNoAxesCombined, Flame, Users, RefreshCw, Droplets } from 'lucide-react'
export const hookModules = [
  {
    key: 'interval',
    title: 'Buy spacing',
    icon: Timer,
    group: 'opening',
    text: 'A short, pool-wide pause between buys during the opening window. Sells stay open.',
    detail:
      'One timer for the entire pool, not each wallet. The founder buy is exempt. It expires automatically.',
    value: 5,
    color: 'lilac',
  },
  {
    key: 'startCapBps',
    title: 'Rising buy cap',
    icon: Shield,
    group: 'opening',
    text: 'Start with smaller buys, then gradually increase the limit as your market opens.',
    detail:
      'Limits each buy to a percentage of virtual USDC reserves. Multiple wallets can still buy; this is not a bot-proof guarantee.',
    value: 100,
    color: 'peach',
  },
  {
    key: 'oracle',
    title: 'Price history',
    icon: ChartNoAxesCombined,
    group: 'opening',
    text: 'Record a time-weighted price history for safer buyback and liquidity execution.',
    detail:
      'Builds at least 30 minutes of observations. Market actions pause if spot price differs by more than 100 ticks (about 1%) from the average.',
    value: true,
    color: 'mint',
  },
  {
    key: 'burnBps',
    title: 'Fee burn',
    icon: Flame,
    group: 'value',
    text: 'Permanently burn a slice of the token fees in your creator share.',
    detail:
      'Burns only tokens collected as fees, reducing supply at harvest. Your USDC fees are unchanged. Holder balances are never burned.',
    value: 2000,
    color: 'rose',
  },
  {
    key: 'rewardBps',
    title: 'Holder rewards',
    icon: Users,
    group: 'value',
    text: 'Share part of your USDC fees with people holding your token.',
    detail:
      'Rewards accrue to holders at harvest and remain theirs after a transfer. Pool, hook and vesting balances are excluded. Holders claim USDC in the terminal.',
    value: 3000,
    color: 'lilac',
  },
  {
    key: 'buybackBps',
    title: 'Buyback & burn',
    icon: RefreshCw,
    group: 'value',
    text: 'Use part of your USDC fees to buy tokens from the pool and burn them.',
    detail:
      'Queues fees until price history is ready. Each execution spends at most 0.5% of virtual USDC reserves with a 200-tick price limit. Anyone can trigger execution.',
    value: 2000,
    color: 'gold',
  },
  {
    key: 'liquidityBps',
    title: 'Liquidity reinvestment',
    icon: Droplets,
    group: 'value',
    text: 'Put a slice of both fee currencies back into permanently locked liquidity.',
    detail:
      'Adds to the seed position when enough of both assets are available and the price check passes. Unused funds wait for another execution. No withdrawal function.',
    value: 2000,
    color: 'blue',
  },
]
