import { useEffect, useState } from "react";
import type { AgeTimelineChart, TimelineEventPoint } from "../types";

function ExpandIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function MinimizeIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M9 3v4a2 2 0 0 1-2 2H3M15 3v4a2 2 0 0 0 2 2h4M9 21v-4a2 2 0 0 0-2-2H3M15 21v-4a2 2 0 0 1 2-2h4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

const CATEGORY_COLORS: Record<string, string> = {
  surgery: "#2563eb",
  medication: "#059669",
  condition: "#ea580c",
  symptom: "#9333ea",
  family_history: "#64748b",
};

const CATEGORY_LABELS: Record<string, string> = {
  surgery: "Surgery",
  medication: "Medication",
  condition: "Condition",
  symptom: "Symptom",
  family_history: "Family history",
};

const DEFAULT_CATEGORY_COLOR = "#64748b";

function niceAxisStep(maxAge: number): number {
  if (maxAge <= 20) return 5;
  if (maxAge <= 60) return 10;
  return 20;
}

function truncate(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars - 1).trimEnd()}\u2026` : text;
}

interface LabelPlacement {
  side: "above" | "below";
  level: number;
}

// Alternates each event's description label above/below the row's baseline,
// bumping to a further level when two labels at the same side/level would
// land too close together on the shared age axis to stay readable.
function layoutLabels(events: TimelineEventPoint[], xScale: (age: number) => number, minGapPx: number): LabelPlacement[] {
  const lastXAtSlot = new Map<string, number>();

  function tryPlace(side: "above" | "below", x: number): number | null {
    for (let level = 0; level < 3; level++) {
      const key = `${side}-${level}`;
      const lastX = lastXAtSlot.get(key);
      if (lastX === undefined || x - lastX >= minGapPx) {
        lastXAtSlot.set(key, x);
        return level;
      }
    }
    return null;
  }

  return events.map((event, index) => {
    const x = xScale(event.age);
    const preferredSide: "above" | "below" = index % 2 === 0 ? "above" : "below";
    let level = tryPlace(preferredSide, x);
    let side = preferredSide;
    if (level === null) {
      side = preferredSide === "above" ? "below" : "above";
      level = tryPlace(side, x);
    }
    if (level === null) {
      side = preferredSide;
      level = 2;
      lastXAtSlot.set(`${side}-2`, x);
    }
    return { side, level };
  });
}

function eventLabelText(event: TimelineEventPoint): string {
  let text = truncate(event.description, 46);
  if (event.stillLiving === false) text += " (deceased)";
  else if (event.stillLiving === true) text += " (living)";
  return text;
}

function TimelineChartSvg({ chart }: { chart: AgeTimelineChart }) {
  const width = 900;
  const marginLeft = 128;
  const marginRight = 24;
  const topPadding = 44;
  const rowHeight = 128;
  const axisHeight = 44;
  const plotWidth = width - marginLeft - marginRight;
  const height = topPadding + chart.rows.length * rowHeight + axisHeight;

  const xScale = (age: number) => marginLeft + (age / (chart.maxAge || 1)) * plotWidth;
  const axisStep = niceAxisStep(chart.maxAge);
  const ticks: number[] = [];
  for (let age = 0; age <= chart.maxAge; age += axisStep) ticks.push(age);

  const usedCategories = [
    ...new Set(chart.rows.flatMap((row) => row.events.map((event) => event.category))),
  ];

  const plotBottom = topPadding + chart.rows.length * rowHeight;

  return (
    <svg viewBox={`0 0 ${width} ${height}`} width="100%" role="img" aria-label={chart.title}>
      {usedCategories.map((category, index) => (
        <g key={category} transform={`translate(${marginLeft + index * 150}, 16)`}>
          <rect width="10" height="10" rx="2" fill={CATEGORY_COLORS[category] || DEFAULT_CATEGORY_COLOR} />
          <text x="16" y="9" fontSize="11" fill="var(--text-muted)">
            {CATEGORY_LABELS[category] || category}
          </text>
        </g>
      ))}

      {ticks.map((age) => (
        <g key={age}>
          <line x1={xScale(age)} y1={topPadding - 8} x2={xScale(age)} y2={plotBottom} stroke="var(--border)" strokeDasharray="2 4" />
          <text x={xScale(age)} y={plotBottom + 18} fontSize="11" textAnchor="middle" fill="var(--text-muted)">
            {age}
          </text>
        </g>
      ))}
      <text x={marginLeft + plotWidth / 2} y={height - 4} fontSize="11" textAnchor="middle" fill="var(--text-muted)">
        Age
      </text>

      {chart.rows.map((row, rowIndex) => {
        const baselineY = topPadding + rowIndex * rowHeight + rowHeight / 2;
        const placements = layoutLabels(row.events, xScale, 84);
        return (
          <g key={row.person}>
            <text x={8} y={baselineY} fontSize="13" fontWeight={600} dominantBaseline="middle" fill="var(--text)">
              {row.label}
            </text>
            <line
              x1={marginLeft}
              y1={baselineY}
              x2={marginLeft + plotWidth}
              y2={baselineY}
              stroke="var(--border)"
              strokeWidth={1.5}
            />
            {row.events.map((event, eventIndex) => {
              const x = xScale(event.age);
              const { side, level } = placements[eventIndex];
              const offset = 28 + level * 30;
              const labelY = side === "above" ? baselineY - offset : baselineY + offset;
              const color = CATEGORY_COLORS[event.category] || DEFAULT_CATEGORY_COLOR;
              const labelText = eventLabelText(event);
              const approxLabelWidth = labelText.length * 5.6 + 10;
              const markerRadius = 10;
              return (
                <g key={`${row.person}-${eventIndex}`}>
                  <title>{`Age ${event.age}: ${event.description}`}</title>
                  <line
                    x1={x}
                    y1={side === "above" ? baselineY - markerRadius : baselineY + markerRadius}
                    x2={x}
                    y2={side === "above" ? labelY + 5 : labelY - 5}
                    stroke={color}
                    strokeWidth={1}
                    opacity={0.5}
                  />
                  <rect
                    x={x - approxLabelWidth / 2}
                    y={labelY - 9}
                    width={approxLabelWidth}
                    height={14}
                    rx={4}
                    fill="var(--surface)"
                    stroke="var(--border)"
                  />
                  <text x={x} y={labelY} fontSize="10.5" textAnchor="middle" dominantBaseline="middle" fill="var(--text)">
                    {labelText}
                  </text>
                  <circle cx={x} cy={baselineY} r={markerRadius} fill={color} stroke="var(--surface)" strokeWidth={1.5} />
                  <text
                    x={x}
                    y={baselineY}
                    fontSize="9.5"
                    textAnchor="middle"
                    dominantBaseline="central"
                    fill="var(--surface)"
                    fontWeight={700}
                  >
                    {event.age}
                  </text>
                </g>
              );
            })}
          </g>
        );
      })}
    </svg>
  );
}

export function TimelineChart({ chart }: { chart: AgeTimelineChart }) {
  const [isExpanded, setIsExpanded] = useState(false);

  useEffect(() => {
    if (!isExpanded) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setIsExpanded(false);
    }
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [isExpanded]);

  const hasData = chart.rows.some((row) => row.events.length > 0);

  return (
    <>
      {isExpanded ? <div className="chart-backdrop" onClick={() => setIsExpanded(false)} /> : null}
      <div className={isExpanded ? "chart-wrapper chart-wrapper-expanded" : "chart-wrapper"}>
        <button
          type="button"
          className="chart-toggle-button"
          onClick={() => setIsExpanded((current) => !current)}
          aria-label={isExpanded ? "Minimize timeline" : "Expand timeline"}
          title={isExpanded ? "Minimize timeline" : "Expand timeline"}
        >
          {isExpanded ? <MinimizeIcon /> : <ExpandIcon />}
        </button>
        {hasData ? (
          <div className="chart-render">
            <TimelineChartSvg chart={chart} />
          </div>
        ) : (
          <div className="transcript-empty">
            No health events with a known age to plot yet -- medications and conditions without a stated age
            still show up in the list below, just not on this timeline.
          </div>
        )}
      </div>
    </>
  );
}
