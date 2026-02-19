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
import { Smartphone, ArrowLeft, Loader2 } from "lucide-react"
import { toast } from "sonner"

interface PhoneStepProps {
    chargerId: string
    onOtpSent: (phone: string, session: string) => void
    onBack: () => void
}

export function PhoneStep({ chargerId, onOtpSent, onBack }: PhoneStepProps) {
    const [phone, setPhone] = useState("")
    const [isLoading, setIsLoading] = useState(false)
    const [error, setError] = useState("")

    async function handleSubmit(e: React.FormEvent) {
        e.preventDefault()
        setError("")

        const trimmedPhone = phone.trim()
        if (!trimmedPhone) {
            setError("Phone number is required")
            return
        }

        // Validate E.164 format: + followed by 7-15 digits
        const phoneRegex = /^\+[1-9]\d{6,14}$/
        if (!phoneRegex.test(trimmedPhone)) {
            setError("Enter a valid phone number in international format, e.g. +94771234567")
            return
        }

        setIsLoading(true)

        try {
            const response = await fetch("/api/otp/send", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ phone: trimmedPhone, chargerId }),
            })

            const data = await response.json()

            if (!response.ok) {
                setError(data.error || "Failed to send OTP")
                return
            }

            toast.success("Verification code sent!", {
                description: `Check your SMS at ${trimmedPhone}`,
            })

            // Pass both the phone number AND Cognito challenge session to parent
            onOtpSent(trimmedPhone, data.session)
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
                        <Smartphone className="h-8 w-8 text-primary" />
                    </div>
                    <CardTitle className="text-xl">Verify Your Phone</CardTitle>
                    <CardDescription>
                        {"We'll send a 6-digit verification code via SMS to confirm your identity before starting the charge."}
                    </CardDescription>
                </CardHeader>
                <CardContent>
                    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
                        <div className="flex flex-col gap-2">
                            <label
                                htmlFor="phone"
                                className="text-sm font-medium text-foreground"
                            >
                                Phone Number
                            </label>
                            <div className="relative">
                                <Smartphone className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                                <Input
                                    id="phone"
                                    type="tel"
                                    placeholder="+94771234567"
                                    value={phone}
                                    onChange={(e) => {
                                        setPhone(e.target.value)
                                        setError("")
                                    }}
                                    className="pl-9"
                                    autoComplete="tel"
                                    autoFocus
                                />
                            </div>
                            <p className="text-xs text-muted-foreground">
                                International format required, e.g. +1 (US), +94 (Sri Lanka), +44 (UK)
                            </p>
                            {error && (
                                <p className="text-sm text-destructive" role="alert">
                                    {error}
                                </p>
                            )}
                        </div>

                        <Button type="submit" disabled={isLoading} className="w-full">
                            {isLoading ? (
                                <>
                                    <Loader2 className="h-4 w-4 animate-spin" />
                                    Sending code...
                                </>
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
                    {chargerId}. Your phone number is used only for session verification.
                </p>
            </div>
        </div>
    )
}
