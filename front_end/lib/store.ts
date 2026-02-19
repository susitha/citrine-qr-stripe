// In-memory store for OTP codes and charging sessions
// In production, use a database like Neon or Supabase

interface OtpRecord {
  code: string
  email: string
  chargerId: string
  expiresAt: number
  verified: boolean
}

interface ChargingSession {
  id: string
  email: string
  chargerId: string
  startedAt: number
  energyDelivered: number // kWh
  powerRate: number // kW
  status: "charging" | "completed" | "stopped"
  stoppedAt?: number
}

const otpStore = new Map<string, OtpRecord>()
const chargingSessions = new Map<string, ChargingSession>()

export function generateOtp(): string {
  return Math.floor(100000 + Math.random() * 900000).toString()
}

export function storeOtp(email: string, chargerId: string): string {
  const code = generateOtp()
  const key = `${email}:${chargerId}`

  otpStore.set(key, {
    code,
    email,
    chargerId,
    expiresAt: Date.now() + 5 * 60 * 1000, // 5 minutes
    verified: false,
  })

  return code
}

export function verifyOtp(
  email: string,
  chargerId: string,
  code: string
): { success: boolean; message: string } {
  const key = `${email}:${chargerId}`
  const record = otpStore.get(key)

  if (!record) {
    return { success: false, message: "No OTP found. Please request a new one." }
  }

  if (Date.now() > record.expiresAt) {
    otpStore.delete(key)
    return { success: false, message: "OTP has expired. Please request a new one." }
  }

  if (record.code !== code) {
    return { success: false, message: "Invalid OTP code. Please try again." }
  }

  record.verified = true
  otpStore.set(key, record)
  return { success: true, message: "Email verified successfully." }
}

export function createChargingSession(
  email: string,
  chargerId: string
): ChargingSession {
  const id = `session_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  const session: ChargingSession = {
    id,
    email,
    chargerId,
    startedAt: Date.now(),
    energyDelivered: 0,
    powerRate: 50 + Math.random() * 100, // 50-150 kW
    status: "charging",
  }

  chargingSessions.set(id, session)
  return session
}

export function getChargingSession(
  sessionId: string
): ChargingSession | undefined {
  const session = chargingSessions.get(sessionId)

  if (session && session.status === "charging") {
    // Simulate energy delivery based on time elapsed
    const elapsedHours = (Date.now() - session.startedAt) / (1000 * 60 * 60)
    session.energyDelivered = Math.round(session.powerRate * elapsedHours * 100) / 100
  }

  return session
}

export function stopChargingSession(
  sessionId: string
): ChargingSession | undefined {
  const session = chargingSessions.get(sessionId)

  if (session && session.status === "charging") {
    const elapsedHours = (Date.now() - session.startedAt) / (1000 * 60 * 60)
    session.energyDelivered =
      Math.round(session.powerRate * elapsedHours * 100) / 100
    session.status = "stopped"
    session.stoppedAt = Date.now()
    chargingSessions.set(sessionId, session)
  }

  return session
}
