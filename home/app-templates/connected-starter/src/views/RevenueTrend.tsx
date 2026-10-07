export default function RevenueTrend({ points, max }: { points: [string, number][]; max: number }) {
  const x = (index: number) => points.length === 1 ? 300 : 20 + index * 560 / (points.length - 1);
  const y = (value: number) => 145 - value / max * 125;
  return (
    <svg className="trend-line" viewBox="0 0 600 160" preserveAspectRatio="none" aria-hidden="true">
      <polyline
        points={points.map(([, value], index) => `${x(index)},${y(value)}`).join(" ")}
        fill="none" stroke="currentColor" strokeWidth="3"
      />
      {points.map(([label, value], index) => (
        <circle key={label} cx={x(index)} cy={y(value)} r="4" fill="currentColor" />
      ))}
    </svg>
  );
}
