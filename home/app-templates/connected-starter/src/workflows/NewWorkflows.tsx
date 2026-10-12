import type { ViewProps } from "../views/common";
import { Workout, Runway, Meals } from "./TrainingMoneyMeals";
import { Applications, Study, Journal } from "./ApplicationsStudyJournal";
import ChessCoach from "./ChessCoach";
import "./workflows.css";

export default function NewWorkflows(props: ViewProps) {
  switch (props.app.id) {
    case "workout-coach": return <Workout {...props} />;
    case "paycheck-runway": return <Runway {...props} />;
    case "meal-planner": return <Meals {...props} />;
    case "job-search": return <Applications {...props} />;
    case "study-notes": return <Study {...props} />;
    case "journal-memory": return <Journal {...props} />;
    case "chess-coach": return <ChessCoach {...props} />;
    default: return null;
  }
}
