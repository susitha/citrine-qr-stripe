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

    const res = await fetch(`${BACKEND_URL}/api/v1/charger/session/${encodeURIComponent(transactionId)}`, {
        headers: { Authorization: token || "" },
    })
    const result = await res.json()
    if (!res.ok || !result.success) {
        return NextResponse.json({ error: result.error || "Failed to fetch bill" }, { status: res.status })
    }

    // Map to the object expected by the frontend
    const bill = result.data;
    return NextResponse.json({
        finalCharged: !!bill.final_charged || bill.status === 'completed',
        kwh: bill.totalKwh || bill.kwh || 0,
        cost: bill.totalCost || bill.cost || 0,
        transactionId: bill.transactionId
    })
}
