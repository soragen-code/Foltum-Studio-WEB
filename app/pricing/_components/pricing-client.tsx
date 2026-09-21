'use client'

import { useState, useEffect } from 'react'
import { Header } from '@/components/header'
import { Check, Coins, Crown, Sparkles, Zap, ShoppingCart, Loader2 } from 'lucide-react'
import { motion } from 'framer-motion'
import { toast } from 'sonner'

// Подписки открывают ДОСТУП К ФУНКЦИЯМ и НЕ дают кредиты — кредиты покупаются отдельными пакетами.
const plans = [
  {
    id: 'basic',
    name: 'Basic',
    price: '$29',
    period: '/мес',
    icon: Zap,
    color: 'border-green-500/30',
    activeColor: 'border-green-500 ring-2 ring-green-500/20',
    iconColor: 'text-green-400',
    features: [
      'Своё лицо персонажа',
      'Редактирование сцен промптом',
      'Ручная правка промпта',
    ],
  },
  {
    id: 'pro',
    name: 'Pro',
    price: '$99',
    period: '/мес',
    icon: Sparkles,
    color: 'border-primary/30',
    activeColor: 'border-primary ring-2 ring-primary/20',
    iconColor: 'text-primary',
    features: [
      'Всё из Basic',
      'Премиум-качество (720p / 1080p)',
    ],
    popular: true,
  },
  {
    id: 'studio',
    name: 'Studio',
    price: '$299',
    period: '/мес',
    icon: Crown,
    color: 'border-red-500/30',
    activeColor: 'border-red-500 ring-2 ring-red-500/20',
    iconColor: 'text-red-400',
    features: [
      'Всё из Pro',
      'Максимальный уровень доступа',
    ],
  },
]

const creditPacks = [
  { id: 'mini', credits: 20, price: '$20' },
  { id: 'plus', credits: 60, price: '$54' },
  { id: 'max', credits: 150, price: '$120' },
]

function postToWayForPay(action: string, fields: Record<string, any>) {
  const form = document.createElement('form')
  form.method = 'POST'
  form.action = action
  form.acceptCharset = 'utf-8'

  const append = (name: string, value: any) => {
    const input = document.createElement('input')
    input.type = 'hidden'
    input.name = name
    input.value = String(value)
    form.appendChild(input)
  }

  Object.entries(fields).forEach(([key, value]) => {
    if (Array.isArray(value)) {
      value.forEach((v) => append(key, v))
    } else {
      append(key, value)
    }
  })

  document.body.appendChild(form)
  form.submit()
}

export function PricingClient({ currentTier = null }: { currentTier?: string | null } = {}) {
  const [credits, setCredits] = useState(0)
  const [buying, setBuying] = useState<string | null>(null)

  const refreshCredits = () =>
    fetch('/api/user/credits')
      .then((r) => r.json())
      .then((d: any) => setCredits(d?.credits ?? 0))
      .catch(() => {})

  useEffect(() => {
    refreshCredits()
  }, [])

  // When WayForPay redirects the user back (returnUrl carries ?order=...),
  // poll the order status so the balance updates as soon as the webhook lands.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const order = params.get('order')
    if (!order) return

    let attempts = 0
    const check = async () => {
      attempts += 1
      try {
        const res = await fetch(`/api/payment/wayforpay/status?order=${encodeURIComponent(order)}`)
        if (res.ok) {
          const d = await res.json()
          if (d.status === 'approved') {
            toast.success(
              d?.credits > 0
                ? `Оплата прошла успешно! Зачислено +${d.credits} кредитов.`
                : 'Оплата прошла успешно! Подписка активирована.'
            )
            await refreshCredits()
            window.history.replaceState({}, '', '/pricing')
            return
          }
          if (d.status === 'declined') {
            toast.error('Платёж отклонён.')
            window.history.replaceState({}, '', '/pricing')
            return
          }
        }
      } catch {}
      if (attempts < 10) setTimeout(check, 2000)
      else window.history.replaceState({}, '', '/pricing')
    }
    check()
  }, [])

  const startPayment = async (productId: string) => {
    setBuying(productId)
    try {
      const res = await fetch('/api/payment/wayforpay/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productId }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        toast.error(err?.error ?? 'Не удалось начать оплату')
        setBuying(null)
        return
      }
      const { action, fields } = await res.json()
      // Redirects the browser to the WayForPay secure checkout.
      postToWayForPay(action, fields)
    } catch {
      toast.error('Ошибка оплаты. Попробуйте ещё раз.')
      setBuying(null)
    }
  }

  const handleSubscribe = (planId: string) => startPayment(planId)
  const handleBuyCredits = (packId: string) => startPayment(packId)

  return (
    <div className="min-h-screen bg-background">
      <Header />
      <main className="mx-auto max-w-[1200px] px-4 py-8">
        <div className="mb-4 text-center">
          <h1 className="font-display text-3xl font-bold tracking-tight">
            Подписки и <span className="text-primary">кредиты</span>
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Подписка открывает функции, но не даёт кредиты. Кредиты для генерации видео покупаются отдельно.
          </p>
          <div className="mt-3 inline-flex items-center gap-2 rounded-full bg-muted px-4 py-2">
            <Coins className="h-4 w-4 text-primary" />
            <span className="text-sm">Текущий баланс: <span className="font-mono font-bold text-primary">{credits}</span> кредитов</span>
          </div>
        </div>

        {/* Подписки — доступ к функциям */}
        <div className="mt-8 text-center">
          <h2 className="font-display text-xl font-bold">Подписки — доступ к функциям</h2>
          <p className="mt-1 text-sm text-muted-foreground">Открывают функции редактора. Кредиты не начисляются.</p>
        </div>
        <div className="mt-6 grid gap-6 md:grid-cols-3">
          {plans.map((plan, idx) => {
            const Icon = plan.icon
            const isCurrent = currentTier === plan.id
            return (
              <motion.div
                key={plan.id}
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: idx * 0.1 }}
                className={`relative rounded-xl border bg-card p-6 ${
                  isCurrent ? plan.activeColor : plan.popular ? plan.activeColor : plan.color
                }`}
                style={{ boxShadow: 'var(--shadow-md)' }}
                data-testid={`plan-${plan.id}`}
              >
                {isCurrent ? (
                  <div className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-green-500 px-3 py-0.5 text-xs font-bold text-white" data-testid={`plan-current-badge-${plan.id}`}>
                    Ваш план
                  </div>
                ) : plan.popular ? (
                  <div className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-primary px-3 py-0.5 text-xs font-bold text-primary-foreground">
                    Most Popular
                  </div>
                ) : null}
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
                {isCurrent ? (
                  <button
                    disabled
                    className="mt-6 flex w-full cursor-default items-center justify-center gap-2 rounded-lg bg-green-500/15 py-2.5 text-sm font-semibold text-green-500"
                    data-testid={`plan-active-btn-${plan.id}`}
                  >
                    <Check className="h-4 w-4" />
                    Активен
                  </button>
                ) : (
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
                    Подписаться
                  </button>
                )}
              </motion.div>
            )
          })}
        </div>

        {/* Кредиты — оплата генерации */}
        <div className="mt-12">
          <h2 className="mb-1 text-center font-display text-xl font-bold">
            Кредиты — <span className="text-primary">оплата генерации</span>
          </h2>
          <p className="mb-4 text-center text-sm text-muted-foreground">
            1 кредит = 1 секунда видео. Например: 20 кредитов = 20 секунд.
          </p>
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
                <div className="text-xs text-muted-foreground">{pack.credits} кредитов = {pack.credits} секунд</div>
                <div className="mt-2 flex items-center justify-center gap-1 text-sm font-semibold">
                  {buying === pack.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <ShoppingCart className="h-3 w-3" />}
                  {pack.price}
                </div>
              </button>
            ))}
          </div>
          <p className="mx-auto mt-4 max-w-[600px] text-center text-xs text-muted-foreground">
            Подписка открывает функции, но не даёт кредиты. Кредиты для генерации видео покупаются отдельно.
          </p>
        </div>
      </main>
    </div>
  )
}
