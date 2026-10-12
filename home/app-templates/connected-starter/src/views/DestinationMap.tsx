import type { OwnerRecord } from "../types";
// Exact city-name matches only: free-form destinations never become guessed coordinates.
const cities: Record<string, readonly [number, number]> = {
  copenhagen: [55.6761, 12.5683], lisbon: [38.7223, -9.1393], kyoto: [35.0116, 135.7681],
  tokyo: [35.6762, 139.6503], london: [51.5074, -0.1278], paris: [48.8566, 2.3522],
  stockholm: [59.3293, 18.0686], berlin: [52.52, 13.405], rome: [41.9028, 12.4964],
  barcelona: [41.3874, 2.1686], "new york": [40.7128, -74.006], singapore: [1.3521, 103.8198],
  sydney: [-33.8688, 151.2093], dubai: [25.2048, 55.2708], amsterdam: [52.3676, 4.9041],
};
export function cityLocation(destination: string) {
  const key = destination.trim().toLowerCase();
  return Object.hasOwn(cities, key) ? cities[key] : undefined;
}
export default function DestinationMap({ records, selected, onSelect }: { records: OwnerRecord[]; selected: OwnerRecord; onSelect: (id: string) => void }) {
  return <div className="world-map">
    <svg viewBox="0 0 900 450" aria-hidden="true" className="world-shapes">
      <g className="map-grid">{[75, 150, 225, 300, 375].map(y => <path key={y} d={`M0 ${y}H900`} />)}{[150, 300, 450, 600, 750].map(x => <path key={x} d={`M${x} 0V450`} />)}</g>
      <g className="map-land"><path d="M68 95 112 61 160 58 204 80 238 75 275 104 258 139 218 145 213 178 182 205 164 173 134 158 112 129 79 120Z"/><path d="M219 202 249 214 276 254 266 305 239 353 222 380 213 336 201 297 200 248Z"/><path d="M290 39 326 27 361 51 341 86 310 81Z"/><path d="M438 120 460 90 484 102 497 126 479 141 446 142Z"/><path d="M436 154 477 145 513 175 525 218 493 266 470 290 453 249 430 223 415 185Z"/><path d="M483 84 528 56 609 61 681 48 764 67 825 108 783 128 755 159 721 171 699 206 666 223 640 181 609 161 580 195 554 169 521 153 501 124Z"/><path d="M704 285 750 270 786 292 807 330 764 356 723 339 701 311Z"/><path d="M793 358 810 343 814 369 800 390Z"/></g>
    </svg>
    {records.map(record => {
      const name = String(record.fields.destination ?? ""), location = cityLocation(name);
      if (!location) return null;
      const [latitude, longitude] = location;
      return <button key={record.id} className="map-pin" aria-label={`Map: ${name}`} aria-pressed={selected.id === record.id} onClick={() => onSelect(record.id)} style={{ left: `${(longitude + 180) / 3.6}%`, top: `${(90 - latitude) / 1.8}%` }}><span aria-hidden="true" /><small>{name}</small></button>;
    })}
  </div>;
}
