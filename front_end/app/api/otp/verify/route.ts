import { NextResponse } from "next/server"

const BACKEND_URL = process.env.BACKEND_URL || "http://localhost:3000"

export async function POST(request: Request) {
  try {
    const { email, phone, code, session } = await request.json()

    if ((!email && !phone) || !code || !session) {
      return NextResponse.json(
        { error: "Identifier, OTP code, and session are required" },
        { status: 400 }
      )
    }

    // Forward to Express — Cognito verifies OTP against stored session
    const response = await fetch(`${BACKEND_URL}/api/auth/verify-otp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, phone, otp: code, session }),
    })

    const data = await response.json()

    if (!response.ok) {
      return NextResponse.json({ error: data.error || "Verification failed" }, { status: response.status })
    }

    return NextResponse.json({ success: true, message: "Verified", token: data.token })
  } catch (err) {
    console.error("[OTP Verify] Error:", err)
    return NextResponse.json({ error: "Failed to verify OTP" }, { status: 500 })
  }
}
