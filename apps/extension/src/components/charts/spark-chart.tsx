// SparkAreaChart, ported from Tremor (tremor.so) Spark Chart [v1.0.0]:
// cx → cn, palette → chart-colors.ts's validated slots. Only the area
// variant is ported — it is the dashboard's per-remixlet trend cell; the
// line/bar variants come over if and when something needs them.

import React from "react";
import { Area, AreaChart as RechartsAreaChart, ResponsiveContainer, XAxis, YAxis } from "recharts";
import type { AxisDomain } from "recharts/types/util/types";

import { cn } from "@/lib/utils";

import {
  AvailableChartColors,
  type AvailableChartColorsKeys,
  constructCategoryColors,
  getColorClassName,
  getYAxisDomain,
} from "./chart-colors.js";

interface SparkAreaChartProps extends React.HTMLAttributes<HTMLDivElement> {
  data: SparkDataPoint[];
  categories: string[];
  index: string;
  colors?: AvailableChartColorsKeys[];
  autoMinValue?: boolean;
  minValue?: number;
  maxValue?: number;
  connectNulls?: boolean;
  type?: "default" | "stacked" | "percent";
  fill?: "gradient" | "solid" | "none";
}

interface SparkDataPoint {
  [field: string]: string | number | null | undefined;
}

const SparkAreaChart = React.forwardRef<HTMLDivElement, SparkAreaChartProps>((props, forwardedRef) => {
  const {
    data = [],
    categories = [],
    index,
    colors = AvailableChartColors,
    autoMinValue = false,
    minValue,
    maxValue,
    connectNulls = false,
    type = "default",
    className,
    fill = "gradient",
    ...other
  } = props;

  const categoryColors = constructCategoryColors(categories, colors);
  const yAxisDomain: AxisDomain = getYAxisDomain(autoMinValue, minValue, maxValue);
  const stacked = type === "stacked" || type === "percent";
  const areaId = React.useId();

  const getFillContent = (fillType: SparkAreaChartProps["fill"]) => {
    switch (fillType) {
      case "none":
        return <stop stopColor="currentColor" stopOpacity={0} />;
      case "gradient":
        return (
          <>
            <stop offset="5%" stopColor="currentColor" stopOpacity={0.4} />
            <stop offset="95%" stopColor="currentColor" stopOpacity={0} />
          </>
        );
      default:
        return <stop stopColor="currentColor" stopOpacity={0.3} />;
    }
  };

  return (
    <div ref={forwardedRef} className={cn("h-12 w-28", className)} tremor-id="tremor-raw" {...other}>
      <ResponsiveContainer>
        <RechartsAreaChart
          data={data}
          margin={{ bottom: 1, left: 1, right: 1, top: 1 }}
          stackOffset={type === "percent" ? "expand" : undefined}
        >
          <XAxis hide dataKey={index} />
          <YAxis hide domain={yAxisDomain} />
          {categories.map((category) => {
            const categoryId = `${areaId}-${category.replace(/[^a-zA-Z0-9]/g, "")}`;
            return (
              <React.Fragment key={category}>
                <defs>
                  <linearGradient
                    key={category}
                    className={getColorClassName(categoryColors.get(category)!, "text")}
                    id={categoryId}
                    x1="0"
                    y1="0"
                    x2="0"
                    y2="1"
                  >
                    {getFillContent(fill)}
                  </linearGradient>
                </defs>
                <Area
                  className={getColorClassName(categoryColors.get(category)!, "stroke")}
                  dot={false}
                  strokeOpacity={1}
                  name={category}
                  type="linear"
                  dataKey={category}
                  stroke=""
                  strokeWidth={2}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                  isAnimationActive={false}
                  connectNulls={connectNulls}
                  stackId={stacked ? "stack" : undefined}
                  fill={`url(#${categoryId})`}
                />
              </React.Fragment>
            );
          })}
        </RechartsAreaChart>
      </ResponsiveContainer>
    </div>
  );
});

SparkAreaChart.displayName = "SparkAreaChart";

export { SparkAreaChart, type SparkAreaChartProps };
