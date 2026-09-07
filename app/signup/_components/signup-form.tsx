'use client'

import { useState } from 'react'
import { signIn } from 'next-auth/react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { Film, Mail, Lock, User as UserIcon, Loader2 } from 'lucide-react'
import { motion } from 'framer-motion'

export function SignupForm() {
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const router = useRouter()

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const res = await fetch('/api/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, email, password }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data?.error ?? 'Signup failed')
        setLoading(false)
        return
      }
      const result = await signIn('credentials', {
        email,
        password,
        redirect: false,
      })
      if (result?.error) {
        setError('Account created but sign-in failed. Please log in.')
      } else {
        router.replace('/dashboard')
      }
    } catch {
      setError('Something went wrong')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background hero-gradient px-4">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="w-full max-w-md rounded-xl border border-border bg-card p-8"
        style={{ boxShadow: 'var(--shadow-lg)' }}
      >
        <div className="mb-8 text-center">
          <Link href="/" className="inline-flex items-center gap-2">
            <Film className="h-8 w-8 text-primary" />
            <span className="font-display text-2xl font-bold tracking-tight">
              <span className="text-primary">Foltum</span> Studio
            </span>
          </Link>
          <p className="mt-2 text-sm text-muted-foreground">
            Create your account to start making films
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {error && (
            <div className="rounded-lg bg-destructive/10 px-4 py-2 text-sm text-destructive">
              {error}
            </div>
          )}
          <div className="relative">
            <UserIcon className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              type="text"
              placeholder="Full Name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              className="w-full rounded-lg border border-input bg-background py-2.5 pl-10 pr-4 text-sm outline-none transition focus:border-primary focus:ring-1 focus:ring-primary"
            />
          </div>
          <div className="relative">
            <Mail className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              type="email"
              placeholder="Email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              className="w-full rounded-lg border border-input bg-background py-2.5 pl-10 pr-4 text-sm outline-none transition focus:border-primary focus:ring-1 focus:ring-primary"
            />
          </div>
          <div className="relative">
            <Lock className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              type="password"
              placeholder="Password (min 6 characters)"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={6}
              className="w-full rounded-lg border border-input bg-background py-2.5 pl-10 pr-4 text-sm outline-none transition focus:border-primary focus:ring-1 focus:ring-primary"
            />
          </div>
          <button
            type="submit"
            disabled={loading}
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-primary py-2.5 text-sm font-semibold text-primary-foreground transition hover:brightness-110 disabled:opacity-50"
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Create Account
          </button>
        </form>

        <p className="mt-6 text-center text-sm text-muted-foreground">
          Already have an account?{' '}
          <Link href="/login" className="font-medium text-primary hover:underline">
            Sign In
          </Link>
        </p>
      </motion.div>
    </div>
  )
}
