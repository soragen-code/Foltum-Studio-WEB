import NextAuth from 'next-auth'
import CredentialsProvider from 'next-auth/providers/credentials'
import { PrismaAdapter } from '@auth/prisma-adapter'
import { prisma } from '@/lib/db'
import bcrypt from 'bcryptjs'

export const { handlers, auth, signIn, signOut } = NextAuth({
  trustHost: true,
  adapter: PrismaAdapter(prisma),
  session: { strategy: 'jwt' },
  pages: {
    signIn: '/login',
  },
  providers: [
    CredentialsProvider({
      name: 'credentials',
      credentials: {
        email: { label: 'Email', type: 'email' },
        password: { label: 'Password', type: 'password' },
      },
      async authorize(credentials) {
        if (!credentials?.email || !credentials?.password) return null

        const user = await prisma.user.findUnique({
          where: { email: credentials.email as string },
        })

        if (!user?.password) return null

        const isValid = await bcrypt.compare(
          credentials.password as string,
          user.password
        )

        if (!isValid) return null

        return {
          id: user.id,
          email: user.email,
          name: user.name,
        }
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        token.id = user.id
      }
      // Keep subscription tier / expiry / credits fresh in the token by re-reading them
      // from the DB (lightweight, selected columns only). This is what lets the header,
      // pricing page and success page reflect an active plan right after payment.
      const id = token.id as string | undefined
      if (id) {
        try {
          const dbUser = await prisma.user.findUnique({
            where: { id },
            select: {
              subscriptionTier: true,
              subscriptionExpiresAt: true,
              credits: true,
            },
          })
          if (dbUser) {
            ;(token as any).subscriptionTier = dbUser.subscriptionTier ?? null
            ;(token as any).subscriptionExpiresAt = dbUser.subscriptionExpiresAt
              ? dbUser.subscriptionExpiresAt.toISOString()
              : null
            ;(token as any).credits = dbUser.credits ?? 0
          }
        } catch {
          // Never break auth if the read fails — the session keeps its previous values.
        }
      }
      return token
    },
    async session({ session, token }) {
      if (session?.user && token?.id) {
        const u = session.user as any
        u.id = token.id as string
        u.subscriptionTier = (token as any).subscriptionTier ?? null
        u.subscriptionExpiresAt = (token as any).subscriptionExpiresAt ?? null
        u.credits = (token as any).credits ?? 0
      }
      return session
    },
  },
})
