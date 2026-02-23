import { NextResponse } from "next/server"

const BACKEND_URL = process.env.BACKEND_URL || "http://localhost:3000"

/**
 * GET /api/checkout?chargerId=...&email=...
 * Proxies to Express /api/checkout/:chargerId → returns Stripe Checkout URL
 * Forwards customer email so Stripe can find/create a Customer and save the card
 */
export async function GET(request: Request) {
    try {
        const { searchParams } = new URL(request.url)
        const chargerId = searchParams.get("chargerId")
        const email = searchParams.get("email") || ""
        const token = request.headers.get("Authorization")

        if (!chargerId) {
            return NextResponse.json({ error: "chargerId is required" }, { status: 400 })
        }

        const url = `${BACKEND_URL}/api/checkout/${encodeURIComponent(chargerId)}?email=${encodeURIComponent(email)}`

        const response = await fetch(url, {
            method: "GET",
            headers: { Authorization: token || "" },
        })

        const data = await response.json()

        if (!response.ok) {
            return NextResponse.json(
                { error: data.error || "Failed to create checkout session" },
                { status: response.status }
            )
        }

        return NextResponse.json({ url: data.url })
    } catch (err) {
        console.error("[Checkout Proxy] Error:", err)
        return NextResponse.json({ error: "Failed to create checkout session" }, { status: 500 })
    }
}
