"use client"

import { useState, useCallback, useEffect, Suspense } from "react"
import { useSearchParams } from "next/navigation"
import { StepIndicator } from "@/components/step-indicator"
import { EmailStep } from "@/components/email-step"
import { OtpStep } from "@/components/otp-step"
import { ChargingStep } from "@/components/charging-step"
import { PhoneStep } from "@/components/phone-step"
import { Zap } from "lucide-react"

const OTP_METHOD = process.env.NEXT_PUBLIC_OTP_METHOD || "email"
const STEPS = [OTP_METHOD === "sms" ? "Phone" : "Email", "Verify", "Charge"]
const SESSION_KEY = "ev_session"

type AppStep = "identity" | "otp" | "charging"

// --- Session helpers ---
interface StoredSession {
  token: string
  identifier: string
  exp?: number
}

function loadSession(): StoredSession | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY)
    if (!raw) return null
    const s: StoredSession = JSON.parse(raw)
    // If JWT has expiry, check it
    if (s.exp && Date.now() / 1000 > s.exp) {
      localStorage.removeItem(SESSION_KEY)
      return null
    }
    return s
  } catch {
    return null
  }
}

function saveSession(token: string, identifier: string) {
  try {
    let exp: number | undefined
    try {
      const payload = JSON.parse(atob(token.split(".")[1]))
      exp = payload.exp
    } catch { /* non-JWT token — save without expiry */ }
    localStorage.setItem(SESSION_KEY, JSON.stringify({ token, identifier, exp }))
  } catch { /* storage unavailable */ }
}

function clearSession() {
  try { localStorage.removeItem(SESSION_KEY) } catch { /* ignore */ }
}

// --- App ---

function AppContent() {
  const searchParams = useSearchParams()
  const [step, setStep] = useState<AppStep>("identity")
  const [chargerId, setChargerId] = useState("")
  const [identifier, setIdentifier] = useState("")
  const [session, setSession] = useState("")
  const [token, setToken] = useState("")
  // Increment to force ChargingStep remount (resets its internal status to idle)
  const [sessionKey, setSessionKey] = useState(0)

  // On load: restore chargerId from sessionStorage or URL,
  // and restore auth session from localStorage.
  // If both are available → skip straight to charging.
  useEffect(() => {
    // 1. Resolve chargerId
    const qrChargerId = searchParams.get("chargerId")
    let resolvedChargerId = ""
    if (qrChargerId) {
      sessionStorage.setItem("chargerId", qrChargerId)
      resolvedChargerId = qrChargerId
    } else {
      resolvedChargerId = sessionStorage.getItem("chargerId") || ""
    }
    if (resolvedChargerId) setChargerId(resolvedChargerId)

    // 2. Check for a saved auth session
    const saved = loadSession()
    if (saved) {
      setToken(saved.token)
      setIdentifier(saved.identifier)
      // If we also have a charger ID → jump straight to charging
      if (resolvedChargerId) {
        setStep("charging")
        return
      }
    }

    // No saved session (or no chargerId) → start at identity
    setStep("identity")
  }, [searchParams])

  const stepIndex = STEPS.indexOf(
    step === "identity" ? (OTP_METHOD === "sms" ? "Phone" : "Email")
      : step === "otp" ? "Verify"
        : "Charge"
  )

  const handleOtpSent = useCallback((userId: string, cognitoSession: string) => {
    setIdentifier(userId)
    setSession(cognitoSession)
    setStep("otp")
  }, [])

  const handleVerified = useCallback((jwtToken: string) => {
    // Persist for future sessions
    saveSession(jwtToken, identifier)
    setToken(jwtToken)
    setStep("charging")
  }, [identifier])

  // Reset after session ends:
  // If still at the same charger with a valid token → go straight to Ready to Charge
  // Otherwise → go back to identity step
  const handleReset = useCallback(() => {
    setSession("")
    setSessionKey(k => k + 1)   // force ChargingStep remount → status resets to idle
    // intentionally keep token, identifier, chargerId
  }, [])

  // Allow user to sign out (clear saved auth session only — charger ID stays)
  const handleSignOut = useCallback(() => {
    clearSession()
    setIdentifier("")
    setSession("")
    setToken("")
    setStep("identity")
  }, [])

  return (
    <main className="min-h-screen bg-background">
      <header className="sticky top-0 z-50 border-b border-border/60 bg-background/90 backdrop-blur-xl">
        <div className="mx-auto flex h-14 max-w-md items-center justify-between px-4">
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary">
              <Zap className="h-4 w-4 text-primary-foreground" />
            </div>
            <span className="text-lg font-bold text-foreground tracking-tight">VoltCharge</span>
          </div>
          <div className="flex items-center gap-2">
            {chargerId && (
              <span className="rounded-full bg-secondary px-3 py-1 text-xs font-medium text-secondary-foreground">
                {chargerId}
              </span>
            )}
            {token && (
              <button
                onClick={handleSignOut}
                className="text-xs text-muted-foreground hover:text-destructive transition-colors"
                title="Sign out"
              >
                Sign out
              </button>
            )}
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-md px-4 pt-6 pb-2">
        <StepIndicator steps={STEPS} currentStep={stepIndex} />
      </div>

      <div className="mx-auto max-w-md px-4 py-6">
        {step === "identity" && (
          OTP_METHOD === "sms" ? (
            <PhoneStep
              chargerId={chargerId}
              onOtpSent={handleOtpSent}
            />
          ) : (
            <EmailStep
              chargerId={chargerId}
              onOtpSent={handleOtpSent}
            />
          )
        )}

        {step === "otp" && (
          <OtpStep
            identifier={identifier}
            chargerId={chargerId}
            session={session}
            onVerified={handleVerified}
            onBack={() => setStep("identity")}
            onResend={(newSession) => setSession(newSession)}
          />
        )}

        {step === "charging" && (
          <ChargingStep
            key={sessionKey}
            phone={identifier}
            chargerId={chargerId}
            token={token}
            onReset={handleReset}
          />
        )}
      </div>

      <footer className="mx-auto max-w-md px-4 pb-8">
        <p className="text-center text-xs text-muted-foreground">
          VoltCharge &mdash; EV Charging Made Simple
        </p>
      </footer>
    </main>
  )
}

export default function Home() {
  return (
    <Suspense fallback={
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="flex items-center gap-2 text-muted-foreground">
          <Zap className="h-5 w-5 animate-pulse text-primary" />
          <span>Loading VoltCharge...</span>
        </div>
      </div>
    }>
      <AppContent />
    </Suspense>
  )
}
