import { NextResponse } from "next/server"

const BACKEND_URL = process.env.BACKEND_URL || "http://localhost:3000"

/**
 * POST /api/charging
 * Start a charging session — calls Express /create-session/:chargerId/:phone
 * Polls for transactionId, returns it to the client
 */
export async function POST(request: Request) {
  try {
    const { chargerId, token } = await request.json()

    if (!chargerId || !token) {
      return NextResponse.json(
        { error: "chargerId and auth token are required" },
        { status: 400 }
      )
    }

    const url = `${BACKEND_URL}/api/v1/charger/start`;
    console.log(`[Proxy-Debug] POST ${url}`);

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({ chargerId })
    })

    const result = await response.json()

    if (!response.ok || !result.success) {
      return NextResponse.json(
        { error: result.error || "Failed to start charging session" },
        { status: response.status }
      )
    }

    return NextResponse.json({
      success: true,
      data: result.data,
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
    const token = request.headers.get("Authorization")

    if (!chargerId && !transactionId) {
      return NextResponse.json(
        { error: "chargerId or transactionId is required" },
        { status: 400 }
      )
    }

    // If we have a transactionId, fetch session directly
    if (transactionId) {
      const response = await fetch(
        `${BACKEND_URL}/api/v1/charger/session/${transactionId}`,
        { headers: { Authorization: token || "" } }
      )
      const result = await response.json()

      if (!response.ok || !result.success) {
        return NextResponse.json({ error: result.error || "Session check failed" }, { status: response.status })
      }

      // Maintain legacy response mapping if needed, or return raw data
      return NextResponse.json({ session: result.data })
    }

    // Otherwise, get charger status (find transactionId)
    const url = `${BACKEND_URL}/api/v1/charger/status/${chargerId}`;
    console.log(`[Proxy-Debug] GET ${url}`);

    const response = await fetch(url)
    const result = await response.json()

    if (!response.ok || !result.success) {
      return NextResponse.json({ error: result.error || "Status check failed" }, { status: response.status })
    }

    // Backwards compatibility for the frontend 'chargerStatus' expectation
    return NextResponse.json({ chargerStatus: result.data })
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

    // Notice: V1 endpoint for stop is a POST, but we keep PATCH in the proxy for web frontend compat
    const response = await fetch(
      `${BACKEND_URL}/api/v1/charger/stop`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({ chargerId, transactionId })
      }
    )

    const result = await response.json()

    if (!response.ok || !result.success) {
      return NextResponse.json(
        { error: result.error || "Failed to stop charging" },
        { status: response.status }
      )
    }

    return NextResponse.json({
      success: true,
      message: result.data.message || "Stop command sent",
    })
  } catch (err) {
    console.error("[Charging PATCH] Error:", err)
    return NextResponse.json(
      { error: "Failed to stop charging" },
      { status: 500 }
    )
  }
}
