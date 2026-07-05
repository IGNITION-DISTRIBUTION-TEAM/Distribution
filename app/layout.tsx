import type { Metadata, Viewport } from 'next'
import { Inter } from 'next/font/google'
import { Toaster } from 'sonner'
import { AuthProvider } from '@/lib/auth-context'

import './globals.css'

const _inter = Inter({ subsets: ['latin'], variable: '--font-inter' })

export const metadata: Metadata = {
  title: 'Data Platform',
  description: 'Enterprise data management platform with Snowflake integration',
}

export const viewport: Viewport = {
  themeColor: '#1a1f2e',
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en">
      <body className="font-sans antialiased">
        <AuthProvider>{children}</AuthProvider>
        <Toaster richColors position="top-right" />
      </body>
    </html>
  )
}
