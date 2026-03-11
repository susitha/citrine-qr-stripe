"use client"

import { useState, useEffect, useCallback, useRef } from "react"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Progress } from "@/components/ui/progress"
import { Badge } from "@/components/ui/badge"
import {
  Zap,
  Battery,
  Clock,
  BatteryCharging,
  CircleStop,
  Loader2,
  CheckCircle2,
  RotateCcw,
  CreditCard,
  Play,
  Square,
  AlertCircle,
  Phone,
  Smartphone,
  MapPin,
  Gauge,
} from "lucide-react"
import { toast } from "sonner"

function BatteryChargingIndicator({ level }: { level: number }) {
  return (
    <div className="flex flex-col items-center gap-6 py-8">
      <div className="relative w-32 h-52">
        {/* Battery Container */}
        <div className="absolute inset-0 bg-secondary/10 rounded-[2rem] border-4 border-muted-foreground/15 backdrop-blur-sm overflow-hidden p-1.5 shadow-inner">
          {/* Progress Fill */}
          <div
            className="absolute bottom-1.5 left-1.5 right-1.5 rounded-[1.4rem] bg-gradient-to-t from-primary/90 via-primary to-primary transition-all duration-1000 ease-out shadow-[0_0_20px_rgba(var(--primary),0.2)]"
            style={{ height: `calc(${level}% - 12px)` }}
          >
            {/* Liquid Surface Effect */}
            <div className="absolute -top-3 left-0 right-0 h-6">
              <div className="absolute inset-0 bg-white/20 blur-lg animate-pulse" />
              <div className="absolute top-0 left-0 right-0 h-1 bg-white/20 rounded-full" />
            </div>

            {/* Center Zap Icon */}
            <div className="absolute inset-0 flex items-center justify-center">
              <Zap className="h-10 w-10 text-primary-foreground fill-current animate-[pulse_2s_infinite]" />
            </div>
          </div>

          {/* Glass Reflection */}
          <div className="absolute top-1/4 left-3 w-1 h-1/3 bg-white/5 rounded-full blur-[0.5px]" />
        </div>

        {/* Battery Head/Tip */}
        <div className="absolute -top-3 left-1/2 -translate-x-1/2 w-10 h-3 bg-muted-foreground/20 rounded-t-lg border-t-4 border-x-4 border-muted-foreground/10" />
      </div>

      <div className="flex flex-col items-center gap-0.5">
        <div className="flex items-baseline gap-1">
          <span className="text-5xl font-black font-mono tracking-tighter text-foreground tabular-nums">
            {Math.round(level)}
          </span>
          <span className="text-xl font-bold text-muted-foreground">%</span>
        </div>
        <span className="text-[10px] font-bold uppercase tracking-[0.25em] text-primary/80 animate-pulse">
          Active Charge
        </span>
      </div>
    </div>
  )
}

function PlugAnimation() {
  return (
    <div className="flex flex-col items-center gap-4 py-4 w-full max-w-[280px]">
      <div className="relative h-32 w-full bg-gradient-to-b from-primary/10 to-transparent rounded-3xl border-2 border-dashed border-primary/30 flex items-center justify-center overflow-hidden">
        {/* Animated Plug Icon */}
        <div className="flex flex-col items-center gap-2 animate-bounce">
          <div className="bg-primary p-4 rounded-2xl shadow-[0_0_20px_rgba(var(--primary),0.3)]">
            <Zap className="h-10 w-10 text-primary-foreground fill-current" />
          </div>
          <div className="h-4 w-1.5 bg-primary/40 rounded-full" />
        </div>

        {/* Connection Port indicator */}
        <div className="absolute bottom-4 h-1 w-20 bg-primary/20 rounded-full overflow-hidden">
          <div className="h-full w-full bg-primary animate-pulse" />
        </div>
      </div>
    </div>
  )
}

interface ChargingStepProps {
  phone: string
  chargerId: string
  token: string
  onReset: () => void
  paidFromStripe: boolean      // true only when just returned from redirect
  hasPaidThisSession: boolean  // true after first payment in this login
  onFinished: (val: boolean) => void
  onUnauthorized?: () => void
}

type SessionStatus = "idle" | "starting" | "charging" | "stopping" | "billing" | "completed" | "stopped"

interface LiveSession {
  transactionId: string | null
  stationId: string
  isActive: boolean
  startTime: string | null
  totalKwh: number
  totalCost: number
}

export function ChargingStep({ phone, chargerId, token, onReset, paidFromStripe, hasPaidThisSession, onFinished, onUnauthorized }: ChargingStepProps) {
  const [status, _setStatus] = useState<SessionStatus>("idle")
  const statusRef = useRef<SessionStatus>("idle")
  const setStatus = (s: SessionStatus) => {
    _setStatus(s)
    statusRef.current = s
  }

  const [isRedirecting, setIsRedirecting] = useState(false)
  const [isWaitingForPlug, setIsWaitingForPlug] = useState(false)
  const [session, setSession] = useState<LiveSession | null>(null)
  const [finalBill, setFinalBill] = useState<{ kwh: number; cost: number } | null>(null)
  const [elapsedTime, setElapsedTime] = useState("00:00")
  const [batteryLevel, setBatteryLevel] = useState(30)
  const startingBatteryLevelRef = useRef<number>(20 + Math.random() * 20)
  const startTimeRef = useRef<number | null>(null)
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const isMounted = useRef(true)

  useEffect(() => {
    console.log(`[Charging-Debug] Component mounted. ChargerID: ${chargerId}, PaidFromStripe: ${paidFromStripe}, HasPaidThisSession: ${hasPaidThisSession}`);
  }, [chargerId, paidFromStripe, hasPaidThisSession]);

  const handleAuthError = useCallback(() => {
    toast.error("Session expired", { description: "Please sign in again to continue." })

    if (onUnauthorized) {
      onUnauthorized()
    } else {
      onReset()
    }
  }, [onUnauthorized, onReset])

  const checkResponse = useCallback(async (res: Response) => {
    if (res.status === 401 || res.status === 403) {
      const data = await res.clone().json().catch(() => ({}))
      if (data.error?.includes("expired") || res.status === 403) {
        handleAuthError()
        return false
      }
    }
    return true
  }, [handleAuthError])

  const stopPolling = useCallback(() => {
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current)
      pollIntervalRef.current = null
    }
  }, [])

  const startBillingPoll = useCallback((txId: string) => {
    stopPolling()
    setStatus("billing")

    console.log(`[Billing] Starting billing poll for ${txId}...`)
    const maxAttempts = 60 // 5 minutes
    let attempts = 0
    pollIntervalRef.current = setInterval(async () => {
      attempts++
      try {
        const res = await fetch(`/api/session-bill?transactionId=${txId}`, {
          headers: { Authorization: `Bearer ${token}` },
        })
        if (!(await checkResponse(res))) {
          stopPolling()
          return
        }
        if (res.ok) {
          const bill = await res.json()
          if (bill.finalCharged) {
            console.log(`[Billing] SUCCESS: Session ${txId} charged. Total: $${bill.cost}`)
            stopPolling()
            setFinalBill({ kwh: bill.kwh, cost: bill.cost })
            setStatus("completed")
            toast.success("Payment charged!", {
              description: `$${bill.cost.toFixed(2)} for ${bill.kwh.toFixed(2)} kWh`,
            })
            return
          }
        }
      } catch { /* continue polling */ }
      if (attempts >= maxAttempts) {
        stopPolling()
        setStatus("completed")
      }
    }, 5000)
  }, [token, checkResponse, stopPolling])

  const pollSession = useCallback(async (transactionId: string) => {
    if (statusRef.current !== "charging") return
    try {
      const response = await fetch(`/api/charging?transactionId=${transactionId}`, {
        headers: { Authorization: `Bearer ${token}` }
      })
      const data = await response.json()

      if (data.session) {
        const s = data.session as LiveSession
        setSession(s)

        if (!s.isActive && statusRef.current === "charging") {
          console.log(`[Charging] Session ${transactionId} stopped. Transitioning to billing.`)
          startBillingPoll(transactionId)
        }
      }
    } catch {
      // Silent polling failure
    }
  }, [startBillingPoll])

  // Update battery level based on real energy delivery (SoC simulation)
  useEffect(() => {
    if (session?.totalKwh !== undefined && status === "charging") {
      // Assuming 1kWh = ~1.2% charge (typical for a ~80kWh battery)
      const chargeGained = session.totalKwh * 1.2
      setBatteryLevel(Math.min(startingBatteryLevelRef.current + chargeGained, 99))
    }
  }, [session?.totalKwh, status])

  // Update elapsed timer every second
  useEffect(() => {
    if (status !== "charging" || !startTimeRef.current) return

    const timer = setInterval(() => {
      const elapsed = Date.now() - startTimeRef.current!
      const minutes = Math.floor(elapsed / 60000)
      const seconds = Math.floor((elapsed % 60000) / 1000)
      setElapsedTime(
        `${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`
      )
    }, 1000)

    return () => clearInterval(timer)
  }, [status])

  // Cleanup on unmount
  useEffect(() => {
    isMounted.current = true
    return () => {
      isMounted.current = false
      stopPolling()
    }
  }, [stopPolling])

  /** After Stripe payment, webhook already called remoteStart.
   *  Just poll for the transaction ID and move to charging state. */
  const pollForTransaction = useCallback(async () => {
    setStatus("starting")
    let transactionId: string | null = null
    let attempts = 0
    const maxAttempts = 30 // 30 * 3s = 90 seconds (give slow chargers more time)

    console.log(`[Charging] Starting transaction confirmation loop for ${chargerId}...`)

    while (!transactionId && attempts < maxAttempts && isMounted.current) {
      await new Promise((r) => setTimeout(r, 3000))
      if (!isMounted.current) return
      try {
        const statusRes = await fetch(`/api/charging?chargerId=${chargerId}`)
        const statusData = await statusRes.json()

        console.log(`[Charging-Debug] Poll for ${chargerId}:`, statusData);

        // Sync the plug state — if it's no longer waiting, this should be false
        setIsWaitingForPlug(!!statusData.chargerStatus?.isWaitingForPlug)

        if (statusData.chargerStatus?.transactionId !== null && statusData.chargerStatus?.transactionId !== undefined) {
          const txId = String(statusData.chargerStatus.transactionId)
          console.log(`[Charging-Debug] SUCCESS: Found transactionId=${txId}. Transitioning to charging...`)
          transactionId = txId
          setIsWaitingForPlug(false)
        }
      } catch (err) {
        console.error(`[Charging] Poll error on attempt ${attempts + 1}:`, err)
      }
      attempts++
    }

    if (!transactionId) {
      toast.error("Could not confirm charging session. Please check charger status.")
      setStatus("idle")
      return
    }

    startTimeRef.current = Date.now()
    setBatteryLevel(25 + Math.random() * 10)
    setSession({
      transactionId,
      stationId: chargerId,
      isActive: true,
      startTime: new Date().toISOString(),
      totalKwh: 0,
      totalCost: 0,
    })

    // Set a realistic starting battery level
    const startLevel = 20 + Math.random() * 30
    startingBatteryLevelRef.current = startLevel
    setBatteryLevel(startLevel)

    setStatus("charging")
    setIsWaitingForPlug(false)
    toast.success("Charging started!", { description: `Connected to ${chargerId}` })

    if (isMounted.current) {
      pollIntervalRef.current = setInterval(() => pollSession(transactionId!), 5000)
    }
  }, [chargerId, pollSession])

  // Monitor status to notify parent
  useEffect(() => {
    if (status === "completed" || status === "stopped") {
      onFinished(true)
    } else {
      onFinished(false)
    }
  }, [status, onFinished])

  // Auto-start polling if we just returned from Stripe payment redirect
  useEffect(() => {
    if (paidFromStripe) {
      pollForTransaction()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function startCharging() {
    setStatus("starting")
    try {
      // Step 1: Send start command
      const response = await fetch("/api/charging", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone, chargerId, token }),
      })

      const data = await response.json()

      if (!response.ok) {
        toast.error(data.error || "Failed to start charging")
        setStatus("idle")
        return
      }

      toast.success("Charging command sent!", {
        description: "Connecting to charger...",
      })

      // Step 2: Poll for charger status until transaction appears (up to 60s)
      let transactionId: string | null = null
      let attempts = 0
      const maxAttempts = 20

      while (!transactionId && attempts < maxAttempts && isMounted.current) {
        await new Promise((r) => setTimeout(r, 3000))
        if (!isMounted.current) return
        const statusRes = await fetch(`/api/charging?chargerId=${chargerId}`)
        const statusData = await statusRes.json()

        console.log(`[Charging-Debug] Start poll for ${chargerId}:`, statusData);

        // Sync the plug state
        setIsWaitingForPlug(!!statusData.chargerStatus?.isWaitingForPlug)

        if (statusData.chargerStatus?.transactionId) {
          const txId = String(statusData.chargerStatus.transactionId)
          console.log(`[Charging-Debug] SUCCESS: Found transactionId=${txId}`)
          transactionId = txId
          setIsWaitingForPlug(false) // Safety override
        }
        attempts++
      }

      if (!transactionId) {
        toast.error("Could not confirm charging session. Please check charger status.")
        setStatus("idle")
        return
      }

      startTimeRef.current = Date.now()
      setBatteryLevel(25 + Math.random() * 10)
      setSession({
        transactionId,
        stationId: chargerId,
        isActive: true,
        startTime: new Date().toISOString(),
        totalKwh: 0,
        totalCost: 0,
      })

      // Set a realistic starting battery level
      const startLevel = 20 + Math.random() * 30
      startingBatteryLevelRef.current = startLevel
      setBatteryLevel(startLevel)

      setStatus("charging")
      setIsWaitingForPlug(false)

      toast.success("Charging started!", {
        description: `Connected to ${chargerId}`,
      })

      // Start polling for real-time kWh/cost
      if (isMounted.current) {
        pollIntervalRef.current = setInterval(() => {
          pollSession(transactionId!)
        }, 5000)
      }
    } catch {
      toast.error("Failed to start charging session")
      setStatus("idle")
    }
  }

  async function stopCharging() {
    if (!session?.transactionId) return
    setStatus("stopping")

    try {
      const response = await fetch("/api/charging", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chargerId, transactionId: session.transactionId, token }),
      })
      if (!(await checkResponse(response))) return
      const data = await response.json()
      if (!response.ok) {
        toast.error(data.error || "Failed to stop charging")
        setStatus("charging")
        return
      }

      stopPolling()
      const txId = session.transactionId

      // Transition to billing state — poll until final_charged=TRUE
      toast.success("Charging stopped! Processing payment...")
      startBillingPoll(txId)
    } catch {
      toast.error("Failed to stop charging")
      setStatus("charging")
    }
  }

  const pricePerKwh = 0.30

  /** Redirect to Stripe Checkout or start directly if card is saved */
  async function handlePayAndCharge(forceStripe = false) {
    console.log(`[Charging-Debug] handlePayAndCharge called. hasPaid=${hasPaidThisSession}, forceStripe=${forceStripe}`);
    toast.info("Preparing charging session...");
    setIsRedirecting(true)
    try {
      // 1. Try to start directly ONLY if they've already confirmed their card in this login
      // and they haven't explicitly clicked "Use Different Card"
      if (hasPaidThisSession && !forceStripe) {
        const directUrl = `/api/start-direct?chargerId=${encodeURIComponent(chargerId)}&email=${encodeURIComponent(phone)}`
        const directRes = await fetch(directUrl, {
          headers: { Authorization: `Bearer ${token}` },
        })
        if (!(await checkResponse(directRes))) return

        const directData = await directRes.json()

        if (directRes.ok && directData.canDirect) {
          toast.success("Using saved card. Starting charging...")
          setStatus("starting")
          setIsRedirecting(false)
          pollForTransaction() // Start polling for the new transaction immediately
          return
        }
      }

      // 2. Fallback to Stripe Checkout session if no saved card
      const checkoutUrl = `/api/checkout?chargerId=${encodeURIComponent(chargerId)}&email=${encodeURIComponent(phone)}`
      const checkoutRes = await fetch(checkoutUrl, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!(await checkResponse(checkoutRes))) return

      const checkoutData = await checkoutRes.json()

      if (!checkoutRes.ok || !checkoutData.url) {
        toast.error(checkoutData.error || "Could not start payment")
        setIsRedirecting(false)
        return
      }

      window.location.href = checkoutData.url
    } catch (err: any) {
      console.error("Payment start error:", err)
      toast.error("Network error. Please try again.")
      setIsRedirecting(false)
    }
  }

  // Pre-charging: show start button
  if (status === "idle") {
    return (
      <Card>
        <CardHeader className="text-center">
          <div className="mx-auto mb-2 flex h-16 w-16 items-center justify-center rounded-2xl bg-primary/10">
            <BatteryCharging className="h-8 w-8 text-primary" />
          </div>
          <CardTitle className="text-xl">Ready to Charge</CardTitle>
          <CardDescription>
            Your identity is verified. Start charging your vehicle now.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="rounded-lg border border-border/60 bg-secondary/30 p-4">
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">Charger</span>
                <span className="text-sm font-semibold text-foreground">{chargerId}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">Phone</span>
                <span className="text-sm font-medium text-foreground">{phone}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">Rate</span>
                <span className="text-sm font-medium text-foreground">
                  ${pricePerKwh.toFixed(2)}/kWh
                </span>
              </div>
            </div>
          </div>

          <Button
            onClick={() => handlePayAndCharge(false)}
            disabled={isRedirecting}
            size="lg"
            className="w-full text-base font-semibold"
          >
            {isRedirecting ? (
              <><Loader2 className="h-5 w-5 animate-spin" />Connecting...</>
            ) : (
              <><BatteryCharging className="h-5 w-5" />Start Charging</>
            )}
          </Button>

          {!isRedirecting && (
            <button
              onClick={() => handlePayAndCharge(true)}
              className="mt-2 text-xs text-muted-foreground hover:text-primary transition-colors underline underline-offset-4"
            >
              Use Different Card
            </button>
          )}
        </CardContent>
      </Card>
    )
  }

  // Processing off-session payment
  if (status === "billing") {
    return (
      <Card>
        <CardContent className="flex flex-col items-center gap-4 py-12">
          <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-primary/10">
            <Loader2 className="h-8 w-8 text-primary animate-spin" />
          </div>
          <div className="text-center">
            <p className="text-lg font-semibold text-foreground">Processing Payment</p>
            <p className="text-sm text-muted-foreground mt-1">
              Calculating your energy usage and charging your card...
            </p>
          </div>
        </CardContent>
      </Card>
    )
  }

  // Starting / connecting
  if (status === "starting") {
    return (
      <Card>
        <CardContent className="flex flex-col items-center gap-4 py-12">
          <div className="flex flex-col items-center gap-6">
            {isWaitingForPlug ? (
              <PlugAnimation />
            ) : (
              <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-primary/10">
                <Loader2 className="h-8 w-8 text-primary animate-spin" />
              </div>
            )}
          </div>
          <div className="text-center">
            {isWaitingForPlug ? (
              <>
                <p className="text-lg font-bold text-foreground">Please Plug In</p>
                <p className="text-sm text-primary font-medium mt-1">
                  Plug the charger to your vehicle to start
                </p>
              </>
            ) : (
              <>
                <p className="text-lg font-semibold text-foreground">Connecting to Charger</p>
                <p className="text-sm text-muted-foreground mt-1">
                  Sending remote start command to {chargerId}...
                </p>
              </>
            )}
          </div>
        </CardContent>
      </Card>
    )
  }

  // Session completed/stopped
  if (status === "completed" || status === "stopped") {
    const kwh = finalBill?.kwh ?? session?.totalKwh ?? 0
    const cost = finalBill?.cost ?? (kwh * pricePerKwh)

    return (
      <div className="flex flex-col gap-4">
        <Card>
          <CardHeader className="text-center">
            <div className="mx-auto mb-2 flex h-16 w-16 items-center justify-center rounded-2xl bg-primary/10">
              <CheckCircle2 className="h-8 w-8 text-primary" />
            </div>
            <CardTitle className="text-xl">Charging Complete</CardTitle>
            <CardDescription>Your session summary is below</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="rounded-lg border border-border/60 bg-secondary/30 p-4">
              <div className="flex flex-col gap-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">Energy Delivered</span>
                  <span className="text-lg font-bold text-primary">
                    {kwh.toFixed(2)} kWh
                  </span>
                </div>
                <div className="h-px bg-border" />
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">Duration</span>
                  <span className="text-sm font-semibold text-foreground">{elapsedTime}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">Charger</span>
                  <span className="text-sm font-medium text-foreground">{chargerId}</span>
                </div>
                <div className="h-px bg-border" />
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-foreground">Total Cost</span>
                  <span className="text-lg font-bold text-foreground">
                    ${cost.toFixed(2)}
                  </span>
                </div>
              </div>
            </div>

            <Button onClick={onReset} variant="outline" className="w-full">
              <RotateCcw className="h-4 w-4" />
              Start New Session
            </Button>
          </CardContent>
        </Card>
      </div>
    )
  }

  // Active charging session
  const kwh = session?.totalKwh || 0
  const cost = session?.totalCost || kwh * pricePerKwh

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader className="text-center">
          <Badge className="mx-auto mb-2 bg-primary/10 text-primary border-primary/25 px-3 py-1">
            <span className="relative mr-2 flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-75" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-primary" />
            </span>
            Charging in Progress
          </Badge>
          <CardTitle className="text-3xl font-bold text-primary font-mono tabular-nums">
            {kwh.toFixed(2)} kWh
          </CardTitle>
          <CardDescription>Energy delivered to your vehicle</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          {/* Battery visual */}
          {/* <BatteryChargingIndicator level={batteryLevel} /> */}

          {/* Stats grid */}
          <div className="grid grid-cols-3 gap-3">
            <div className="flex flex-col items-center gap-1 rounded-lg border border-border/60 bg-secondary/30 p-3">
              <Zap className="h-4 w-4 text-primary" />
              <span className="text-lg font-bold text-foreground font-mono tabular-nums">
                {chargerId}
              </span>
              <span className="text-[10px] text-muted-foreground uppercase tracking-wide">
                Charger
              </span>
            </div>
            <div className="flex flex-col items-center gap-1 rounded-lg border border-border/60 bg-secondary/30 p-3">
              <Clock className="h-4 w-4 text-primary" />
              <span className="text-lg font-bold text-foreground font-mono tabular-nums">
                {elapsedTime}
              </span>
              <span className="text-[10px] text-muted-foreground uppercase tracking-wide">
                Time
              </span>
            </div>
            <div className="flex flex-col items-center gap-1 rounded-lg border border-border/60 bg-secondary/30 p-3">
              <span className="text-sm font-medium text-primary">$</span>
              <span className="text-lg font-bold text-foreground font-mono tabular-nums">
                {cost.toFixed(2)}
              </span>
              <span className="text-[10px] text-muted-foreground uppercase tracking-wide">
                Cost
              </span>
            </div>
          </div>

          <Button
            onClick={stopCharging}
            disabled={status === "stopping"}
            variant="destructive"
            size="lg"
            className="w-full text-base"
          >
            {status === "stopping" ? (
              <>
                <Loader2 className="h-5 w-5 animate-spin" />
                Stopping...
              </>
            ) : (
              <>
                <CircleStop className="h-5 w-5" />
                Stop Charging
              </>
            )}
          </Button>
        </CardContent>
      </Card>
    </div>
  )
}
