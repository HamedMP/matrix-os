import React, { Component, type ReactNode } from "react";

export class WorkspaceBoundary extends Component<{ children: ReactNode; onBack: () => void }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: Error) { console.error("Utilities workspace failed to open", error); }
  render() {
    if (!this.state.failed) return this.props.children;
    return <div className="utilities-feedback" role="alert"><h2>This workspace couldn’t open</h2><p>Return to Utilities to choose another tool, or reopen the app to try again.</p><button onClick={this.props.onBack}>Back to Utilities</button></div>;
  }
}
