'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { Header } from '@/components/header'
import { CheckCircle2, Loader2, Home, Coins, AlertCircle, Clock, Crown, LogIn, CreditCard } from 'lucide-react'
import { motion } from 'framer-motion'

type Phase = 'processing' | 'approved' | 'declined' | 'pending'

interface StatusResponse {
  status?: string
  processed?: boolean
  credits?: number
  productName?: string
  balance?: number
  kind?: string // "subscription" | "credits"
  tier?: string | null
  subscriptionTier?: string | null
  subscriptionExpiresAt?: string | null
}

function tierName(t?: string | null): string {
  if (!t) return ''
  return t.charAt(0).toUpperCase() + t.slice(1)
}

function formatDate(iso?: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' })
}

export function SuccessClient() {
  const params = useSearchParams()
  const order = params.get('order')

  const [phase, setPhase] = useState<Phase>(order ? 'processing' : 'pending')
  const [data, setData] = useState<StatusResponse | null>(null)
  // True when repeated status calls came back 401 — the user isn't authenticated on
  // this device/return, but the payment (and its effects) are already applied server-side.
  const [needLogin, setNeedLogin] = useState(false)

  // Poll the payment status until the server-to-server webhook has applied the payment.
  // The effects (credits granted OR subscription tier set) are applied by
  // /api/payment/wayforpay/callback — here we only reflect them.
  useEffect(() => {
    if (!order) return
    let cancelled = false
    let attempts = 0
    let authFails = 0

    const check = async () => {
      attempts += 1
      try {
        const res = await fetch(`/api/payment/wayforpay/status?order=${encodeURIComponent(order)}`)
        if (res.status === 401) {
          authFails += 1
          // Session didn't carry over to the return tab — after a few tries stop and
          // tell the user the payment is applied; they can sign in to see it.
          if (authFails >= 4) {
            if (!cancelled) {
              setNeedLogin(true)
              setPhase('pending')
            }
            return
          }
        } else if (res.ok) {
          const d: StatusResponse = await res.json()
          if (!cancelled) setData(d)
          // Treat processed===true as success even if status lags behind.
          if (d.status === 'approved' || d.processed === true) {
            if (!cancelled) setPhase('approved')
            return
          }
          if (d.status === 'declined') {
            if (!cancelled) setPhase('declined')
            return
          }
        }
      } catch {
        // ignore transient errors and keep polling
      }
      if (cancelled) return
      // Webhook can arrive with a delay — keep a generous window (~20 tries × 2s ≈ 40s).
      if (attempts < 20) {
        setTimeout(check, 2000)
      } else {
        if (!cancelled) setPhase('pending')
      }
    }
    check()

    return () => {
      cancelled = true
    }
  }, [order])

  const isSubscription = data?.kind === 'subscription'
  const planLabel = tierName(data?.tier ?? data?.subscriptionTier)
  const expiresLabel = formatDate(data?.subscriptionExpiresAt)

  return (
    <div className="min-h-screen bg-background">
      <Header />
      <main className="mx-auto flex max-w-[560px] flex-col items-center px-4 py-16">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="w-full rounded-xl border border-border bg-card p-8 text-center"
          style={{ boxShadow: 'var(--shadow-md)' }}
        >
          {phase === 'processing' && (
            <>
              <Loader2 className="mx-auto mb-4 h-14 w-14 animate-spin text-primary" />
              <h1 className="font-display text-2xl font-bold tracking-tight">Обрабатываем платёж…</h1>
              <p className="mt-2 text-sm text-muted-foreground">
                Подтверждаем оплату. Это займёт несколько секунд.
              </p>
            </>
          )}

          {phase === 'approved' && isSubscription && (
            <>
              <Crown className="mx-auto mb-4 h-14 w-14 text-primary" />
              <h1 className="font-display text-2xl font-bold tracking-tight">Подписка активирована</h1>
              <p className="mt-2 text-sm text-muted-foreground">
                {planLabel ? `План ${planLabel} активен. ` : 'Подписка активна. '}
                Открыт доступ к премиум-функциям.
              </p>
              {expiresLabel && (
                <div className="mt-5 inline-flex items-center gap-2 rounded-full bg-primary/10 px-4 py-2 text-sm font-medium text-primary">
                  <Clock className="h-4 w-4" />
                  Действует до {expiresLabel}
                </div>
              )}
            </>
          )}

          {phase === 'approved' && !isSubscription && (
            <>
              <CheckCircle2 className="mx-auto mb-4 h-14 w-14 text-green-400" />
              <h1 className="font-display text-2xl font-bold tracking-tight">Покупка успешна</h1>
              <p className="mt-2 text-sm text-muted-foreground">
                {data?.productName ? `«${data.productName}» оплачен.` : 'Платёж прошёл успешно.'}
              </p>
              <div className="mt-5 flex flex-col items-center gap-2">
                {typeof data?.credits === 'number' && data.credits > 0 && (
                  <div className="inline-flex items-center gap-2 rounded-full bg-green-500/10 px-4 py-2 text-sm font-semibold text-green-400">
                    <Coins className="h-4 w-4" />
                    +{data.credits} кредитов начислено
                  </div>
                )}
                {typeof data?.balance === 'number' && (
                  <div className="inline-flex items-center gap-2 rounded-full bg-muted px-4 py-2 text-sm">
                    <Coins className="h-4 w-4 text-primary" />
                    Текущий баланс:{' '}
                    <span className="font-mono font-bold text-primary">{data.balance}</span> кредитов
                  </div>
                )}
              </div>
            </>
          )}

          {phase === 'pending' && (
            <>
              <Clock className="mx-auto mb-4 h-14 w-14 text-primary" />
              <h1 className="font-display text-2xl font-bold tracking-tight">Платёж обрабатывается</h1>
              {needLogin ? (
                <p className="mt-2 text-sm text-muted-foreground">
                  Готово. Если вы не авторизованы на этом устройстве — войдите, изменения уже применены.
                </p>
              ) : (
                <p className="mt-2 text-sm text-muted-foreground">
                  Оплата принята, статус обновится в течение пары минут. Баланс и подписка обновятся автоматически.
                </p>
              )}
            </>
          )}

          {phase === 'declined' && (
            <>
              <AlertCircle className="mx-auto mb-4 h-14 w-14 text-destructive" />
              <h1 className="font-display text-2xl font-bold tracking-tight">Платёж отклонён</h1>
              <p className="mt-2 text-sm text-muted-foreground">
                Оплата не была завершена. Попробуйте ещё раз или выберите другой способ оплаты.
              </p>
            </>
          )}

          <div className="mt-8 flex flex-col items-center gap-3">
            {phase === 'pending' && needLogin && (
              <Link
                href="/login"
                className="flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground transition hover:brightness-110"
              >
                <LogIn className="h-4 w-4" />
                Войти
              </Link>
            )}
            <Link
              href="/dashboard"
              className={`flex w-full items-center justify-center gap-2 rounded-lg px-5 py-2.5 text-sm font-semibold transition ${
                phase === 'pending' && needLogin
                  ? 'bg-muted hover:bg-muted/80'
                  : 'bg-primary text-primary-foreground hover:brightness-110'
              }`}
            >
              <Home className="h-4 w-4" />
              На главную
            </Link>
            {phase === 'approved' && isSubscription ? (
              <Link
                href="/pricing"
                className="flex items-center gap-1.5 text-xs text-muted-foreground underline-offset-2 hover:text-primary hover:underline"
              >
                <CreditCard className="h-3.5 w-3.5" />
                К тарифам
              </Link>
            ) : (
              <Link
                href="/pricing"
                className="text-xs text-muted-foreground underline-offset-2 hover:text-primary hover:underline"
              >
                Вернуться к тарифам
              </Link>
            )}
          </div>
        </motion.div>
      </main>
    </div>
  )
}
