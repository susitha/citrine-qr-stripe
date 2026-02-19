import { NextResponse } from "next/server"

const BACKEND_URL = process.env.BACKEND_URL || "http://localhost:3000"

export async function POST(request: Request) {
  try {
    const { email, chargerId } = await request.json()

    if (!email || !chargerId) {
      return NextResponse.json({ error: "Email and charger ID are required" }, { status: 400 })
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    if (!emailRegex.test(email)) {
      return NextResponse.json({ error: "Invalid email address" }, { status: 400 })
    }

    const response = await fetch(`${BACKEND_URL}/api/auth/request-otp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    })

    const data = await response.json()

    if (!response.ok) {
      return NextResponse.json({ error: data.error || "Failed to send OTP" }, { status: response.status })
    }

    // Return Cognito session — needed for the verify step
    return NextResponse.json({ success: true, message: "OTP sent to your email", session: data.session })
  } catch (err) {
    console.error("[OTP Send] Error:", err)
    return NextResponse.json({ error: "Failed to send OTP" }, { status: 500 })
  }
}
