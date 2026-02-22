"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  InputOTP,
  InputOTPGroup,
  InputOTPSlot,
  InputOTPSeparator,
} from "@/components/ui/input-otp"
import { ShieldCheck, ArrowLeft, Loader2, RotateCw } from "lucide-react"
import { toast } from "sonner"

interface OtpStepProps {
  identifier: string
  chargerId: string
  /** Cognito challenge session from the send step */
  session: string
  onVerified: (token: string) => void
  onBack: () => void
  onResend: (newSession: string) => void
}

export function OtpStep({ identifier, chargerId, session, onVerified, onBack, onResend }: OtpStepProps) {
  const [otp, setOtp] = useState("")
  const [isLoading, setIsLoading] = useState(false)
  const [isResending, setIsResending] = useState(false)
  const [error, setError] = useState("")

  const OTP_METHOD = process.env.NEXT_PUBLIC_OTP_METHOD || "email"
  const isSms = OTP_METHOD === "sms"

  async function handleVerify() {
    setError("")
    if (otp.length !== 8) { setError("Please enter the full 8-digit code"); return }
    setIsLoading(true)
    try {
      const response = await fetch("/api/otp/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          [isSms ? 'phone' : 'email']: identifier,
          chargerId,
          code: otp,
          session
        }),
      })
      const data = await response.json()
      if (!response.ok) {
        setError(data.error || "Verification failed")
        setOtp("")
        return
      }
      toast.success("Verified!")
      onVerified(data.token)
    } catch {
      setError("Network error. Please try again.")
    } finally {
      setIsLoading(false)
    }
  }

  async function handleResend() {
    setIsResending(true)
    setError("")
    setOtp("")
    try {
      const response = await fetch("/api/otp/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          [isSms ? 'phone' : 'email']: identifier,
          chargerId
        }),
      })
      const data = await response.json()
      if (response.ok) {
        toast.success(`New code sent to your ${isSms ? 'phone' : 'email'}!`)
        onResend(data.session) // Update session in parent with new Cognito session
      } else {
        toast.error(data.error || "Failed to resend code")
      }
    } catch {
      toast.error("Failed to resend code")
    } finally {
      setIsResending(false)
    }
  }

  // Mask display: su****@gmail.com or +947*****67
  const maskedIdentifier = isSms
    ? identifier.replace(/^(\+\d{3})(\d+)(\d{2})$/, (_, a, b, c) => a + "*".repeat(b.length) + c)
    : identifier.replace(/^(.{2})(.+)(@.+)$/, (_, a, b, c) => a + "*".repeat(Math.min(b.length, 4)) + c)

  return (
    <div className="flex flex-col gap-4">
      <button
        onClick={onBack}
        className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors self-start"
      >
        <ArrowLeft className="h-4 w-4" />
        Change {isSms ? 'phone' : 'email'}
      </button>

      <Card>
        <CardHeader className="text-center">
          <div className="mx-auto mb-2 flex h-16 w-16 items-center justify-center rounded-2xl bg-primary/10">
            <ShieldCheck className="h-8 w-8 text-primary" />
          </div>
          <CardTitle className="text-xl">Enter Verification Code</CardTitle>
          <CardDescription>
            {"We've sent an 8-digit code to"}{" "}
            <span className="font-medium text-foreground">{maskedIdentifier}</span>
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col items-center gap-5">
          <InputOTP
            maxLength={8}
            value={otp}
            onChange={(value) => { setOtp(value); setError("") }}
            onComplete={handleVerify}
          >
            <InputOTPGroup>
              <InputOTPSlot index={0} />
              <InputOTPSlot index={1} />
              <InputOTPSlot index={2} />
              <InputOTPSlot index={3} />
            </InputOTPGroup>
            <InputOTPSeparator />
            <InputOTPGroup>
              <InputOTPSlot index={4} />
              <InputOTPSlot index={5} />
              <InputOTPSlot index={6} />
              <InputOTPSlot index={7} />
            </InputOTPGroup>
          </InputOTP>

          {error && (
            <p className="text-sm text-destructive text-center" role="alert">{error}</p>
          )}

          <Button onClick={handleVerify} disabled={isLoading || otp.length !== 8} className="w-full">
            {isLoading ? <><Loader2 className="h-4 w-4 animate-spin" />Verifying...</> : "Verify & Continue"}
          </Button>

          <button
            onClick={handleResend}
            disabled={isResending}
            className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-primary transition-colors disabled:opacity-50"
          >
            <RotateCw className={`h-3.5 w-3.5 ${isResending ? "animate-spin" : ""}`} />
            {isResending ? "Sending..." : "Resend code"}
          </button>
        </CardContent>
      </Card>
    </div>
  )
}
