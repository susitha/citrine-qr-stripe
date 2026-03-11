import { NextResponse } from "next/server"

const BACKEND_URL = process.env.BACKEND_URL || "http://localhost:3000"

export async function POST(request: Request) {
  try {
    const { email, phone } = await request.json()

    if (!email && !phone) {
      return NextResponse.json({ error: "Email or phone is required" }, { status: 400 })
    }

    const response = await fetch(`${BACKEND_URL}/api/v1/auth/request-otp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, phone }),
    })

    const result = await response.json()
    if (!response.ok || !result.success) {
      return NextResponse.json({ error: result.error || "Failed to send OTP" }, { status: response.status })
    }

    // Return Cognito session — needed for the verify step
    return NextResponse.json({
      success: true,
      message: result.data.message,
      session: result.data.session
    })
  } catch (err) {
    console.error("[OTP Send] Error:", err)
    return NextResponse.json({ error: "Failed to send OTP" }, { status: 500 })
  }
}
