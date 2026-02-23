import { NextResponse } from "next/server"

const BACKEND_URL = process.env.BACKEND_URL || "http://localhost:3000"

/**
 * GET /api/session-bill?transactionId=...
 * Proxies to Express /api/session-bill/:transactionId
 */
export async function GET(request: Request) {
    const { searchParams } = new URL(request.url)
    const transactionId = searchParams.get("transactionId")
    const token = request.headers.get("Authorization")

    if (!transactionId) {
        return NextResponse.json({ error: "transactionId is required" }, { status: 400 })
    }

    const res = await fetch(`${BACKEND_URL}/api/session-bill/${encodeURIComponent(transactionId)}`, {
        headers: { Authorization: token || "" },
    })
    const data = await res.json()
    if (!res.ok) return NextResponse.json({ error: data.error }, { status: res.status })
    return NextResponse.json(data)
}
