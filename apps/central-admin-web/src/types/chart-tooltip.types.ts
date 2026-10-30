/**
 * Presentation-only props for a Recharts tooltip. Values are typed at the
 * graph boundary rather than passed through an unrestricted any parameter.
 */
export interface AdminChartTooltipEntry {
  dataKey?: string | number;
  name?: string | number;
  value: string | number;
  color?: string;
  fill?: string;
  payload?: Record<string, unknown>;
}
export interface AdminChartTooltipProps {
  active?: boolean;
  payload?: ReadonlyArray<AdminChartTooltipEntry>;
  label?: string | number;
}
