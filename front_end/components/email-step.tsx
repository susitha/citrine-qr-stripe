"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Mail, ArrowLeft, Loader2 } from "lucide-react"
import { toast } from "sonner"

interface EmailStepProps {
  chargerId: string
  onOtpSent: (email: string, session: string) => void
  onBack: () => void
}

export function EmailStep({ chargerId, onOtpSent, onBack }: EmailStepProps) {
  const [email, setEmail] = useState("")
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState("")

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError("")

    const trimmed = email.trim().toLowerCase()
    if (!trimmed) {
      setError("Email address is required")
      return
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
      setError("Enter a valid email address")
      return
    }

    setIsLoading(true)
    try {
      const response = await fetch("/api/otp/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: trimmed, chargerId }),
      })

      const data = await response.json()
      console.log(data)
      if (!response.ok) {
        setError(data.error || "Failed to send OTP")
        return
      }

      toast.success("Verification code sent!", {
        description: `Check your inbox at ${trimmed}`,
      })
      // Pass email AND Cognito challenge session to parent
      onOtpSent(trimmed, data.session)
    } catch {
      setError("Network error. Please try again.")
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <button
        onClick={onBack}
        className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors self-start"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to scanner
      </button>

      <Card>
        <CardHeader className="text-center">
          <div className="mx-auto mb-2 flex h-16 w-16 items-center justify-center rounded-2xl bg-primary/10">
            <Mail className="h-8 w-8 text-primary" />
          </div>
          <CardTitle className="text-xl">Verify Your Email</CardTitle>
          <CardDescription>
            {"We'll email you a 6-digit code to confirm your identity before starting the charge."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <label htmlFor="email" className="text-sm font-medium text-foreground">
                Email Address
              </label>
              <div className="relative">
                <Mail className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  id="email"
                  type="email"
                  placeholder="you@example.com"
                  value={email}
                  onChange={(e) => { setEmail(e.target.value); setError("") }}
                  className="pl-9"
                  autoComplete="email"
                  autoFocus
                />
              </div>
              {error && (
                <p className="text-sm text-destructive" role="alert">{error}</p>
              )}
            </div>

            <Button type="submit" disabled={isLoading} className="w-full">
              {isLoading ? (
                <><Loader2 className="h-4 w-4 animate-spin" />Sending code...</>
              ) : (
                "Send Verification Code"
              )}
            </Button>
          </form>
        </CardContent>
      </Card>

      <div className="rounded-lg border border-primary/15 bg-primary/5 p-4">
        <p className="text-xs text-muted-foreground leading-relaxed">
          <span className="font-semibold text-foreground">Connected to charger:</span>{" "}
          {chargerId}. Your email is used only for session verification.
        </p>
      </div>
    </div>
  )
}
