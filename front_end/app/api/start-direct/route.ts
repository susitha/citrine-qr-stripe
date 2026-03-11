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

    const headers = { Authorization: token || "" }

    // 1. Check if user has a card
    const statusRes = await fetch(`${BACKEND_URL}/api/v1/billing/direct-status`, { headers })
    const statusData = await statusRes.json()

    if (!statusRes.ok || !statusData.success || !statusData.data.hasCard) {
        return NextResponse.json({ canDirect: false }, { status: statusRes.status })
    }

    // 2. Start charging
    const startRes = await fetch(`${BACKEND_URL}/api/v1/charger/start`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            ...headers
        },
        body: JSON.stringify({ chargerId })
    })

    const startData = await startRes.json()
    if (!startRes.ok || !startData.success) {
        return NextResponse.json({ error: startData.error }, { status: startRes.status })
    }

    return NextResponse.json({ canDirect: true })
}
