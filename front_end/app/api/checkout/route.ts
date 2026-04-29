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

        const url = `${BACKEND_URL}/api/v1/billing/checkout`
        console.log(`[Proxy-Debug] POST ${url}`);

        // Detect the original origin from the browser's request to this proxy
        const origin = request.headers.get("origin") || request.headers.get("referer");
        let frontendOrigin: string | undefined;
        if (origin) {
            try {
                frontendOrigin = new URL(origin).origin;
            } catch { /* invalid header */ }
        }

        const response = await fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: token || ""
            },
            body: JSON.stringify({
                chargerId,
                frontendOrigin,
                platform: "web"
            })

        })

        const result = await response.json()

        if (!response.ok || !result.success) {
            return NextResponse.json(
                { error: result.error || "Failed to create checkout session" },
                { status: response.status }
            )
        }

        return NextResponse.json({ url: result.data.checkoutUrl })
    } catch (err) {
        console.error("[Checkout Proxy] Error:", err)
        return NextResponse.json({ error: "Failed to create checkout session" }, { status: 500 })
    }
}
