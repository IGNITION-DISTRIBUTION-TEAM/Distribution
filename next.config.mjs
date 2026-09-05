/** @type {import('next').NextConfig} */
const nextConfig = {
  env: {
    // Vercel exposes the commit as VERCEL_GIT_COMMIT_SHA, which is server-only.
    // Mapping it here inlines it into the client bundle at build time, so the
    // build marker in the UI is baked into the same JavaScript it labels and
    // cannot drift from it. Locally there is no such variable, so it says
    // "dev" rather than nothing.
    NEXT_PUBLIC_BUILD_SHA: process.env.VERCEL_GIT_COMMIT_SHA || "dev",
  },
}

export default nextConfig
