/** Independently worded regression input; contains no customer transcript data. */
export const longClaudeQuestion = {
  question: "Which review workflow should the sample project use?",
  header: "Review workflow",
  options: [
    { label: "Review in the app", description: "Keep the review inside the sample application. The complete explanation should remain readable before you choose this option, including its setup steps, expected result and recovery choices. You can compare the workflow with the alternatives without switching screens or losing the current task. Your selection goes back to the waiting process. This is the full first explanation." },
    { label: "Review in a separate window", description: "Open the review in a separate window so the original task stays visible. Preserve this explanation while you compare the choices and send the selected label back to the same waiting process. The original Chat remains available and preserves your draft until you safely finish. No second run is created for this answer. This is the full second explanation." },
  ],
};
