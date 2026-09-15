import { RecipeRabbit, type RabbitState } from "./RecipeRabbit.js";

export function AgentAvatar({ id, name, size = "large", state = "idle", category }: {
  id: string;
  name: string;
  size?: "small" | "large";
  state?: RabbitState;
  category?: string;
}) {
  return <RecipeRabbit id={id} name={name} size={size} state={state} category={category} avatar />;
}
