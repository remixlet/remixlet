// BarChart, ported from Tremor (tremor.so) BarChart [v1.0.0] onto this
// project's stack: cx → cn, Tremor's gray-* chrome → the shadcn theme tokens
// (so light/dark follows the .dark class like every other surface), and the
// palette → chart-colors.ts's validated slots. Trimmed relative to upstream:
// no legend slider (drops the @remixicon dependency) and no click-to-filter
// (onValueChange) — the dashboard is a read-only surface; hover tooltips and
// the legend carry the interactivity. The legend itself is rebuilt rather
// than ported: upstream's wrapping inline row above the plot rags into
// uneven rows as series grow, so this renders a fixed-width vertical column
// beside the plot — one truncating row per series, same shape at any count.

import React from "react";
import {
  Bar,
  CartesianGrid,
  BarChart as RechartsBarChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { AxisDomain } from "recharts/types/util/types";

import { cn } from "@/lib/utils";

import {
  AvailableChartColors,
  type AvailableChartColorsKeys,
  constructCategoryColors,
  getColorClassName,
  getYAxisDomain,
} from "./chart-colors.js";

//#region Legend

// The color swatch always renders, even when a favicon is present — the
// swatch is what maps a bar segment to its series, and two remixlets on the
// same site share a favicon.
const LegendItem = ({
  name,
  color,
  icon,
}: {
  name: string;
  color: AvailableChartColorsKeys;
  icon: string | undefined;
}) => (
  <li className="flex min-w-0 items-center gap-2 py-1">
    <span className={cn("size-2 shrink-0 rounded-xs", getColorClassName(color, "bg"))} aria-hidden />
    {icon ? <img src={icon} alt="" className="size-3 shrink-0 rounded-[2px]" aria-hidden /> : null}
    <p className="truncate text-xs text-muted-foreground" title={name}>
      {name}
    </p>
  </li>
);

//#region Tooltip

type PayloadItem = {
  category: string;
  value: number;
  index: string;
  color: AvailableChartColorsKeys;
  icon: string | undefined;
  type?: string;
  payload: ChartDatum;
};

type ChartDatum = Record<string, string | number>;

interface ChartTooltipProps {
  active: boolean | undefined;
  payload: PayloadItem[];
  label: string;
  valueFormatter: (value: number) => string;
}

const ChartTooltip = ({ active, payload, label, valueFormatter }: ChartTooltipProps) => {
  if (active && payload && payload.length) {
    return (
      <div className="rounded-md border border-border bg-popover text-sm text-popover-foreground shadow-md">
        <div className="border-b border-inherit px-4 py-2">
          <p className="font-medium">{label}</p>
        </div>
        <div className="space-y-1 px-4 py-2">
          {payload.map(({ value, category, color, icon }, index) => (
            <div key={`id-${index}`} className="flex items-center justify-between space-x-8">
              <div className="flex items-center space-x-2">
                {icon ? (
                  <img src={icon} alt="" className="size-3 shrink-0 rounded-[2px]" aria-hidden />
                ) : (
                  <span aria-hidden className={cn("size-2 shrink-0 rounded-xs", getColorClassName(color, "bg"))} />
                )}
                <p className="text-right whitespace-nowrap text-muted-foreground">{category}</p>
              </div>
              <p className="text-right font-medium whitespace-nowrap tabular-nums">{valueFormatter(value)}</p>
            </div>
          ))}
        </div>
      </div>
    );
  }
  return null;
};

//#region BarChart

interface BarChartProps extends React.HTMLAttributes<HTMLDivElement> {
  data: ChartDatum[];
  index: string;
  categories: string[];
  /** Favicon data URLs keyed by category, shown in the legend/tooltip in place of the color swatch. */
  icons?: Map<string, string>;
  colors?: AvailableChartColorsKeys[];
  valueFormatter?: (value: number) => string;
  startEndOnly?: boolean;
  showXAxis?: boolean;
  showYAxis?: boolean;
  showGridLines?: boolean;
  yAxisWidth?: number;
  intervalType?: "preserveStartEnd" | "equidistantPreserveStart";
  showTooltip?: boolean;
  showLegend?: boolean;
  autoMinValue?: boolean;
  minValue?: number;
  maxValue?: number;
  allowDecimals?: boolean;
  tickGap?: number;
  barCategoryGap?: string | number;
  type?: "default" | "stacked" | "percent";
}

const BarChart = React.forwardRef<HTMLDivElement, BarChartProps>((props, forwardedRef) => {
  const {
    data = [],
    categories = [],
    index,
    icons = new Map<string, string>(),
    colors = AvailableChartColors,
    valueFormatter = (value: number) => value.toString(),
    startEndOnly = false,
    showXAxis = true,
    showYAxis = true,
    showGridLines = true,
    yAxisWidth = 56,
    intervalType = "equidistantPreserveStart",
    showTooltip = true,
    showLegend = true,
    autoMinValue = false,
    minValue,
    maxValue,
    allowDecimals = true,
    className,
    barCategoryGap,
    tickGap = 5,
    type = "default",
    ...other
  } = props;
  const paddingValue = (!showXAxis && !showYAxis) || (startEndOnly && !showYAxis) ? 0 : 20;
  const categoryColors = constructCategoryColors(categories, colors);
  const yAxisDomain = getYAxisDomain(autoMinValue, minValue, maxValue);
  const stacked = type === "stacked" || type === "percent";

  const valueToPercent = (value: number) => `${(value * 100).toFixed(0)}%`;
  const chartMarginTop = 5;

  return (
    <div
      ref={forwardedRef}
      // Axis tick labels: recharts v3 renders them in a z-index portal layer
      // that is a SIBLING of the axis <g>, so Tremor's fill-muted-foreground
      // on the axis className never reaches them (they fall back to black at
      // 16px in both themes). Styling must come from a wrapper descendant
      // selector instead — CSS `fill` outranks the presentational attribute.
      className={cn(
        "flex h-80 w-full",
        "[&_.recharts-cartesian-axis-tick-value]:fill-muted-foreground [&_.recharts-cartesian-axis-tick-value]:text-xs",
        className,
      )}
      tremor-id="tremor-raw"
      {...other}
    >
      <div className="h-full min-w-0 flex-1">
        <ResponsiveContainer>
          <RechartsBarChart
            data={data}
            margin={{ bottom: undefined, left: undefined, right: undefined, top: chartMarginTop }}
            stackOffset={type === "percent" ? "expand" : undefined}
            barCategoryGap={barCategoryGap}
          >
            {showGridLines ? <CartesianGrid className="stroke-border stroke-1" horizontal vertical={false} /> : null}
            <XAxis
              hide={!showXAxis}
              tick={{ transform: "translate(0, 6)" }}
              fill=""
              stroke=""
              tickLine={false}
              axisLine={false}
              minTickGap={tickGap}
              padding={{ left: paddingValue, right: paddingValue }}
              dataKey={index}
              interval={startEndOnly ? "preserveStartEnd" : intervalType}
              ticks={
                startEndOnly
                  ? [data[0]?.[index], data[data.length - 1]?.[index]].filter(
                      (tick): tick is string | number => tick !== undefined,
                    )
                  : undefined
              }
            />
            <YAxis
              width={yAxisWidth}
              hide={!showYAxis}
              axisLine={false}
              tickLine={false}
              fill=""
              stroke=""
              tick={{ transform: "translate(-3, 0)" }}
              type="number"
              // SAFETY: getYAxisDomain produces Recharts' numeric domain tuple or boundary values.
              domain={yAxisDomain as AxisDomain}
              tickFormatter={type === "percent" ? valueToPercent : valueFormatter}
              allowDecimals={allowDecimals}
            />
            <Tooltip
              wrapperStyle={{ outline: "none" }}
              isAnimationActive
              animationDuration={100}
              cursor={{ fill: "currentColor", opacity: "0.1" }}
              offset={20}
              position={{ y: chartMarginTop, x: undefined }}
              content={({ active, payload, label }) => {
                const cleanPayload: PayloadItem[] = payload
                  ? payload.map((item: any) => ({
                      category: item.dataKey,
                      value: item.value,
                      index: item.payload[index],
                      // SAFETY: categoryColors is constructed from the categories that supply each payload dataKey.
                      color: categoryColors.get(item.dataKey) as AvailableChartColorsKeys,
                      icon: icons.get(item.dataKey),
                      type: item.type,
                      payload: item.payload,
                    }))
                  : [];
                return showTooltip && active ? (
                  <ChartTooltip
                    active={active}
                    payload={cleanPayload}
                    label={String(label ?? "")}
                    valueFormatter={valueFormatter}
                  />
                ) : null;
              }}
            />
            {categories.map((category) => (
              <Bar
                // SAFETY: category is one of the keys used to construct categoryColors immediately above.
                className={getColorClassName(categoryColors.get(category) as AvailableChartColorsKeys, "fill")}
                key={category}
                name={category}
                type="linear"
                dataKey={category}
                stackId={stacked ? "stack" : undefined}
                isAnimationActive={false}
                fill=""
              />
            ))}
          </RechartsBarChart>
        </ResponsiveContainer>
      </div>
      {showLegend ? (
        <ol className="flex w-44 shrink-0 flex-col overflow-y-auto pt-1 pl-4">
          {categories.map((category) => (
            <LegendItem
              key={category}
              name={category}
              // SAFETY: category is one of the keys used to construct categoryColors immediately above.
              color={categoryColors.get(category) as AvailableChartColorsKeys}
              icon={icons.get(category)}
            />
          ))}
        </ol>
      ) : null}
    </div>
  );
});

BarChart.displayName = "BarChart";

export { BarChart, type BarChartProps };
