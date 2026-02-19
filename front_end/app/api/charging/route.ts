import { NextResponse } from "next/server"

const BACKEND_URL = process.env.BACKEND_URL || "http://localhost:3000"

/**
 * POST /api/charging
 * Start a charging session — calls Express /create-session/:chargerId/:phone
 * Polls for transactionId, returns it to the client
 */
export async function POST(request: Request) {
  try {
    const { phone, chargerId, token } = await request.json()

    if (!phone || !chargerId || !token) {
      return NextResponse.json(
        { error: "Phone, charger ID, and auth token are required" },
        { status: 400 }
      )
    }

    // Use phone as the OCPP idTag (user identifier)
    const encodedPhone = encodeURIComponent(phone)

    const response = await fetch(
      `${BACKEND_URL}/create-session/${chargerId}/${encodedPhone}`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
      }
    )

    const data = await response.json()

    if (!response.ok) {
      return NextResponse.json(
        { error: data.error || "Failed to start charging session" },
        { status: response.status }
      )
    }

    // Poll for the transaction ID (Express resolves this in background)
    // We return immediately and let the client poll /api/charging?chargerId=...
    return NextResponse.json({
      success: true,
      message: data.message,
      chargerId,
    })
  } catch (err) {
    console.error("[Charging POST] Error:", err)
    return NextResponse.json(
      { error: "Failed to start charging session" },
      { status: 500 }
    )
  }
}

/**
 * GET /api/charging?chargerId=...
 * Poll the active charging session for real-time kWh and cost data
 */
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const chargerId = searchParams.get("chargerId")
    const transactionId = searchParams.get("transactionId")

    if (!chargerId && !transactionId) {
      return NextResponse.json(
        { error: "chargerId or transactionId is required" },
        { status: 400 }
      )
    }

    // If we have a transactionId, fetch session directly
    if (transactionId) {
      const response = await fetch(
        `${BACKEND_URL}/api/active-session/${transactionId}`
      )
      const data = await response.json()

      if (!response.ok) {
        return NextResponse.json({ error: data.error }, { status: response.status })
      }

      return NextResponse.json({ session: data })
    }

    // Otherwise, get charger status (find transactionId)
    const response = await fetch(
      `${BACKEND_URL}/api/charger-status/${chargerId}`
    )
    const data = await response.json()

    if (!response.ok) {
      return NextResponse.json({ error: data.error }, { status: response.status })
    }

    return NextResponse.json({ chargerStatus: data })
  } catch (err) {
    console.error("[Charging GET] Error:", err)
    return NextResponse.json(
      { error: "Failed to get session" },
      { status: 500 }
    )
  }
}

/**
 * PATCH /api/charging
 * Stop a charging session
 */
export async function PATCH(request: Request) {
  try {
    const { chargerId, transactionId, token } = await request.json()

    if (!chargerId || !transactionId || !token) {
      return NextResponse.json(
        { error: "chargerId, transactionId, and token are required" },
        { status: 400 }
      )
    }

    const response = await fetch(
      `${BACKEND_URL}/api/stop-charging/${chargerId}/${transactionId}`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
      }
    )

    const data = await response.json()

    if (!response.ok) {
      return NextResponse.json(
        { error: data.error || "Failed to stop charging" },
        { status: response.status }
      )
    }

    return NextResponse.json({
      success: true,
      message: data.message,
    })
  } catch (err) {
    console.error("[Charging PATCH] Error:", err)
    return NextResponse.json(
      { error: "Failed to stop charging" },
      { status: 500 }
    )
  }
}
