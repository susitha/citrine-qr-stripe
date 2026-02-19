"use client"

import { useState, useCallback, useEffect, Suspense } from "react"
import { useSearchParams } from "next/navigation"
import { StepIndicator } from "@/components/step-indicator"
import { QrScannerStep } from "@/components/qr-scanner-step"
import { EmailStep } from "@/components/email-step"
import { OtpStep } from "@/components/otp-step"
import { ChargingStep } from "@/components/charging-step"
import { Zap } from "lucide-react"

const STEPS = ["Scan", "Email", "Verify", "Charge"]

type AppStep = "scan" | "email" | "otp" | "charging"

function AppContent() {
  const searchParams = useSearchParams()
  const [step, setStep] = useState<AppStep>("scan")
  const [chargerId, setChargerId] = useState("")
  const [email, setEmail] = useState("")
  /** Cognito challenge session — returned from send OTP, required for verify */
  const [session, setSession] = useState("")
  const [token, setToken] = useState("")

  // If QR URL contains ?chargerId=..., skip to email step
  useEffect(() => {
    const qrChargerId = searchParams.get("chargerId")
    if (qrChargerId) {
      setChargerId(qrChargerId)
      setStep("email")
    }
  }, [searchParams])

  const stepIndex = STEPS.indexOf(
    step === "scan" ? "Scan"
      : step === "email" ? "Email"
        : step === "otp" ? "Verify"
          : "Charge"
  )

  const handleChargerFound = useCallback((id: string) => {
    setChargerId(id)
    setStep("email")
  }, [])

  const handleOtpSent = useCallback((userEmail: string, cognitoSession: string) => {
    setEmail(userEmail)
    setSession(cognitoSession)
    setStep("otp")
  }, [])

  const handleVerified = useCallback((jwtToken: string) => {
    setToken(jwtToken)
    setStep("charging")
  }, [])

  const handleReset = useCallback(() => {
    setStep("scan")
    setChargerId("")
    setEmail("")
    setSession("")
    setToken("")
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
          {chargerId && (
            <span className="rounded-full bg-secondary px-3 py-1 text-xs font-medium text-secondary-foreground">
              {chargerId}
            </span>
          )}
        </div>
      </header>

      <div className="mx-auto max-w-md px-4 pt-6 pb-2">
        <StepIndicator steps={STEPS} currentStep={stepIndex} />
      </div>

      <div className="mx-auto max-w-md px-4 py-6">
        {step === "scan" && <QrScannerStep onChargerFound={handleChargerFound} />}

        {step === "email" && (
          <EmailStep
            chargerId={chargerId}
            onOtpSent={handleOtpSent}
            onBack={() => setStep("scan")}
          />
        )}

        {step === "otp" && (
          <OtpStep
            email={email}
            chargerId={chargerId}
            session={session}
            onVerified={handleVerified}
            onBack={() => setStep("email")}
            onResend={(newSession) => setSession(newSession)}
          />
        )}

        {step === "charging" && (
          <ChargingStep
            phone={email}
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
