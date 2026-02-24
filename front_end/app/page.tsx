"use client"

import { useState, useCallback, useEffect, Suspense } from "react"
import Image from "next/image"
import { useSearchParams } from "next/navigation"
import { StepIndicator } from "@/components/step-indicator"
import { EmailStep } from "@/components/email-step"
import { OtpStep } from "@/components/otp-step"
import { ChargingStep } from "@/components/charging-step"
import { PhoneStep } from "@/components/phone-step"
import { Zap } from "lucide-react"
import { toast } from "sonner"

const OTP_METHOD = process.env.NEXT_PUBLIC_OTP_METHOD || "email"
const STEPS = [OTP_METHOD === "sms" ? "Phone" : "Email", "Verify", "Charge"]
const SESSION_KEY = "ev_session"

type AppStep = "loading" | "identity" | "otp" | "charging"

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
  const [step, setStep] = useState<AppStep>("loading")
  const [chargerId, setChargerId] = useState("")
  const [identifier, setIdentifier] = useState("")
  const [session, setSession] = useState("")
  const [token, setToken] = useState("")
  const [sessionKey, setSessionKey] = useState(0)
  const [paidFromStripe, setPaidFromStripe] = useState(false)
  const [hasPaidThisSession, setHasPaidThisSession] = useState(false)
  const [chargingFinished, setChargingFinished] = useState(false)

  // On load: restore chargerId and auth session; handle Stripe redirect params
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
    }

    // 3. Handle Stripe redirect params
    const paid = searchParams.get("paid")
    const cancelled = searchParams.get("cancelled")

    if (paid === "true" && resolvedChargerId && saved) {
      // Payment succeeded — auto-start polling (webhook already triggered remote start)
      setPaidFromStripe(true)
      setHasPaidThisSession(true)
      setStep("charging")
      return
    }

    if (cancelled === "true") {
      // Payment cancelled — stay on charging/ready screen, show toast
      toast.error("Payment cancelled", { description: "Your card was not charged." })
      if (resolvedChargerId && saved) {
        setStep("charging")
        return
      }
    }

    // Default: if session + chargerId → charging, else identity
    if (saved && resolvedChargerId) {
      setStep("charging")
      return
    }

    setStep("identity")
  }, [searchParams])


  const stepIndex = chargingFinished ? STEPS.length : STEPS.indexOf(
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
    setPaidFromStripe(false) // No longer auto-polling
    setChargingFinished(false)
    // NOTE: we keep hasPaidThisSession=true so we skip Stripe UI for the next session
    setSessionKey(k => k + 1)
  }, [])

  // Allow user to sign out (clear saved auth session only — charger ID stays)
  const handleSignOut = useCallback(() => {
    clearSession()
    setIdentifier("")
    setSession("")
    setToken("")
    setStep("identity")
  }, [])

  // Don't render anything until useEffect has determined the correct step
  if (step === "loading") return null

  return (
    <main className="min-h-screen bg-background">
      <header className="sticky top-0 z-50 border-b border-border/60 bg-background/90 backdrop-blur-xl">
        <div className="mx-auto flex h-14 max-w-md items-center justify-between px-4">
          <div className="flex items-center gap-2">
            <div className="relative h-9 w-9 overflow-hidden rounded-full border border-border/40 shadow-sm">
              <Image
                src="/logo.png"
                alt="Logo"
                fill
                className="object-cover"
              />
            </div>
            <span className="text-sm font-bold text-foreground tracking-tight">ELECTRON AMERICA</span>
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
            onUnauthorized={handleSignOut}
            paidFromStripe={paidFromStripe}
            hasPaidThisSession={hasPaidThisSession}
            onFinished={(val) => setChargingFinished(val)}
          />
        )}
      </div>

      <footer className="mx-auto max-w-md px-4 pb-8">
        <p className="text-center text-xs text-muted-foreground">
          ELECTRON AMERICA &mdash; EV Charging Made Simple
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
          <span>Loading ELECTRON AMERICA...</span>
        </div>
      </div>
    }>
      <AppContent />
    </Suspense>
  )
}
