'use client'

import { useState, useEffect } from 'react'
import { Header } from '@/components/header'
import { Check, Coins, Crown, Sparkles, Zap, ShoppingCart, Loader2 } from 'lucide-react'
import { motion } from 'framer-motion'
import { toast } from 'sonner'

const plans = [
  {
    id: 'basic',
    name: 'Basic',
    price: '$9.99',
    period: '/month',
    credits: 100,
    icon: Zap,
    color: 'border-green-500/30',
    activeColor: 'border-green-500 ring-2 ring-green-500/20',
    iconColor: 'text-green-400',
    features: ['100 credits/month', 'All quality tiers', 'Up to 3 projects', 'Basic support'],
  },
  {
    id: 'pro',
    name: 'Pro',
    price: '$29.99',
    period: '/month',
    credits: 400,
    icon: Sparkles,
    color: 'border-primary/30',
    activeColor: 'border-primary ring-2 ring-primary/20',
    iconColor: 'text-primary',
    features: ['400 credits/month', 'All quality tiers', 'Unlimited projects', 'Priority support', 'Early access to features'],
    popular: true,
  },
  {
    id: 'studio',
    name: 'Studio',
    price: '$79.99',
    period: '/month',
    credits: 1500,
    icon: Crown,
    color: 'border-red-500/30',
    activeColor: 'border-red-500 ring-2 ring-red-500/20',
    iconColor: 'text-red-400',
    features: ['1500 credits/month', 'All quality tiers', 'Unlimited projects', 'Dedicated support', 'Custom AI models', 'Commercial license'],
  },
]

const creditPacks = [
  { id: 'pack50', credits: 50, price: '$5' },
  { id: 'pack200', credits: 200, price: '$15' },
  { id: 'pack500', credits: 500, price: '$30' },
]

export function PricingClient() {
  const [credits, setCredits] = useState(0)
  const [buying, setBuying] = useState<string | null>(null)

  useEffect(() => {
    fetch('/api/user/credits')
      .then((r) => r.json())
      .then((d: any) => setCredits(d?.credits ?? 0))
      .catch(() => {})
  }, [])

  const handleSubscribe = async (planId: string) => {
    setBuying(planId)
    // STUB: WayForPay integration
    await new Promise((r) => setTimeout(r, 1500))
    toast.success('Payment simulation successful! (WayForPay stub)')

    const plan = plans.find((p) => p.id === planId)
    if (plan) {
      try {
        await fetch('/api/credits/add', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ amount: plan.credits, description: `${plan.name} subscription` }),
        })
        setCredits((prev) => prev + plan.credits)
      } catch {}
    }
    setBuying(null)
  }

  const handleBuyCredits = async (packId: string) => {
    setBuying(packId)
    await new Promise((r) => setTimeout(r, 1000))
    toast.success('Credits purchased! (WayForPay stub)')

    const pack = creditPacks.find((p) => p.id === packId)
    if (pack) {
      try {
        await fetch('/api/credits/add', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ amount: pack.credits, description: `Purchased ${pack.credits} credits` }),
        })
        setCredits((prev) => prev + pack.credits)
      } catch {}
    }
    setBuying(null)
  }

  return (
    <div className="min-h-screen bg-background">
      <Header />
      <main className="mx-auto max-w-[1200px] px-4 py-8">
        <div className="mb-4 text-center">
          <h1 className="font-display text-3xl font-bold tracking-tight">
            Plans & <span className="text-primary">Credits</span>
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Choose a plan or buy credits to power your AI film production
          </p>
          <div className="mt-3 inline-flex items-center gap-2 rounded-full bg-muted px-4 py-2">
            <Coins className="h-4 w-4 text-primary" />
            <span className="text-sm">Current balance: <span className="font-mono font-bold text-primary">{credits}</span> credits</span>
          </div>
        </div>

        {/* Subscription Plans */}
        <div className="mt-8 grid gap-6 md:grid-cols-3">
          {plans.map((plan, idx) => {
            const Icon = plan.icon
            return (
              <motion.div
                key={plan.id}
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: idx * 0.1 }}
                className={`relative rounded-xl border bg-card p-6 ${
                  plan.popular ? plan.activeColor : plan.color
                }`}
                style={{ boxShadow: 'var(--shadow-md)' }}
              >
                {plan.popular && (
                  <div className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-primary px-3 py-0.5 text-xs font-bold text-primary-foreground">
                    Most Popular
                  </div>
                )}
                <Icon className={`mb-3 h-8 w-8 ${plan.iconColor}`} />
                <h3 className="font-display text-xl font-bold">{plan.name}</h3>
                <div className="mt-2">
                  <span className="text-3xl font-bold">{plan.price}</span>
                  <span className="text-sm text-muted-foreground">{plan.period}</span>
                </div>
                <ul className="mt-4 space-y-2">
                  {(plan.features ?? []).map((f: string) => (
                    <li key={f} className="flex items-center gap-2 text-sm text-muted-foreground">
                      <Check className="h-4 w-4 text-primary" />
                      {f}
                    </li>
                  ))}
                </ul>
                <button
                  onClick={() => handleSubscribe(plan.id)}
                  disabled={buying === plan.id}
                  className={`mt-6 flex w-full items-center justify-center gap-2 rounded-lg py-2.5 text-sm font-semibold transition ${
                    plan.popular
                      ? 'bg-primary text-primary-foreground hover:brightness-110'
                      : 'bg-muted hover:bg-muted/80'
                  } disabled:opacity-50`}
                >
                  {buying === plan.id ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                  Subscribe
                </button>
              </motion.div>
            )
          })}
        </div>

        {/* Credit Packs */}
        <div className="mt-12">
          <h2 className="mb-4 text-center font-display text-xl font-bold">
            Buy <span className="text-primary">Credits</span>
          </h2>
          <div className="mx-auto grid max-w-[600px] gap-4 sm:grid-cols-3">
            {creditPacks.map((pack) => (
              <button
                key={pack.id}
                onClick={() => handleBuyCredits(pack.id)}
                disabled={buying === pack.id}
                className="rounded-xl border border-border bg-card p-4 text-center transition hover:border-primary/30 hover:bg-card/80 disabled:opacity-50"
                style={{ boxShadow: 'var(--shadow-sm)' }}
              >
                <div className="mb-1 font-mono text-2xl font-bold text-primary">{pack.credits}</div>
                <div className="text-xs text-muted-foreground">credits</div>
                <div className="mt-2 flex items-center justify-center gap-1 text-sm font-semibold">
                  {buying === pack.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <ShoppingCart className="h-3 w-3" />}
                  {pack.price}
                </div>
              </button>
            ))}
          </div>
        </div>
      </main>
    </div>
  )
}
