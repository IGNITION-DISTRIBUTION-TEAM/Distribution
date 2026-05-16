import { NextResponse } from "next/server"
import SftpClient from "ssh2-sftp-client"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"
export const maxDuration = 60

type Body = {
  host?: string
  port?: number | string
  username?: string
  password?: string
  privateKey?: string
  path?: string
}

export async function POST(request: Request) {
  let body: Body
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const host = (body.host ?? "").trim()
  const username = (body.username ?? "").trim()
  const port = Number(body.port ?? 22)
  const password = body.password ?? ""
  const privateKey = body.privateKey ?? ""
  const path = (body.path ?? "/").trim() || "/"

  if (!host) return NextResponse.json({ error: "host is required" }, { status: 400 })
  if (!username) return NextResponse.json({ error: "username is required" }, { status: 400 })
  if (!password && !privateKey)
    return NextResponse.json({ error: "password or privateKey is required" }, { status: 400 })
  if (!Number.isFinite(port) || port < 1 || port > 65535)
    return NextResponse.json({ error: "port must be 1-65535" }, { status: 400 })

  const sftp = new SftpClient()
  try {
    await sftp.connect({
      host,
      port,
      username,
      password: password || undefined,
      privateKey: privateKey || undefined,
      readyTimeout: 15_000,
    })

    const realPath = await sftp.realPath(path).catch(() => path)
    const list = await sftp.list(realPath)

    const entries = list.map((e) => ({
      name: e.name,
      type: e.type, // 'd' (dir), '-' (file), 'l' (link)
      size: e.size,
      modifyTime: e.modifyTime,
      accessTime: e.accessTime,
      rights: e.rights,
    }))

    // Build a parent path for navigation (unless we're at root)
    let parent: string | null = null
    if (realPath !== "/" && realPath.length > 1) {
      const idx = realPath.replace(/\/$/, "").lastIndexOf("/")
      parent = idx <= 0 ? "/" : realPath.slice(0, idx)
    }

    return NextResponse.json({
      path: realPath,
      parent,
      entries,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error("[/api/sftp/list] error:", message)
    return NextResponse.json({ error: message }, { status: 500 })
  } finally {
    sftp.end().catch(() => {})
  }
}
