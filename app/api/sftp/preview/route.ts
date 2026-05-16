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
  filePath?: string
  maxBytes?: number
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
  const filePath = (body.filePath ?? "").trim()
  const maxBytes = Math.min(Math.max(Number(body.maxBytes ?? 8192), 256), 100_000)

  if (!host) return NextResponse.json({ error: "host is required" }, { status: 400 })
  if (!username) return NextResponse.json({ error: "username is required" }, { status: 400 })
  if (!filePath) return NextResponse.json({ error: "filePath is required" }, { status: 400 })

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

    const stat = await sftp.stat(filePath)
    if (stat.isDirectory) {
      return NextResponse.json({ error: "Path is a directory, not a file" }, { status: 400 })
    }

    const buf = (await sftp.get(filePath)) as Buffer
    const truncated = buf.length > maxBytes
    const slice = buf.subarray(0, maxBytes)
    const text = slice.toString("utf-8")
    const isLikelyText = !/[\x00-\x08\x0E-\x1F]/.test(text.slice(0, 2000))

    return NextResponse.json({
      filePath,
      size: stat.size,
      modifyTime: stat.modifyTime,
      truncated,
      preview: isLikelyText ? text : "(binary content — preview omitted)",
      isLikelyText,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error("[/api/sftp/preview] error:", message)
    return NextResponse.json({ error: message }, { status: 500 })
  } finally {
    sftp.end().catch(() => {})
  }
}
