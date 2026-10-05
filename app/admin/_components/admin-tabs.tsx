import Link from 'next/link'
import { BarChart3, Clapperboard } from 'lucide-react'

export type AdminTab = 'stats' | 'dramas'

/** Вкладки админки: «Статистика» (/admin) и «Драмы» (/admin/dramas). Серверный компонент — просто ссылки. */
export function AdminTabs({ active, labels }: { active: AdminTab; labels: Record<AdminTab, string> }) {
  const tabs: { key: AdminTab; href: string; icon: React.ReactNode }[] = [
    { key: 'stats', href: '/admin', icon: <BarChart3 className="h-4 w-4" /> },
    { key: 'dramas', href: '/admin/dramas', icon: <Clapperboard className="h-4 w-4" /> },
  ]
  return (
    <nav className="mt-5 flex gap-1 border-b border-border" data-testid="admin-tabs">
      {tabs.map((tab) => {
        const isActive = tab.key === active
        return (
          <Link
            key={tab.key}
            href={tab.href}
            aria-current={isActive ? 'page' : undefined}
            data-testid={`admin-tab-${tab.key}`}
            className={
              '-mb-px inline-flex items-center gap-2 border-b-2 px-4 py-2.5 text-sm font-medium transition ' +
              (isActive
                ? 'border-primary text-foreground'
                : 'border-transparent text-muted-foreground hover:border-border hover:text-foreground')
            }
          >
            {tab.icon} {labels[tab.key]}
          </Link>
        )
      })}
    </nav>
  )
}
