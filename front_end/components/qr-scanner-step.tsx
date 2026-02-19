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
import { ScanLine, Zap, Hash } from "lucide-react"

interface QrScannerStepProps {
  onChargerFound: (chargerId: string) => void
}

export function QrScannerStep({ onChargerFound }: QrScannerStepProps) {
  const [manualId, setManualId] = useState("")
  const [isScanning, setIsScanning] = useState(false)
  const [error, setError] = useState("")

  function handleScan() {
    setIsScanning(true)
    setError("")
    // Simulate QR code scanning (tap to scan UI)
    // In a real device, this would open the camera via a library like html5-qrcode
    setTimeout(() => {
      setIsScanning(false)
      // For demo: generate a charger ID to simulate a scanned QR
      const demoId = `CHG-${Math.floor(100 + Math.random() * 900)}`
      onChargerFound(demoId)
    }, 2000)
  }

  function handleManualEntry() {
    setError("")
    const id = manualId.trim().toUpperCase()
    if (!id) {
      setError("Please enter a charger ID")
      return
    }
    onChargerFound(id)
  }

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader className="text-center">
          <div className="mx-auto mb-2 flex h-16 w-16 items-center justify-center rounded-2xl bg-primary/10">
            <Zap className="h-8 w-8 text-primary" />
          </div>
          <CardTitle className="text-xl">Scan Charger QR Code</CardTitle>
          <CardDescription>
            Point your camera at the QR code on the EV charger, or enter the charger ID manually
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <button
            onClick={handleScan}
            disabled={isScanning}
            className="group relative mx-auto flex h-52 w-52 cursor-pointer items-center justify-center overflow-hidden rounded-2xl border-2 border-dashed border-primary/25 bg-primary/5 transition-all hover:border-primary/50 hover:bg-primary/10 disabled:cursor-wait disabled:opacity-70"
            aria-label="Tap to scan QR code"
          >
            {isScanning ? (
              <div className="flex flex-col items-center gap-3">
                <div className="relative h-16 w-16">
                  <ScanLine className="h-16 w-16 animate-pulse text-primary" />
                </div>
                <span className="text-sm font-medium text-primary">
                  Scanning...
                </span>
              </div>
            ) : (
              <div className="flex flex-col items-center gap-3">
                <ScanLine className="h-12 w-12 text-primary/60 transition-colors group-hover:text-primary" />
                <span className="text-sm font-medium text-muted-foreground">
                  Tap to scan
                </span>
              </div>
            )}
          </button>
        </CardContent>
      </Card>

      <div className="flex items-center gap-4">
        <div className="h-px flex-1 bg-border" />
        <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
          or enter manually
        </span>
        <div className="h-px flex-1 bg-border" />
      </div>

      <Card>
        <CardContent className="pt-6">
          <div className="flex flex-col gap-3">
            <label
              htmlFor="charger-id"
              className="text-sm font-medium text-foreground"
            >
              Charger ID
            </label>
            <div className="flex gap-2">
              <div className="relative flex-1">
                <Hash className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  id="charger-id"
                  placeholder="e.g. CHG-001 or CP001"
                  value={manualId}
                  onChange={(e) => {
                    setManualId(e.target.value)
                    setError("")
                  }}
                  onKeyDown={(e) => e.key === "Enter" && handleManualEntry()}
                  className="pl-9"
                />
              </div>
              <Button onClick={handleManualEntry}>Connect</Button>
            </div>
            {error && (
              <p className="text-sm text-destructive" role="alert">
                {error}
              </p>
            )}
          </div>
        </CardContent>
      </Card>

      <div className="rounded-lg border border-primary/15 bg-primary/5 p-4">
        <p className="text-xs text-muted-foreground leading-relaxed">
          <span className="font-semibold text-foreground">Tip:</span>{" "}
          The charger ID is printed on the charger and encoded in the QR code. You can also scan the QR code from your charger station app.
        </p>
      </div>
    </div>
  )
}
