// Chart color utilities, ported from Tremor (tremor.so) chartColors [v0.1.0].
// Tremor's raw Tailwind palette entries are swapped for the --chart-N custom
// properties defined in src/panel/styles.css: those hexes are a validated
// colorblind-safe categorical palette with distinct light/dark steps, and the
// slot ORDER is part of that validation — assign series to slots in order,
// never shuffled. "muted" is not a series slot: it is the fold color for an
// "Other" remainder bucket, so an overflow category never impersonates a
// series.

export type ColorUtility = "bg" | "stroke" | "fill" | "text";

export const chartColors = {
  chart1: { bg: "bg-(--chart-1)", stroke: "stroke-(--chart-1)", fill: "fill-(--chart-1)", text: "text-(--chart-1)" },
  chart2: { bg: "bg-(--chart-2)", stroke: "stroke-(--chart-2)", fill: "fill-(--chart-2)", text: "text-(--chart-2)" },
  chart3: { bg: "bg-(--chart-3)", stroke: "stroke-(--chart-3)", fill: "fill-(--chart-3)", text: "text-(--chart-3)" },
  chart4: { bg: "bg-(--chart-4)", stroke: "stroke-(--chart-4)", fill: "fill-(--chart-4)", text: "text-(--chart-4)" },
  chart5: { bg: "bg-(--chart-5)", stroke: "stroke-(--chart-5)", fill: "fill-(--chart-5)", text: "text-(--chart-5)" },
  chart6: { bg: "bg-(--chart-6)", stroke: "stroke-(--chart-6)", fill: "fill-(--chart-6)", text: "text-(--chart-6)" },
  chart7: { bg: "bg-(--chart-7)", stroke: "stroke-(--chart-7)", fill: "fill-(--chart-7)", text: "text-(--chart-7)" },
  chart8: { bg: "bg-(--chart-8)", stroke: "stroke-(--chart-8)", fill: "fill-(--chart-8)", text: "text-(--chart-8)" },
  muted: {
    bg: "bg-muted-foreground/50",
    stroke: "stroke-muted-foreground/50",
    fill: "fill-muted-foreground/50",
    text: "text-muted-foreground",
  },
  // Not a series slot either: the brand accent, for single-series charts that
  // should read as the product (a card's own sparkline) rather than as one
  // series among several. Never mix it into a categorical chart — it hasn't
  // been validated against the slots above.
  accent: { bg: "bg-(--accent)", stroke: "stroke-(--accent)", fill: "fill-(--accent)", text: "text-(--accent)" },
} as const satisfies { [color: string]: { [key in ColorUtility]: string } };

export type AvailableChartColorsKeys = keyof typeof chartColors;

export const AvailableChartColors: AvailableChartColorsKeys[] =
  // SAFETY: chartColors is the object passed to Object.keys, so every returned key is a chart color key.
  Object.keys(chartColors) as Array<AvailableChartColorsKeys>;

export const constructCategoryColors = (
  categories: string[],
  colors: AvailableChartColorsKeys[],
): Map<string, AvailableChartColorsKeys> => {
  const categoryColors = new Map<string, AvailableChartColorsKeys>();
  categories.forEach((category, index) => {
    categoryColors.set(category, colors[index % colors.length]!);
  });
  return categoryColors;
};

export const getColorClassName = (color: AvailableChartColorsKeys, type: ColorUtility): string => {
  return chartColors[color]?.[type] ?? chartColors.muted[type];
};

export const getYAxisDomain = (
  autoMinValue: boolean,
  minValue: number | undefined,
  maxValue: number | undefined,
): readonly [number | "auto", number | "auto"] => {
  const minDomain = autoMinValue ? "auto" : (minValue ?? 0);
  const maxDomain = maxValue ?? "auto";
  return [minDomain, maxDomain];
};
