import { NextResponse } from "next/server"

const BACKEND_URL = process.env.BACKEND_URL || "http://localhost:3000"

/**
 * GET /api/start-direct?chargerId=...&email=...
 * Proxies to Express /api/start-direct/:chargerId
 */
export async function GET(request: Request) {
    const { searchParams } = new URL(request.url)
    const chargerId = searchParams.get("chargerId")
    const email = searchParams.get("email")
    const token = request.headers.get("Authorization")

    if (!chargerId || !email) {
        return NextResponse.json({ error: "chargerId and email are required" }, { status: 400 })
    }

    const res = await fetch(
        `${BACKEND_URL}/api/start-direct/${encodeURIComponent(chargerId)}?email=${encodeURIComponent(email)}`,
        { headers: { Authorization: token || "" } }
    )
    const data = await res.json()
    if (!res.ok) return NextResponse.json({ error: data.error }, { status: res.status })
    return NextResponse.json(data)
}
