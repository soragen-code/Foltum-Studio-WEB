'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { Header } from '@/components/header'
import { CheckCircle2, Loader2, Home, Coins, AlertCircle } from 'lucide-react'
import { motion } from 'framer-motion'

type Phase = 'processing' | 'approved' | 'declined' | 'pending'

interface StatusResponse {
  status?: string
  processed?: boolean
  credits?: number
  productName?: string
  balance?: number
}

export function SuccessClient() {
  const params = useSearchParams()
  const order = params.get('order')

  const [phase, setPhase] = useState<Phase>(order ? 'processing' : 'pending')
  const [data, setData] = useState<StatusResponse | null>(null)

  // Poll the payment status until the server-to-server webhook has granted the credits.
  // The credits themselves are granted by /api/payment/wayforpay/callback — here we only reflect it.
  useEffect(() => {
    if (!order) return
    let cancelled = false
    let attempts = 0

    const check = async () => {
      attempts += 1
      try {
        const res = await fetch(`/api/payment/wayforpay/status?order=${encodeURIComponent(order)}`)
        if (res.ok) {
          const d: StatusResponse = await res.json()
          if (!cancelled) setData(d)
          if (d.status === 'approved') {
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
      if (attempts < 15) {
        setTimeout(check, 2000)
      } else {
        // Timed out waiting for the webhook — the payment may still be processing.
        if (!cancelled) setPhase('pending')
      }
    }
    check()

    return () => {
      cancelled = true
    }
  }, [order])

  return (
    <div className="min-h-screen bg-background">
      <Header showNewProject={false} />
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
                Подтверждаем оплату и начисляем кредиты. Это займёт несколько секунд.
              </p>
            </>
          )}

          {phase === 'approved' && (
            <>
              <CheckCircle2 className="mx-auto mb-4 h-14 w-14 text-green-400" />
              <h1 className="font-display text-2xl font-bold tracking-tight">Покупка успешна</h1>
              <p className="mt-2 text-sm text-muted-foreground">
                {data?.productName ? `«${data.productName}» оплачен.` : 'Платёж прошёл успешно.'}
              </p>
              <div className="mt-5 flex flex-col items-center gap-2">
                {typeof data?.credits === 'number' && (
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
              <Loader2 className="mx-auto mb-4 h-14 w-14 animate-spin text-primary" />
              <h1 className="font-display text-2xl font-bold tracking-tight">Платёж обрабатывается</h1>
              <p className="mt-2 text-sm text-muted-foreground">
                Кредиты появятся на балансе в течение пары минут. Можно вернуться на главную — баланс
                обновится автоматически.
              </p>
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
            <Link
              href="/dashboard"
              className="flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground transition hover:brightness-110"
            >
              <Home className="h-4 w-4" />
              На главную
            </Link>
            <Link
              href="/pricing"
              className="text-xs text-muted-foreground underline-offset-2 hover:text-primary hover:underline"
            >
              Вернуться к тарифам
            </Link>
          </div>
        </motion.div>
      </main>
    </div>
  )
}
