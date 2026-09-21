export const dynamic = "force-dynamic";
import { NextResponse } from 'next/server'

/**
 * Paid-only credit model: this endpoint used to let any authenticated user grant
 * themselves arbitrary free credits. That is disabled — credits can ONLY be granted
 * by a verified WayForPay payment webhook (see /api/payment/wayforpay/callback).
 */
export async function POST() {
  return NextResponse.json(
    { error: 'Credits can only be purchased. This endpoint is disabled.' },
    { status: 410 },
  )
}
