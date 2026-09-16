"use client"

import { useState } from "react"
import { Check, ChevronsUpDown, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Card } from "@/components/ui/card"
import { cn } from "@/lib/utils"

/**
 * The filter bar both Customer quality reports use.
 *
 * ONE COMPONENT, NOT TWO COPIES. The reports read the same source object under
 * the same heading and are meant to reconcile against each other; a filter that
 * exists on one and not the other, or defaults differently, produces two answers
 * to what a reader takes to be one question. The server-side halves of these
 * filters are shared for the same reason in lib/quality-mix-sql.ts.
 */

export type QualityFilterState = {
  startDate: string
  endDate: string
  products: string[]
  brand: string
  bands: string[]
}

function MultiPicker({
  label,
  allLabel,
  noun,
  options,
  selected,
  onChange,
  width = "w-[300px]",
}: {
  label: string
  allLabel: string
  noun: string
  options: string[]
  selected: string[]
  onChange: (next: string[]) => void
  width?: string
}) {
  const [open, setOpen] = useState(false)
  return (
    <div className="min-w-[220px]">
      <Label className="mb-1.5 block text-xs text-muted-foreground">{label}</Label>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button variant="outline" className="w-full justify-between font-normal">
            <span className="truncate">
              {selected.length === 0
                ? allLabel
                : selected.length === 1
                ? selected[0]
                : `${selected.length} ${noun}`}
            </span>
            <ChevronsUpDown className="ml-2 h-4 w-4 flex-shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className={cn(width, "p-0")} align="start">
          <Command>
            <CommandInput placeholder={`Search ${noun}...`} />
            <CommandList>
              <CommandEmpty>Nothing found.</CommandEmpty>
              <CommandGroup>
                <CommandItem onSelect={() => onChange([])}>
                  <Check
                    className={cn("mr-2 h-4 w-4", selected.length === 0 ? "opacity-100" : "opacity-0")}
                  />
                  {allLabel}
                </CommandItem>
                {options.map((o) => (
                  <CommandItem
                    key={o}
                    value={o}
                    onSelect={() =>
                      onChange(
                        selected.includes(o) ? selected.filter((x) => x !== o) : [...selected, o]
                      )
                    }
                  >
                    <Check
                      className={cn(
                        "mr-2 h-4 w-4",
                        selected.includes(o) ? "opacity-100" : "opacity-0"
                      )}
                    />
                    <span className="truncate">{o}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  )
}

export function QualityFilterBar({
  value,
  onChange,
  productOptions,
  brandOptions,
  bandOptions,
  onRun,
  loading,
  dirty,
  presetDays = [90, 180, 365],
  note,
}: {
  value: QualityFilterState
  onChange: (next: QualityFilterState) => void
  productOptions: string[]
  brandOptions: string[]
  bandOptions: string[]
  onRun: () => void
  loading: boolean
  /** Filters edited since the last run — the figures on screen are stale. */
  dirty: boolean
  presetDays?: number[]
  note?: React.ReactNode
}) {
  const set = (patch: Partial<QualityFilterState>) => onChange({ ...value, ...patch })
  const isoDaysAgo = (days: number) => {
    const d = new Date()
    d.setDate(d.getDate() - days)
    return d.toISOString().slice(0, 10)
  }

  return (
    <Card padding="dense">
      <div className="flex flex-wrap items-end gap-4">
        <div>
          <Label className="mb-1.5 block text-xs text-muted-foreground">Sales from</Label>
          <Input
            type="date"
            value={value.startDate}
            max={value.endDate}
            onChange={(e) => set({ startDate: e.target.value })}
            className="w-[150px]"
          />
        </div>
        <div>
          <Label className="mb-1.5 block text-xs text-muted-foreground">Sales to</Label>
          <Input
            type="date"
            value={value.endDate}
            min={value.startDate}
            onChange={(e) => set({ endDate: e.target.value })}
            className="w-[150px]"
          />
        </div>
        <MultiPicker
          label="Product"
          allLabel="All products"
          noun="products"
          options={productOptions}
          selected={value.products}
          onChange={(products) => set({ products })}
          width="w-[300px]"
        />
        <div className="min-w-[200px]">
          <Label className="mb-1.5 block text-xs text-muted-foreground">Brand</Label>
          <Select
            value={value.brand || "__all"}
            onValueChange={(v) => set({ brand: v === "__all" ? "" : v })}
          >
            <SelectTrigger>
              <SelectValue placeholder="All brands" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all">All brands</SelectItem>
              {brandOptions.map((b) => (
                <SelectItem key={b} value={b}>
                  {b}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <MultiPicker
          label="Score band"
          allLabel="All bands"
          noun="bands"
          options={bandOptions}
          selected={value.bands}
          onChange={(bands) => set({ bands })}
          width="w-[280px]"
        />
        <Button onClick={onRun} disabled={loading} className={cn(dirty && "ring-2 ring-primary/60")}>
          {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Run report
        </Button>
      </div>

      {dirty && (
        <p className="mt-3 text-xs text-amber-200">
          Filters changed — the figures below are still from the previous run. Click Run report to
          apply.
        </p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-4">
        {presetDays.map((d) => (
          <button
            key={d}
            type="button"
            className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            onClick={() => set({ startDate: isoDaysAgo(d), endDate: isoDaysAgo(0) })}
          >
            Last {d === 365 ? "12 months" : `${Math.round(d / 30)} months`}
          </button>
        ))}
        {note}
      </div>
    </Card>
  )
}
