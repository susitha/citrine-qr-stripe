"use client"

import { cn } from "@/lib/utils"
import { Check } from "lucide-react"

interface StepIndicatorProps {
  steps: string[]
  currentStep: number
}

export function StepIndicator({ steps, currentStep }: StepIndicatorProps) {
  return (
    <nav aria-label="Progress" className="flex items-center justify-center gap-2">
      {steps.map((label, index) => {
        const isComplete = index < currentStep
        const isCurrent = index === currentStep

        return (
          <div key={label} className="flex items-center gap-2">
            <div className="flex flex-col items-center gap-1.5">
              <div
                className={cn(
                  "flex h-8 w-8 items-center justify-center rounded-full border-2 text-xs font-semibold transition-all",
                  isComplete &&
                    "border-primary bg-primary text-primary-foreground",
                  isCurrent &&
                    "border-primary bg-background text-primary",
                  !isComplete &&
                    !isCurrent &&
                    "border-muted-foreground/30 bg-background text-muted-foreground/50"
                )}
                aria-current={isCurrent ? "step" : undefined}
              >
                {isComplete ? (
                  <Check className="h-4 w-4" aria-hidden="true" />
                ) : (
                  index + 1
                )}
              </div>
              <span
                className={cn(
                  "text-[10px] font-medium leading-none",
                  isCurrent ? "text-primary" : "text-muted-foreground"
                )}
              >
                {label}
              </span>
            </div>
            {index < steps.length - 1 && (
              <div
                className={cn(
                  "mb-4 h-0.5 w-8 rounded-full transition-all",
                  isComplete ? "bg-primary" : "bg-muted-foreground/20"
                )}
                aria-hidden="true"
              />
            )}
          </div>
        )
      })}
    </nav>
  )
}
