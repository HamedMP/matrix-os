import { Card, Empty, type ViewProps } from "./views/common";
export type { ViewProps } from "./views/common";
import Finance from "./views/Finance";
import Agenda from "./views/Agenda";
import Board from "./views/Board";
import Travel from "./views/Travel";
import Habits from "./views/Habits";
import Focus from "./views/Focus";
import MeetingBriefs from "./views/MeetingBriefs";
export default function Views(props: ViewProps) {
  switch (props.app.view) {
    case "finance":
      return <Finance {...props} />;
    case "agenda":
      return props.app.id === "meeting-briefs" ? <MeetingBriefs {...props} /> : <Agenda {...props} />;
    case "board":
      return <Board {...props} />;
    case "travel":
      return <Travel {...props} />;
    case "habits":
      return <Habits {...props} />;
    case "focus":
      return <Focus {...props} />;
    default:
      return props.records.length ? (
        <div
          className={`card-grid ${props.app.view === "notes" ? "note-grid" : ""}`}
        >
          {props.records.map((record) => (
            <Card key={record.id} record={record} {...props} />
          ))}
        </div>
      ) : (
        <Empty app={props.app} onAdd={props.onAdd} />
      );
  }
}
